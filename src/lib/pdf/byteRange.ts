/**
 * PDF signature `/ByteRange` handling.
 *
 * A PDF signature covers two byte ranges that skip over the `/Contents` hex
 * string holding the CMS blob. The placeholder builder writes:
 *
 *   /ByteRange [0 /********** /********** /**********]
 *   /Contents <0000...0000>
 *
 * `/ByteRange` values must be present *before* the digest is computed (they are
 * part of the signed bytes), and the replacement must be length preserving so
 * no offsets shift. Each `/**********` placeholder is a `PDFName`, so the token
 * we replace includes the leading `/`.
 *
 * This mirrors what `@signpdf` does, but stays `Uint8Array`-native so it needs
 * no Node `Buffer` polyfill in the browser.
 */
import { SignError } from '@/types';

/** Width, in characters, of each `/ByteRange` placeholder field (incl. slash). */
export const BYTE_RANGE_PLACEHOLDER = '/**********';

export interface PreparedSignature {
  /** Placeholder PDF with the real `/ByteRange` numbers filled in. */
  pdfBytes: Uint8Array;
  /** The exact bytes that must be hashed and signed. */
  signedContent: Uint8Array;
  /** Index of the `<` that opens `/Contents`. */
  contentsStart: number;
  /** Index just past the `>` that closes `/Contents`. */
  contentsEnd: number;
  /** Capacity of `/Contents`, in bytes. */
  placeholderBytes: number;
}

/* -------------------------------------------------------------------------- */
/*                          latin1 <-> bytes helpers                           */
/* -------------------------------------------------------------------------- */

const CHUNK = 0x8000;

export function bytesToLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

export function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                                  Prepare                                    */
/* -------------------------------------------------------------------------- */

/**
 * Locate the signature placeholder, fill in the real `/ByteRange` values and
 * return the exact bytes to sign.
 */
export function prepareSignaturePlaceholder(placeholderPdf: Uint8Array): PreparedSignature {
  const text = bytesToLatin1(placeholderPdf);

  // The most recently appended `/ByteRange` belongs to the signature we add now.
  const byteRangeAt = text.lastIndexOf('/ByteRange');
  if (byteRangeAt < 0) {
    throw new SignError('byte-range-not-found', 'No /ByteRange placeholder found in the PDF.');
  }

  // `/Contents` follows `/ByteRange` in our signature dictionary.
  const contentsKeyAt = text.indexOf('/Contents', byteRangeAt);
  if (contentsKeyAt < 0) {
    throw new SignError('byte-range-not-found', 'No /Contents placeholder found in the PDF.');
  }
  const open = text.indexOf('<', contentsKeyAt);
  const close = text.indexOf('>', open);
  if (open < 0 || close < 0) {
    throw new SignError('byte-range-not-found', 'Malformed /Contents placeholder.');
  }

  const hexLength = close - open - 1;
  if (hexLength % 2 !== 0) {
    throw new SignError('invalid-pdf', 'Odd number of hex digits in /Contents placeholder.');
  }
  const placeholderBytes = hexLength / 2;

  const contentsStart = open;
  const contentsEnd = close + 1;
  const byteRange: [number, number, number, number] = [
    0,
    contentsStart,
    contentsEnd,
    placeholderPdf.length - contentsEnd,
  ];

  // Fill the three number slots, preserving total length.
  const token = BYTE_RANGE_PLACEHOLDER;
  const fieldWidth = token.length;
  let patched = text;
  let cursor = patched.indexOf(token, byteRangeAt);
  for (let i = 1; i <= 3; i += 1) {
    if (cursor < 0) {
      throw new SignError('byte-range-not-found', 'Not enough /ByteRange placeholders.');
    }
    const value = String(byteRange[i]);
    if (value.length > fieldWidth) {
      throw new SignError('invalid-pdf', 'Document too large for the /ByteRange placeholder width.');
    }
    patched =
      patched.slice(0, cursor) + value.padStart(fieldWidth, ' ') + patched.slice(cursor + fieldWidth);
    cursor = patched.indexOf(token, cursor + fieldWidth);
  }

  if (patched.length !== text.length) {
    throw new SignError('invalid-pdf', '/ByteRange rewrite changed the document length.');
  }

  const pdfBytes = latin1ToBytes(patched);
  const signedContent = new Uint8Array(contentsStart + (pdfBytes.length - contentsEnd));
  signedContent.set(pdfBytes.subarray(0, contentsStart), 0);
  signedContent.set(pdfBytes.subarray(contentsEnd), contentsStart);

  return { pdfBytes, signedContent, contentsStart, contentsEnd, placeholderBytes };
}

/* -------------------------------------------------------------------------- */
/*                                  Insert                                     */
/* -------------------------------------------------------------------------- */

/** Splice the DER CMS into the `/Contents` slot as zero-padded hex. */
export function insertCms(prepared: PreparedSignature, der: Uint8Array): Uint8Array {
  const { pdfBytes, contentsStart, contentsEnd, placeholderBytes } = prepared;

  const hex = bytesToHex(der);
  const capacity = placeholderBytes * 2;
  if (hex.length > capacity) {
    throw new SignError('cms-too-large', 'Signature does not fit in the reserved /Contents slot.');
  }

  const text = bytesToLatin1(pdfBytes);
  const padded = hex.padEnd(capacity, '0');
  const result =
    text.slice(0, contentsStart + 1) + padded + text.slice(contentsEnd - 1);

  if (result.length !== text.length) {
    throw new SignError('invalid-pdf', 'CMS insertion changed the document length.');
  }
  return latin1ToBytes(result);
}
