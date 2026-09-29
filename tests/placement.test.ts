import { describe, expect, it } from 'vitest';
import { resolvePlacementPosition } from '@/state/placement';
import type { PdfPageInfo } from '@/types';

function page(width: number, height: number, index = 0): PdfPageInfo {
  return { index, width, height, rotation: 0 };
}

describe('resolvePlacementPosition', () => {
  it('keeps a valid anchor on its non-first page when it is inside the bounds', () => {
    const pages = [page(600, 800, 0), page(600, 800, 1), page(600, 800, 2)];
    const result = resolvePlacementPosition(
      { pageIndex: 1, cx: 200, cy: 300 },
      pages,
      { width: 100, height: 40 },
    );
    expect(result).toEqual({ pageIndex: 1, cx: 200, cy: 300 });
  });

  it('falls back to the page 0 centre for a null anchor', () => {
    const pages = [page(600, 800), page(400, 400, 1)];
    expect(resolvePlacementPosition(null, pages, { width: 190, height: 65 })).toEqual({
      pageIndex: 0,
      cx: 300,
      cy: 400,
    });
  });

  it('falls back to the page 0 centre for an out-of-range page index', () => {
    const pages = [page(600, 800), page(400, 400, 1)];
    expect(
      resolvePlacementPosition({ pageIndex: 5, cx: 10, cy: 10 }, pages, {
        width: 190,
        height: 65,
      }),
    ).toEqual({ pageIndex: 0, cx: 300, cy: 400 });
  });

  it('clamps a near-edge anchor so the box stays fully on the page', () => {
    const pages = [page(600, 800)];
    const size = { width: 100, height: 40 };

    expect(resolvePlacementPosition({ pageIndex: 0, cx: 5, cy: 5 }, pages, size)).toEqual({
      pageIndex: 0,
      cx: 50,
      cy: 20,
    });
    expect(
      resolvePlacementPosition({ pageIndex: 0, cx: 595, cy: 795 }, pages, size),
    ).toEqual({ pageIndex: 0, cx: 550, cy: 780 });
  });

  it('centres a box wider and taller than its page', () => {
    const pages = [page(100, 100)];
    expect(
      resolvePlacementPosition({ pageIndex: 0, cx: 0, cy: 0 }, pages, {
        width: 300,
        height: 200,
      }),
    ).toEqual({ pageIndex: 0, cx: 50, cy: 50 });
  });

  it('uses the fixed fallback when the document has no pages', () => {
    expect(resolvePlacementPosition(null, [], { width: 190, height: 65 })).toEqual({
      pageIndex: 0,
      cx: 300,
      cy: 400,
    });
  });
});
