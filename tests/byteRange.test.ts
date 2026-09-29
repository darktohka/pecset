import { describe, expect, it } from 'vitest';
import {
  BYTE_RANGE_PLACEHOLDER,
  insertCms,
  prepareSignaturePlaceholder,
} from '@/lib/pdf/byteRange';
import { SignError } from '@/types';

const CONTENTS_BYTES = 64;

function makePlaceholderPdf(): Uint8Array {
  const zeros = '0'.repeat(CONTENTS_BYTES * 2);
  const token = BYTE_RANGE_PLACEHOLDER;
  const text =
    '%PDF-1.6\n' +
    '1 0 obj\n<< /Type /Catalog >>\nendobj\n' +
    '2 0 obj\n<< /Type /Sig /ByteRange [0 ' +
    `${token} ${token} ${token}] ` +
    `/Contents <${zeros}> >>\nendobj\n` +
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

describe('prepareSignaturePlaceholder', () => {
  it('locates /Contents, fills /ByteRange and preserves the document length', () => {
    const pdf = makePlaceholderPdf();
    const prepared = prepareSignaturePlaceholder(pdf);

    expect(prepared.pdfBytes.length).toBe(pdf.length);
    expect(prepared.placeholderBytes).toBe(CONTENTS_BYTES);
    expect(prepared.contentsEnd - prepared.contentsStart - 2).toBe(CONTENTS_BYTES * 2);

    const text = new TextDecoder('latin1').decode(prepared.pdfBytes);
    const match = /\/ByteRange \[0\s+(\d+)\s+(\d+)\s+(\d+)\]/.exec(text);
    expect(match).not.toBeNull();
    const [, first, second, third] = match!;
    expect(Number(first)).toBe(prepared.contentsStart);
    expect(Number(second)).toBe(prepared.contentsEnd);
    expect(Number(third)).toBe(pdf.length - prepared.contentsEnd);
  });

  it('excludes the /Contents region from the signed content', () => {
    const pdf = makePlaceholderPdf();
    const prepared = prepareSignaturePlaceholder(pdf);

    expect(prepared.signedContent.length).toBe(pdf.length - CONTENTS_BYTES * 2 - 2);
    const head = new TextDecoder('latin1').decode(prepared.signedContent);
    expect(head).toContain('%%EOF');
    expect(head).not.toContain('0'.repeat(CONTENTS_BYTES * 2));
  });

  it('throws a SignError when there is no placeholder', () => {
    const pdf = new TextEncoder().encode('%PDF-1.6\ntrailer\n<<>>\n%%EOF\n');
    expect(() => prepareSignaturePlaceholder(pdf)).toThrow(SignError);
  });
});

describe('insertCms', () => {
  it('splices the DER as zero-padded hex without changing the length', () => {
    const pdf = makePlaceholderPdf();
    const prepared = prepareSignaturePlaceholder(pdf);
    const der = new Uint8Array([0x30, 0x82, 0x01, 0x00, 0xab, 0xcd]);

    const signed = insertCms(prepared, der);
    expect(signed.length).toBe(pdf.length);

    const text = new TextDecoder('latin1').decode(signed);
    const start = text.indexOf('<', text.indexOf('/Contents'));
    const end = text.indexOf('>', start);
    const hex = text.slice(start + 1, end);
    expect(hex.length).toBe(CONTENTS_BYTES * 2);
    expect(hex.startsWith('3082010 0abcd'.replace(' ', ''))).toBe(true);
    expect(hex.endsWith('0'.repeat(CONTENTS_BYTES * 2 - der.length * 2))).toBe(true);
  });

  it('leaves the signed byte ranges identical before and after insertion', () => {
    const pdf = makePlaceholderPdf();
    const prepared = prepareSignaturePlaceholder(pdf);
    const before = new TextDecoder('latin1').decode(prepared.pdfBytes);

    const signed = insertCms(prepared, new Uint8Array([0x30, 0x00]));
    const after = new TextDecoder('latin1').decode(signed);

    const signedRegionBefore = before.slice(0, prepared.contentsStart) + before.slice(prepared.contentsEnd);
    const signedRegionAfter = after.slice(0, prepared.contentsStart) + after.slice(prepared.contentsEnd);
    expect(signedRegionAfter).toBe(signedRegionBefore);
  });

  it('refuses a signature that does not fit', () => {
    const pdf = makePlaceholderPdf();
    const prepared = prepareSignaturePlaceholder(pdf);
    const tooBig = new Uint8Array(CONTENTS_BYTES + 1);
    expect(() => insertCms(prepared, tooBig)).toThrow(SignError);
  });
});
