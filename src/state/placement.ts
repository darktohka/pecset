/**
 * Pure placement positioning for newly added signature boxes.
 *
 * This module is deliberately free of DOM and React: it only does arithmetic
 * on numbers (and plain page descriptors), so it can be unit tested in the node
 * environment. The viewer supplies a visible-centre anchor; the store calls the
 * resolver to turn it into a page index and a box centre in PDF points.
 */
import type { PdfPageInfo } from '@/types';

/** A point the viewer wants the new box placed at, in PDF points. */
export interface PlacementAnchor {
  pageIndex: number;
  cx: number;
  cy: number;
}

/** Unrotated box size in PDF points. */
export interface PlacementSize {
  width: number;
  height: number;
}

/** Final page index and box centre chosen for a new placement. */
export interface ResolvedPlacementPosition {
  pageIndex: number;
  cx: number;
  cy: number;
}

const FALLBACK_CENTRE = { cx: 300, cy: 400 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Upper/lower centre bounds that keep a `size`-sized box fully on the page. The
 * `min`/`max` form keeps a box larger than the page centred instead of letting
 * the range invert.
 */
function centreBounds(
  extent: number,
  half: number,
): { min: number; max: number } {
  const pageCentre = extent / 2;
  return {
    min: Math.min(half, pageCentre),
    max: Math.max(extent - half, pageCentre),
  };
}

/**
 * Resolve where a newly added placement should land.
 *
 * A valid anchor (integer page index inside `pages`) is honoured and clamped so
 * the box stays on its page. Anything else falls back to the centre of page 0,
 * or to a fixed point when the document has no pages at all.
 */
export function resolvePlacementPosition(
  anchor: PlacementAnchor | null,
  pages: PdfPageInfo[],
  size: PlacementSize,
): ResolvedPlacementPosition {
  const valid =
    anchor !== null &&
    Number.isInteger(anchor.pageIndex) &&
    anchor.pageIndex >= 0 &&
    anchor.pageIndex < pages.length;

  const pageIndex = valid ? anchor.pageIndex : 0;
  const page = pages[pageIndex];

  const base = valid
    ? { cx: anchor.cx, cy: anchor.cy }
    : page
      ? { cx: page.width / 2, cy: page.height / 2 }
      : FALLBACK_CENTRE;

  if (!page) {
    return { pageIndex, cx: base.cx, cy: base.cy };
  }

  const horizontal = centreBounds(page.width, size.width / 2);
  const vertical = centreBounds(page.height, size.height / 2);

  return {
    pageIndex,
    cx: clamp(base.cx, horizontal.min, horizontal.max),
    cy: clamp(base.cy, vertical.min, vertical.max),
  };
}
