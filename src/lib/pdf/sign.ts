/**
 * Signing orchestration.
 *
 * Every signature is written as an **incremental update** so that any signature
 * already present in the document stays valid (its `/ByteRange` is untouched).
 * Signing N placements therefore produces N appended revisions - i.e. a
 * signature chain, exactly like repeatedly signing a document in Acrobat.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFInvalidObject,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRef,
  PDFString,
} from '@cantoo/pdf-lib';
import {
  SignError,
  type SignOptions,
  type SignResult,
  type SignaturePlacement,
  type TimestampSettings,
} from '@/types';
import { createDetachedCms, estimateCmsSize } from '../crypto/cms';
import type { LoadedP12 } from '../crypto/p12';
import type { TimestampConfig } from '../crypto/timestamp';
import { buildAppearance, loadAppearanceFont, pdfSafeText } from './appearance';
import { BYTE_RANGE_PLACEHOLDER, insertCms, prepareSignaturePlaceholder } from './byteRange';
import { applyDocumentDates } from './documentDates';
import { readCertification } from './inspect';
import { stampSingle } from './stamp';

export interface SignPdfRequest {
  pdfBytes: Uint8Array;
  /** Every placement carries the signer that should produce it. */
  placements: SignaturePlacement[];
  /** Unlocked certificates, keyed by `StoredCertificate.id`. */
  certificates: ReadonlyMap<string, LoadedP12>;
  /** Dummy signer display names, keyed by `DummySigner.id`. */
  dummyNames: ReadonlyMap<string, string>;
  /** Appearance name per signer id; falls back to the certificate's own common name. */
  certificateNames?: ReadonlyMap<string, string>;
  options: SignOptions;
  /** Overrides the auto-generated field name (single placement only). */
  fieldName?: string;
  /** Capacity of the `/Contents` slot, in bytes. */
  signatureLength?: number;
  signingTime?: Date;
  /** RFC 3161 authority applied to every real signature. */
  timestamp?: TimestampSettings | null;
  /** When set, the first real-signature revision rewrites the Info/XMP dates. */
  documentDates?: Date | null;
  /** Injectable `fetch`, forwarded to the timestamp client. */
  fetchImpl?: typeof fetch;
}

interface SignSingleInput {
  pdfBytes: Uint8Array;
  certificate: LoadedP12;
  placement: SignaturePlacement;
  signingTime: Date;
  options: SignOptions;
  finalize: boolean;
  /** Overrides the appearance name; falls back to the certificate's common name. */
  appearanceName?: string;
  fieldName?: string;
  signatureLength?: number;
  /** RFC 3161 authority for this signature, when timestamping is enabled. */
  timestamp: TimestampConfig | null;
  /** When set, rewrite the Info/XMP dates in this revision. */
  documentDates: Date | null;
}

interface SignSingleResult {
  pdfBytes: Uint8Array;
  fieldName: string;
  certified: boolean;
  documentDatesChanged: boolean;
  warnings: string[];
}

type SignatureDictionary = {
  Type: string;
  Filter: string;
  SubFilter: string;
  ByteRange: PDFArray;
  Contents: PDFHexString;
  M: PDFString;
  Name: PDFString;
  Prop_Build: { App: { Name: string } };
  Reason?: PDFString;
  Location?: PDFString;
  ContactInfo?: PDFString;
  Reference?: {
    Type: string;
    TransformMethod: string;
    TransformParams: { Type: string; V: string; P: number };
    DigestMethod: string;
  }[];
};

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                    */
/* -------------------------------------------------------------------------- */

/** Load a PDF so a revision can be appended to it. */
export async function loadForIncrementalUpdate(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, {
      forIncrementalUpdate: true,
      updateMetadata: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt/i.test(message)) {
      throw new SignError('encrypted-pdf', 'Encrypted PDFs cannot be signed.');
    }
    throw new SignError('invalid-pdf', `Could not read the PDF: ${message}`);
  }
}

/** Names of all existing signature fields, including nested ones. */
export function existingSignatureFieldNames(doc: PDFDocument): string[] {
  const names: string[] = [];
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acroForm) return names;
  const fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return names;

  const queue = [...fields.asArray()];
  const seen = new Set<number>();

  while (queue.length > 0) {
    const entry = queue.shift();
    const ref = entry instanceof PDFRef ? entry : undefined;
    if (ref) {
      if (seen.has(ref.objectNumber)) continue;
      seen.add(ref.objectNumber);
    }
    const dict = ref ? doc.context.lookup(ref) : entry;
    if (!(dict instanceof PDFDict)) continue;

    const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) queue.push(...kids.asArray());

    if (dict.get(PDFName.of('FT'))?.toString() === '/Sig') {
      const title = dict.get(PDFName.of('T'));
      if (title instanceof PDFString) names.push(title.decodeText());
    }
  }
  return names;
}

function uniqueFieldName(existing: string[]): string {
  const taken = new Set(existing);
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `Signature${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `Signature${Date.now()}`;
}

/** Attach the widget to the page's `/Annots`. */
export function attachToPage(doc: PDFDocument, page: PDFPage, widgetRef: PDFRef): void {
  let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) {
    annots = doc.context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(widgetRef);
}

/* -------------------------------------------------------------------------- */
/*                               Single signature                              */
/* -------------------------------------------------------------------------- */

async function signSingle(input: SignSingleInput): Promise<SignSingleResult> {
  const warnings: string[] = [];
  const doc = await loadForIncrementalUpdate(input.pdfBytes);

  let documentDatesChanged = false;
  if (input.documentDates) {
    if (readCertification(doc)) {
      warnings.push(
        'This document is certified, so its creation/modification dates were left unchanged to protect the certification.',
      );
    } else {
      const dates = await applyDocumentDates(doc, input.documentDates);
      warnings.push(...dates.warnings);
      documentDatesChanged = true;
    }
  }

  const pages = doc.getPages();
  const placement = input.placement;
  if (placement.pageIndex < 0 || placement.pageIndex >= pages.length) {
    throw new SignError('invalid-pdf', `Page ${placement.pageIndex + 1} does not exist.`);
  }
  const page = pages[placement.pageIndex];

  const font = await loadAppearanceFont(doc);
  const signerName = input.appearanceName ?? input.certificate.info.commonName;

  const appearance = await buildAppearance({
    doc,
    font,
    placement,
    signerName,
    date: input.signingTime,
  });

  const existingNames = existingSignatureFieldNames(doc);
  const fieldName = input.fieldName ?? uniqueFieldName(existingNames);
  const canCertify = existingNames.length === 0;

  if (input.finalize && !canCertify) {
    warnings.push(
      'The document already contains a signature, so this signature could not be a certification (locking) signature. It was added as a normal approval signature; readers will still allow further incremental signatures.',
    );
  }
  const certified = input.finalize && canCertify;

  /* ---- signature dictionary with /ByteRange + /Contents placeholders ---- */
  const byteRange = PDFArray.withContext(doc.context);
  byteRange.push(PDFNumber.of(0));
  for (let i = 0; i < 3; i += 1) {
    byteRange.push(PDFName.of(BYTE_RANGE_PLACEHOLDER.slice(1)));
  }

  const placeholderBytes =
    input.signatureLength ??
    (input.timestamp
      ? Math.max(32768, estimateCmsSize(input.certificate, true) + 4096)
      : Math.max(16_384, estimateCmsSize(input.certificate) + 4096));

  const signatureDict: SignatureDictionary = {
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: byteRange,
    Contents: PDFHexString.fromBytes(new Uint8Array(placeholderBytes)),
    M: PDFString.fromDate(input.signingTime),
    Name: PDFString.of(pdfSafeText(signerName)),
    Prop_Build: { App: { Name: 'pecset' } },
  };
  if (input.options.reason) signatureDict.Reason = PDFString.of(pdfSafeText(input.options.reason));
  if (input.options.location) {
    signatureDict.Location = PDFString.of(pdfSafeText(input.options.location));
  }
  if (input.options.contactInfo) {
    signatureDict.ContactInfo = PDFString.of(pdfSafeText(input.options.contactInfo));
  }
  if (certified) {
    // Certify the document: no changes allowed after this signature.
    signatureDict.Reference = [
      {
        Type: 'SigRef',
        TransformMethod: 'DocMDP',
        TransformParams: { Type: 'TransformParams', V: '1.2', P: 1 },
        DigestMethod: 'SHA256',
      },
    ];
  }

  // Serialise by hand (`PDFInvalidObject`) so the placeholders survive verbatim
  // and the dictionary is never moved into a compressed object stream.
  const signatureObject = doc.context.obj(signatureDict);
  const signatureBytes = new Uint8Array(signatureObject.sizeInBytes());
  signatureObject.copyBytesInto(signatureBytes, 0);
  const signatureRef = doc.context.register(PDFInvalidObject.of(signatureBytes));

  /* ------------------------------- widget ------------------------------- */
  const rect = PDFArray.withContext(doc.context);
  for (const value of appearance.rect) rect.push(PDFNumber.of(value));

  const widgetRef = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      Rect: rect,
      V: signatureRef,
      T: PDFString.of(fieldName),
      // F=4 -> Print; F=132 (as in Acrobat) would add Locked+Print. Keep it printable.
      F: 4,
      P: page.ref,
      AP: { N: appearance.ref },
    }),
  );

  attachToPage(doc, page, widgetRef);

  const acroForm = doc.catalog.getOrCreateAcroForm();
  let fields = acroForm.dict.get(PDFName.of('Fields'));
  if (!(fields instanceof PDFArray)) {
    fields = doc.context.obj([]);
    acroForm.dict.set(PDFName.of('Fields'), fields);
  }
  (fields as PDFArray).push(widgetRef);

  const previousFlags = acroForm.dict.get(PDFName.of('SigFlags'));
  const baseFlags = previousFlags instanceof PDFNumber ? previousFlags.asNumber() : 0;
  // bit 1 = SignaturesExist, bit 2 = AppendOnly.
  const flags = input.finalize ? baseFlags | 1 : baseFlags | 1 | 2;
  acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(flags));

  if (certified) {
    doc.catalog.set(PDFName.of('Perms'), doc.context.obj({ DocMDP: signatureRef }));
  }

  /* --------------------------- incremental save -------------------------- */
  const withPlaceholder = await doc.save();
  if (withPlaceholder.length <= input.pdfBytes.length) {
    throw new SignError('invalid-pdf', 'Incremental save produced no new revision.');
  }

  const prepared = prepareSignaturePlaceholder(withPlaceholder);
  const cms = await createDetachedCms(
    prepared.signedContent,
    input.certificate,
    input.signingTime,
    input.timestamp,
  );
  const signed = insertCms(prepared, cms);

  return { pdfBytes: signed, fieldName, certified, documentDatesChanged, warnings };
}

/* -------------------------------------------------------------------------- */
/*                                  Entry point                                */
/* -------------------------------------------------------------------------- */

/** Sign a PDF with the signers referenced by each placement. */
export async function signPdf(request: SignPdfRequest): Promise<SignResult> {
  const { placements, options } = request;
  if (placements.length === 0) {
    throw new SignError('no-placement', 'Place at least one signature before signing.');
  }
  if (options.chainMode === 'finalize' && placements.length > 1) {
    throw new SignError(
      'no-placement',
      'A final (certification) signature can only be applied to a single signature at a time.',
    );
  }
  if (options.chainMode === 'finalize' && placements.some((item) => item.signer?.type === 'dummy')) {
    throw new SignError('no-certificate', 'A certification signature requires a real certificate.');
  }

  const signingTime = request.signingTime ?? new Date();
  const timestampConfig: TimestampConfig | null = request.timestamp?.url
    ? {
        url: request.timestamp.url,
        timeoutMs: request.timestamp.timeoutMs,
        fetchImpl: request.fetchImpl,
      }
    : null;
  const originalLength = request.pdfBytes.length;

  // Resolve every placement once, in caller order, so a bad signer or a locked
  // certificate fails with its own code before any revision is written.
  const stamps: { placement: SignaturePlacement; dummyName: string }[] = [];
  const signatures: {
    placement: SignaturePlacement;
    certificate: LoadedP12;
    appearanceName: string;
  }[] = [];

  for (const placement of placements) {
    const signer = placement.signer;
    if (!signer) {
      throw new SignError('no-signer', 'Choose a signer for every signature placement.');
    }
    if (signer.type === 'dummy') {
      if (placement.kind === 'invisible') {
        throw new SignError(
          'invisible-dummy',
          'Invisible signatures are not available for dummy signers.',
        );
      }
      stamps.push({
        placement,
        dummyName: request.dummyNames.get(signer.id) ?? 'Dummy signature',
      });
      continue;
    }
    const certificate = request.certificates.get(signer.id);
    if (!certificate) {
      throw new SignError(
        'certificate-locked',
        `The certificate "${signer.id}" is locked or unavailable.`,
      );
    }
    signatures.push({
      placement,
      certificate,
      appearanceName: request.certificateNames?.get(signer.id) ?? certificate.info.commonName,
    });
  }

  /*
   * Revision order is deliberate: every dummy (stamp) placement is written
   * before every certificate placement. A signature covers everything appended
   * before it, so stamps-first keeps each real signature valid over the dummy
   * marks, and a certification signature therefore also stays last. The visual
   * position of a stamp is independent of this order - do not "simplify" this
   * back to caller order.
   */
  const ordered = [
    ...stamps.map((entry) => ({ ...entry, kind: 'stamp' as const })),
    ...signatures.map((entry) => ({ ...entry, kind: 'sign' as const })),
  ];

  const signatureFieldNames: string[] = [];
  const dummyNames: string[] = [];
  const warnings: string[] = [];
  let pdfBytes = request.pdfBytes;
  let certified = false;
  let documentDatesChanged = false;

  // The date override belongs to the first real-signature revision only: later
  // revisions must not touch the Info/XMP dates again.
  const firstSignatureIndex = ordered.findIndex((entry) => entry.kind === 'sign');

  const pushWarnings = (incoming: string[]): void => {
    for (const warning of incoming) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  };

  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    if (entry.kind === 'stamp') {
      const result = await stampSingle({
        pdfBytes,
        placement: entry.placement,
        dummyName: entry.dummyName,
        signingTime,
      });
      pdfBytes = result.pdfBytes;
      dummyNames.push(result.dummyName);
      pushWarnings(result.warnings);
      continue;
    }

    const isLast = index === ordered.length - 1;
    const result = await signSingle({
      pdfBytes,
      certificate: entry.certificate,
      placement: entry.placement,
      signingTime,
      options,
      finalize: options.chainMode === 'finalize' && isLast,
      appearanceName: entry.appearanceName,
      fieldName: placements.length === 1 ? request.fieldName : undefined,
      signatureLength: request.signatureLength,
      timestamp: timestampConfig,
      documentDates: index === firstSignatureIndex ? (request.documentDates ?? null) : null,
    });
    pdfBytes = result.pdfBytes;
    signatureFieldNames.push(result.fieldName);
    pushWarnings(result.warnings);
    certified = result.certified;
    documentDatesChanged = documentDatesChanged || result.documentDatesChanged;
  }

  const timestamped = timestampConfig !== null && signatures.length > 0;

  return {
    pdfBytes,
    byteLength: pdfBytes.length,
    incrementalByteLength: pdfBytes.length - originalLength,
    signatureFieldNames,
    dummyNames,
    certified,
    timestamped,
    timestampAuthority: timestamped && timestampConfig ? timestampConfig.url : null,
    signingTime: signingTime.toISOString(),
    documentDatesChanged,
    warnings,
  };
}
