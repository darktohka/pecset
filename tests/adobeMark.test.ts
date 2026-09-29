import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { ADOBE_TEXT_LAYOUT, fitWrappedText } from '@/lib/pdf/adobeMark';

// Real Helvetica metrics, embedded through pdf-lib so the layout is tested
// against the same standard font the PDF appearance uses.
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const measure = (text: string, size: number): number => font.widthOfTextAtSize(text, size);

const { maxWidth, fontSize, maxLines } = ADOBE_TEXT_LAYOUT.name;

const NAMES = [
  'Dana',
  'Dana Signer',
  'Dummy Test Signer',
  'Madonna',
  'An Extremely Long Signer Name That Keeps Going',
  'Dummy Test Signer Es Tarsai Kft',
  'Unknown signer',
];

const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();

describe('fitWrappedText', () => {
  it('keeps every name within two lines, word-complete, ordered and inside the clip', () => {
    for (const name of NAMES) {
      const result = fitWrappedText(name, maxWidth, fontSize, maxLines, measure);

      expect(result.lines.length).toBeGreaterThanOrEqual(1);
      expect(result.lines.length).toBeLessThanOrEqual(maxLines);
      expect(result.size).toBeGreaterThan(0);
      expect(result.size).toBeLessThanOrEqual(fontSize);

      for (const line of result.lines) {
        expect(measure(line, result.size)).toBeLessThanOrEqual(maxWidth + 1e-9);
      }
      expect(normalise(result.lines.join(' '))).toBe(normalise(name));
    }
  });

  it('fits a short name on one line at the full size', () => {
    const result = fitWrappedText('Dana', maxWidth, fontSize, maxLines, measure);

    expect(result.lines).toEqual(['Dana']);
    expect(result.size).toBe(10.2);
    expect(measure('Dana', fontSize)).toBeLessThanOrEqual(maxWidth);
  });

  it('wraps a long name to two lines and keeps it larger than any single line could be', () => {
    const long = 'An Extremely Long Signer Name That Keeps Going';
    const result = fitWrappedText(long, maxWidth, fontSize, maxLines, measure);

    expect(result.lines).toHaveLength(2);

    const singleLineSize = Math.min(fontSize, (maxWidth / measure(long, fontSize)) * fontSize);
    expect(result.size).toBeGreaterThan(singleLineSize);
  });

  it('splits text that cannot fit one line instead of shrinking it to nothing', () => {
    // With the real Helvetica metrics "Dana Signer" is 56.692pt wide at 10.2pt,
    // which overflows the 38.273pt clip, so it is laid out as two full-size lines.
    expect(measure('Dana Signer', fontSize)).toBeGreaterThan(maxWidth);
    const result = fitWrappedText('Dana Signer', maxWidth, fontSize, maxLines, measure);

    expect(result.lines).toEqual(['Dana', 'Signer']);
    expect(result.size).toBe(10.2);
  });

  it('never wraps text that already fits on one line', () => {
    const result = fitWrappedText('Dana', maxWidth, fontSize, maxLines, measure);

    expect(result.lines).toHaveLength(1);
  });

  it('returns no lines for blank input, the layout guard used before rendering', () => {
    const result = fitWrappedText('   ', maxWidth, fontSize, maxLines, measure);

    expect(result.lines).toEqual([]);
    expect(result.size).toBe(fontSize);
  });
});
