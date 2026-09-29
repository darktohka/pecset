/**
 * The Acrobat "standard" signature appearance.
 *
 * The reference document's visible signature (`Signature2`) points at form
 * XObject 241: a 78.5458 x 26.8365 pt box holding a light-red vector
 * mark and four lines of text. `ADOBE_MARK_SVG_PATH` and `ADOBE_MARK_PDF`
 * below are replayed from that XObject's own content stream, so the mark is a
 * literal reproduction rather than a redrawn approximation:
 *
 *   - the stream scales by 0.2508698 and translates by 26.8546753 / 0.7491455,
 *   - then translates again by 96.1 / 24.7 before drawing,
 *   - and fills with `1 0.85 0.85 rg` inside a 24.836 x 24.836 clip.
 *
 * This module intentionally imports nothing: `appearance.ts` consumes
 * {@link ADOBE_MARK_PDF} for the PDF form XObject and the viewer consumes
 * {@link ADOBE_MARK_SVG_PATH} so the on-screen preview shows the same artwork.
 */

/** Design-space size of the standard appearance, in points. */
export const ADOBE_WIDTH = 78.5458;
export const ADOBE_HEIGHT = 26.8365;

/** Square the mark occupies inside the design space (PDF coordinates, y up). */
export const ADOBE_MARK_BOX = {
  x: 26.855,
  y: 1,
  width: 24.836,
  height: 24.836,
} as const;

/** Fill colour of the mark, i.e. `1 0.85 0.85 rg`. */
export const ADOBE_MARK_FILL = '#ffd9d9';

/**
 * The mark as an SVG path. Coordinates are already converted to SVG's y-down
 * convention (`y' = ADOBE_HEIGHT - y`), so it draws directly into a
 * `0 0 ${ADOBE_WIDTH} ${ADOBE_HEIGHT}` viewBox with no transform.
 */
export const ADOBE_MARK_SVG_PATH =
  'M50.9633 19.8909 L51.0385 19.8909 C51.1389 19.8909 51.189 19.916 51.189 19.9912 C51.189 20.0665 51.1138 20.0916 51.0385 20.0916 L50.9633 20.0916 L50.9633 19.8909 M50.4615 20.1417 C50.4615 20.4679 50.7375 20.7187 51.0636 20.7187 ' +
  'C51.4399 20.7187 51.6908 20.4679 51.6908 20.1417 C51.6908 19.7905 51.4399 19.5397 51.0636 19.5397 C50.7375 19.5397 50.4615 19.7905 50.4615 20.1417 M50.9633 20.1919 L51.0385 20.1919 C51.1138 20.1919 51.164 20.2672 51.189 20.3424 L51.2141 20.4679 L51.3396 20.4679 ' +
  'L51.3145 20.3424 C51.3145 20.2421 51.2643 20.1668 51.189 20.1417 C51.2643 20.1167 51.3396 20.0916 51.3396 19.9912 C51.3145 19.8407 51.2392 19.7403 51.0385 19.7403 L50.8378 19.7403 L50.8378 20.4679 L50.9633 20.4679 L50.9633 20.1919 ' +
  'M50.587 20.1417 C50.587 19.8658 50.8127 19.6651 51.0636 19.6651 C51.3647 19.6651 51.5403 19.8658 51.5403 20.1417 C51.5403 20.3926 51.3647 20.5933 51.0636 20.5933 C50.8127 20.5933 50.587 20.3926 50.587 20.1417 M51.5403 18.4609 C51.6155 18.2853 51.6908 18.21 51.6908 18.0344 C51.6908 17.056 49.9849 16.5543 47.5013 16.5543 ' +
  'C46.6483 16.5543 45.6197 16.6547 44.4908 16.7299 C43.7131 16.3034 42.9354 15.8017 42.233 15.2749 C40.4518 13.7947 39.1473 11.4115 38.3696 9.0031 C38.7208 7.0212 38.7208 5.3153 38.7961 3.4338 C38.6205 4.2868 38.4449 5.6666 38.0435 7.7237 C37.5919 6.2436 37.4163 4.7885 37.4163 3.6596 C37.4163 3.4338 37.4163 1.8784 37.9431 1.5272 C38.2943 1.7028 38.7208 2.054 38.7961 2.9822 ' +
  'C39.1473 1.3767 38.5452 1.3767 37.5919 1.3767 C36.7389 1.3767 36.7389 3.4338 36.7389 3.9356 C36.7389 4.638 36.8393 5.4909 36.9898 6.369 C37.1403 7.2219 37.341 8.1753 37.5919 9.0784 C37.5919 10.4582 31.0693 25.7863 27.532 25.7863 C27.3815 24.9083 29.0874 22.4999 31.4958 20.6686 C28.0589 22.4999 27.0554 24.557 27.0554 25.4351 C27.0554 25.9368 28.0589 26.1124 28.1341 26.1124 ' +
  'C29.3383 26.1124 31.2198 24.3062 33.9041 19.6651 C36.8393 18.6365 40.6776 17.8839 44.1145 17.5327 C46.272 18.6365 48.6803 19.3139 50.1354 19.3139 C50.9131 19.3139 51.3396 19.1383 51.4399 18.7369 C51.2643 18.8121 50.9884 18.9125 50.6622 18.9125 C49.5333 18.9125 47.5514 18.2853 45.5946 17.3571 C47.4009 17.2317 51.6155 17.056 51.5403 18.4609 M33.9041 19.5898 ' +
  'C36.7389 14.6728 37.5919 12.1892 38.0435 10.4582 C39.7494 14.748 41.9821 16.2031 43.1863 16.9055 C40.2762 17.4073 36.9146 18.2853 33.9041 19.5898 Z ';

/**
 * The mark as PDF content-stream operators, clip and balanced `q`/`Q`
 * included, ready to be concatenated into a form XObject's stream.
 */
export const ADOBE_MARK_PDF = [
  'q',
  '26.855 1 24.836 24.836 re',
  'W* n',
  'q',
  '0.2508698 0 0 0.2508698 26.8546753 0.7491455 cm',
  '1 0.85 0.85 rg',
  '0 i',
  'q 1 0 0 1 96.1 24.7 cm',
  '0 0 m',
  '0.3 0 l',
  '0.7 0 0.9 -0.1 0.9 -0.4 c',
  '0.9 -0.7 0.6 -0.8 0.3 -0.8 c',
  '0 -0.8 l',
  '0 0 l',
  '-2 -1 m',
  '-2 -2.3 -0.9 -3.3 0.4 -3.3 c',
  '1.9 -3.3 2.9 -2.3 2.9 -1 c',
  '2.9 0.4 1.9 1.4 0.4 1.4 c',
  '-0.9 1.4 -2 0.4 -2 -1 c',
  '0 -1.2 m',
  '0.3 -1.2 l',
  '0.6 -1.2 0.8 -1.5 0.9 -1.8 c',
  '1 -2.3 l',
  '1.5 -2.3 l',
  '1.4 -1.8 l',
  '1.4 -1.4 1.2 -1.1 0.9 -1 c',
  '1.2 -0.9 1.5 -0.8 1.5 -0.4 c',
  '1.4 0.2 1.1 0.6 0.3 0.6 c',
  '-0.5 0.6 l',
  '-0.5 -2.3 l',
  '0 -2.3 l',
  '0 -1.2 l',
  '-1.5 -1 m',
  '-1.5 0.1 -0.6 0.9 0.4 0.9 c',
  '1.6 0.9 2.3 0.1 2.3 -1 c',
  '2.3 -2 1.6 -2.8 0.4 -2.8 c',
  '-0.6 -2.8 -1.5 -2 -1.5 -1 c',
  '2.3 5.7 m',
  '2.6 6.4 2.9 6.7 2.9 7.4 c',
  '2.9 11.3 -3.9 13.3 -13.8 13.3 c',
  '-17.2 13.3 -21.3 12.9 -25.8 12.6 c',
  '-28.9 14.3 -32 16.3 -34.8 18.4 c',
  '-41.9 24.3 -47.1 33.8 -50.2 43.4 c',
  '-48.8 51.3 -48.8 58.1 -48.5 65.6 c',
  '-49.2 62.2 -49.9 56.7 -51.5 48.5 c',
  '-53.3 54.4 -54 60.2 -54 64.7 c',
  '-54 65.6 -54 71.8 -51.9 73.2 c',
  '-50.5 72.5 -48.8 71.1 -48.5 67.4 c',
  '-47.1 73.8 -49.5 73.8 -53.3 73.8 c',
  '-56.7 73.8 -56.7 65.6 -56.7 63.6 c',
  '-56.7 60.8 -56.3 57.4 -55.7 53.9 c',
  '-55.1 50.5 -54.3 46.7 -53.3 43.1 c',
  '-53.3 37.6 -79.3 -23.5 -93.4 -23.5 c',
  '-94 -20 -87.2 -10.4 -77.6 -3.1 c',
  '-91.3 -10.4 -95.3 -18.6 -95.3 -22.1 c',
  '-95.3 -24.1 -91.3 -24.8 -91 -24.8 c',
  '-86.2 -24.8 -78.7 -17.6 -68 0.9 c',
  '-56.3 5 -41 8 -27.3 9.4 c',
  '-18.7 5 -9.1 2.3 -3.3 2.3 c',
  '-0.2 2.3 1.5 3 1.9 4.6 c',
  '1.2 4.3 0.1 3.9 -1.2 3.9 c',
  '-5.7 3.9 -13.6 6.4 -21.4 10.1 c',
  '-14.2 10.6 2.6 11.3 2.3 5.7 c',
  '-68 1.2 m',
  '-56.7 20.8 -53.3 30.7 -51.5 37.6 c',
  '-44.7 20.5 -35.8 14.7 -31 11.9 c',
  '-42.6 9.9 -56 6.4 -68 1.2 c',
  'h',
  'f',
  'Q',
  'Q',
  'Q',
].join('\n');

/**
 * First line of the four-line detail block. A dummy signature must never claim
 * to be digitally signed, so both the PDF builder and the on-screen preview read
 * the wording from here rather than hardcoding it.
 */
export const ADOBE_DETAIL_LEAD = 'Digitally signed';

/**
 * Text layout of the standard appearance, in design space (y up).
 *
 * The signer name sits on the left and may wrap, but the font size is chosen so
 * it never needs more than {@link ADOBE_TEXT_LAYOUT.name.maxLines} lines - a
 * long name shrinks instead of growing a third line. The four-line detail block
 * on the right keeps each of its four entries on one line.
 */
export const ADOBE_TEXT_LAYOUT = {
  /** Signer name: auto-fitted, wrapped onto at most `maxLines` lines. */
  name: {
    clip: [1, 1, 38.273, 24.836] as const,
    x: 1,
    maxWidth: 38.273,
    fontSize: 10.2,
    maxLines: 2,
    /** First baseline the reference uses for its own two-line name block. */
    referenceBaseline: 16.56,
  },
  /** Four-line detail block: "Digitally signed / by … / Date: … / <time>". */
  label: {
    clip: [40.038, 1, 37.508, 24.836] as const,
    x: 40.0379,
    maxWidth: 37.508,
    fontSize: 5.154,
    firstBaseline: 21.191,
    lineHeight: 1.2,
  },
  /** Vertical centre of the design box. */
  centreY: 13.418,
  /** Helvetica's visual ascent / descent, as a fraction of the font size. */
  ascent: 0.718,
  descent: 0.207,
} as const;

export interface WrappedText {
  lines: string[];
  size: number;
}

/**
 * Lay `text` out at the largest font size at or below `maxSize` that fits
 * `maxWidth`, splitting it over at most `maxLines` lines.
 *
 * A line's width is linear in the font size, so for any candidate split the
 * widest line alone decides how large the text can be. Every way of cutting the
 * words into up to `maxLines` runs is therefore evaluated, and the split with
 * the largest resulting size wins. Fewer lines win ties, so text that already
 * fits on one line is never wrapped needlessly.
 */
export function fitWrappedText(
  text: string,
  maxWidth: number,
  maxSize: number,
  maxLines: number,
  measure: (text: string, size: number) => number,
): WrappedText {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { lines: [], size: maxSize };

  let best: WrappedText | null = null;
  for (let lines = 1; lines <= Math.max(1, maxLines); lines += 1) {
    for (const candidate of cutIntoRuns(words, lines)) {
      const widest = Math.max(...candidate.map((line) => measure(line, maxSize)));
      if (!(widest > 0)) continue;
      const size = Math.min(maxSize, (maxWidth / widest) * maxSize);
      if (best === null || size > best.size + 1e-6) best = { lines: candidate, size };
    }
  }
  return best ?? { lines: [words.join(' ')], size: maxSize };
}

function cutIntoRuns(words: string[], lines: number): string[][] {
  if (lines === 1) return [[words.join(' ')]];
  const runs: string[][] = [];
  for (let cut = 1; cut <= words.length - lines + 1; cut += 1) {
    for (const rest of cutIntoRuns(words.slice(cut), lines - 1)) {
      runs.push([words.slice(0, cut).join(' '), ...rest]);
    }
  }
  return runs;
}
