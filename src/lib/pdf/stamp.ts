/**
 * Dummy (visible-only) stamps.
 *
 * A dummy signer has no key material, so a dummy placement must not produce a
 * signature dictionary or touch the document's signature machinery: it only
 * appends a `/Stamp` annotation carrying the placement's appearance. The mark is
 * therefore visible and printable, but no digital signature covers it and
 * readers report the same signature count as before.
 *
 * Like the real signature path, the mark is written as an incremental update so
 * any signature already in the document stays valid.
 */
import {
  PDFArray,
  PDFInvalidObject,
  PDFNumber,
  PDFString,
} from "@cantoo/pdf-lib";
import { SignError, type SignaturePlacement } from "@/types";
import { buildAppearance, loadAppearanceFont } from "./appearance";
import { readCertification } from "./inspect";
import {
  attachToPage,
  existingSignatureFieldNames,
  loadForIncrementalUpdate,
} from "./sign";

export interface StampSingleInput {
  pdfBytes: Uint8Array;
  placement: SignaturePlacement;
  /** Display name of the dummy signer producing the mark. */
  dummyName: string;
  signingTime: Date;
}

export interface StampSingleResult {
  pdfBytes: Uint8Array;
  dummyName: string;
  warnings: string[];
}

/**
 * Append a visible-only `/Stamp` annotation for a dummy placement.
 *
 * No `/FT`, `/V`, `/Type /Sig` or `AcroForm` entries are written, so this never
 * registers a signature field - it must not, or readers and `pdfsig` would count
 * it as an (unsigned) signature.
 */
export async function stampSingle(
  input: StampSingleInput,
): Promise<StampSingleResult> {
  const warnings: string[] = [];
  const doc = await loadForIncrementalUpdate(input.pdfBytes);

  // A dummy mark is an annotation. A certification with permission < 3 forbids
  // adding annotations and would be invalidated by this mark; level 3 allows it.
  const certification = readCertification(doc);
  if (certification && certification.permission < 3) {
    throw new SignError(
      "certification-locked",
      "This document is certified and does not permit annotations, so adding a dummy mark would invalidate its certification.",
    );
  }

  const pages = doc.getPages();
  const placement = input.placement;
  if (placement.pageIndex < 0 || placement.pageIndex >= pages.length) {
    throw new SignError(
      "invalid-pdf",
      `Page ${placement.pageIndex + 1} does not exist.`,
    );
  }
  const page = pages[placement.pageIndex];

  const font = await loadAppearanceFont(doc);
  const appearance = await buildAppearance({
    doc,
    font,
    placement,
    signerName: input.dummyName,
    date: input.signingTime,
  });

  const rect = PDFArray.withContext(doc.context);
  for (const value of appearance.rect) rect.push(PDFNumber.of(value));

  // Serialise the annotation by hand so `/Subtype /Stamp` stays a literal in the
  // increment instead of being compressed into an object stream (a byte-level
  // scan for the mark must find it). Refs to the appearance and page resolve to
  // `n 0 R` during serialisation.
  const annotation = doc.context.obj({
    Type: "Annot",
    Subtype: "Stamp",
    Rect: rect,
    // F=4 -> Print.
    F: 4,
    P: page.ref,
    AP: { N: appearance.ref },
    M: PDFString.fromDate(input.signingTime),
    CreationDate: PDFString.fromDate(input.signingTime),
    NM: PDFString.of(`dummy-${placement.id}`),
    Subj: PDFString.of(input.dummyName),
    T: PDFString.of(input.dummyName),
    Contents: PDFString.of(""),
  });
  const annotationBytes = new Uint8Array(annotation.sizeInBytes());
  annotation.copyBytesInto(annotationBytes, 0);
  const annotationRef = doc.context.register(
    PDFInvalidObject.of(annotationBytes),
  );

  attachToPage(doc, page, annotationRef);

  if (existingSignatureFieldNames(doc).length > 0) {
    warnings.push(
      "The document already contains one or more signatures; this dummy mark is appended after them, so readers will report the document as changed since it was signed.",
    );
  }

  const saved = await doc.save();
  if (saved.length <= input.pdfBytes.length) {
    throw new SignError(
      "invalid-pdf",
      "Incremental save produced no new revision.",
    );
  }

  return { pdfBytes: saved, dummyName: input.dummyName, warnings };
}
