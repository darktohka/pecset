/**
 * Read-only inspection of an existing PDF: page geometry and any signature
 * fields it already carries (used to detect a signature chain).
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  type PDFRef,
} from '@cantoo/pdf-lib';
import {
  SignError,
  type PdfCertificationInfo,
  type PdfInspection,
  type PdfSignatureFieldInfo,
} from '@/types';

function asRef(value: unknown): PDFRef | undefined {
  if (value && typeof value === 'object' && 'objectNumber' in (value as object)) {
    return value as PDFRef;
  }
  return undefined;
}

function resolveDict(doc: PDFDocument, value: unknown): PDFDict | undefined {
  const ref = asRef(value);
  const resolved = ref ? doc.context.lookup(ref) : value;
  return resolved instanceof PDFDict ? resolved : undefined;
}

interface SignatureFieldEntry {
  name: string;
  dict: PDFDict;
}

/** Walk the AcroForm field tree and collect every signature field. */
function signatureFieldEntries(doc: PDFDocument): SignatureFieldEntry[] {
  const entries: SignatureFieldEntry[] = [];
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acroForm) return entries;
  const fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return entries;

  // Signature fields may be nested (children) and may be merged with a widget.
  const queue = [...fields.asArray()];
  const seen = new Set<number>();

  while (queue.length > 0) {
    const entry = queue.shift();
    const ref = asRef(entry);
    const dict = ref ? doc.context.lookup(ref) : entry;
    if (!dict || !(dict instanceof PDFDict)) continue;
    if (ref) {
      if (seen.has(ref.objectNumber)) continue;
      seen.add(ref.objectNumber);
    }

    const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) queue.push(...kids.asArray());

    if (dict.get(PDFName.of('FT'))?.toString() === '/Sig') {
      const title = dict.get(PDFName.of('T'));
      entries.push({ name: title instanceof PDFString ? title.decodeText() : '(unnamed)', dict });
    }
  }
  return entries;
}

function collectSignatureFields(
  doc: PDFDocument,
  inspect: (dict: PDFDict) => void,
): void {
  for (const { dict } of signatureFieldEntries(doc)) inspect(dict);
}

/* -------------------------------------------------------------------------- */
/*                               Certification                                 */
/* -------------------------------------------------------------------------- */

/** The DocMDP `/Reference` transform inside a signature dictionary, if any. */
function findDocMdpTransform(doc: PDFDocument, signature: PDFDict): PDFDict | undefined {
  const reference = signature.lookupMaybe(PDFName.of('Reference'), PDFArray);
  if (!reference) return undefined;
  for (const entry of reference.asArray()) {
    const transform = resolveDict(doc, entry);
    if (transform?.get(PDFName.of('TransformMethod'))?.toString() === '/DocMDP') {
      return transform;
    }
  }
  return undefined;
}

function matchFieldName(
  doc: PDFDocument,
  fields: SignatureFieldEntry[],
  ref: PDFRef | undefined,
  dict: PDFDict,
): string | null {
  for (const field of fields) {
    const value = field.dict.get(PDFName.of('V'));
    const valueRef = asRef(value);
    if (ref && valueRef && valueRef.objectNumber === ref.objectNumber) return field.name;
    if (!ref && resolveDict(doc, value) === dict) return field.name;
  }
  return null;
}

/**
 * Read the document's DocMDP certification, if it carries one.
 *
 * The certification is normally reachable through the catalog's
 * `/Perms /DocMDP`, but some producers only attach the `/DocMDP` transform to
 * the signature dictionary referenced by a field's `/V`, so both shapes are
 * handled. When the `/P` permission cannot be parsed the most restrictive
 * level (`1`) is returned.
 */
export function readCertification(doc: PDFDocument): PdfCertificationInfo | null {
  const perms = doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict);
  const permsValue = perms?.get(PDFName.of('DocMDP'));
  const permsRef = asRef(permsValue);
  let signature = resolveDict(doc, permsValue);
  let fieldName: string | null = null;

  const fields = signatureFieldEntries(doc);
  if (signature) {
    fieldName = matchFieldName(doc, fields, permsRef, signature);
  } else {
    for (const field of fields) {
      const value = field.dict.get(PDFName.of('V'));
      const valueDict = resolveDict(doc, value);
      if (!valueDict || !findDocMdpTransform(doc, valueDict)) continue;
      signature = valueDict;
      fieldName = field.name;
      break;
    }
  }

  if (!signature) return null;

  let permission = 1;
  const transform = findDocMdpTransform(doc, signature);
  if (transform) {
    const params = resolveDict(doc, transform.get(PDFName.of('TransformParams')));
    const level = params?.get(PDFName.of('P'));
    if (level instanceof PDFNumber) permission = level.asNumber();
  }
  return { permission, fieldName };
}

/** Inspect a PDF's pages and signature fields. */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt/i.test(message)) {
      throw new SignError('encrypted-pdf', 'Encrypted PDFs are not supported.');
    }
    throw new SignError('invalid-pdf', `Could not read the PDF: ${message}`);
  }

  const pages = doc.getPages().map((page, index) => {
    const { width, height } = page.getSize();
    return { index, width, height, rotation: page.getRotation().angle };
  });

  const signatureFields: PdfSignatureFieldInfo[] = [];
  let signatureCount = 0;

  collectSignatureFields(doc, (dict) => {
    const nameObj = dict.get(PDFName.of('T'));
    const name = nameObj instanceof PDFString ? nameObj.decodeText() : '(unnamed)';
    const value = dict.get(PDFName.of('V'));
    const signed = Boolean(value) && !(value instanceof PDFBool);
    if (signed) signatureCount += 1;
    signatureFields.push({ name, signed });
  });

  return {
    pageCount: pages.length,
    pages,
    signatureFields,
    hasSignatures: signatureCount > 0,
    signatureCount,
    certification: readCertification(doc),
  };
}

/** Suggest a field name that does not collide with existing signature fields. */
export function suggestFieldName(existing: PdfSignatureFieldInfo[]): string {
  const taken = new Set(existing.map((field) => field.name));
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `Signature${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `Signature${Date.now()}`;
}
