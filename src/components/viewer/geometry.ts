/**
 * Pure geometry helpers for the on-page signature gesture layer.
 *
 * This module is deliberately free of DOM and React: it only does arithmetic
 * on numbers, so it can be unit tested in the node environment. All angles are
 * in degrees and all coordinate math is in screen space (y points down,
 * positive rotation appears clockwise), matching CSS `rotate()` and the
 * placement convention used by the viewer.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Orthonormal basis of a box rotated by `rotationDeg` degrees.
 *
 * `u` is the box's local +x axis and `v` its local +y axis, both expressed in
 * screen space.
 */
export function rotationBasis(rotationDeg: number): { u: Vec2; v: Vec2 } {
  const radians = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { u: { x: cos, y: sin }, v: { x: -sin, y: cos } };
}

export interface ResizeInput {
  dx: number;
  dy: number;
  hx: -1 | 0 | 1;
  hy: -1 | 0 | 1;
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotation: number;
  minSize?: number;
}

export interface ResizeOutput {
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/**
 * Resize a rotated box by dragging the handle at `(hx, hy)`.
 *
 * `dx`/`dy` is the pointer travel in screen pixels. The delta is projected onto
 * the box's own axes so the dragged handle follows the pointer, the size is
 * clamped to `minSize`, and the centre is shifted so the opposite handle stays
 * anchored.
 */
export function resizeBox(input: ResizeInput): ResizeOutput {
  const { dx, dy, hx, hy, cx, cy, width, height, rotation } = input;
  const minSize = input.minSize ?? 14;
  const { u, v } = rotationBasis(rotation);

  const du = dx * u.x + dy * u.y;
  const dv = dx * v.x + dy * v.y;

  const nextWidth = Math.max(minSize, width + hx * du);
  const nextHeight = Math.max(minSize, height + hy * dv);

  const shiftX = (hx * (nextWidth - width)) / 2;
  const shiftY = (hy * (nextHeight - height)) / 2;

  return {
    cx: cx + shiftX * u.x + shiftY * v.x,
    cy: cy + shiftX * u.y + shiftY * v.y,
    width: nextWidth,
    height: nextHeight,
  };
}

/** Normalise an angle in degrees into the half-open range `(-180, 180]`. */
export function normalizeAngle(deg: number): number {
  let angle = deg % 360;
  if (angle <= -180) angle += 360;
  if (angle > 180) angle -= 360;
  // Collapse `-0` to `0` so callers never compare against a negative zero.
  return angle === 0 ? 0 : angle;
}

/**
 * Angle of the pointer about a centre, with the box's "up" pointing at the
 * centre. A pointer directly above the centre yields `0`, below `180`, left
 * `-90` and right `90`.
 */
export function rotationFromPointer(cx: number, cy: number, px: number, py: number): number {
  return normalizeAngle((Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90);
}

/**
 * Snap `deg` to the nearest multiple of `step` when it is within `threshold`
 * degrees, otherwise normalise it unchanged.
 */
export function snapAngle(deg: number, step = 15, threshold = 7): number {
  const nearest = Math.round(deg / step) * step;
  if (Math.abs(deg - nearest) <= threshold) return normalizeAngle(nearest);
  return normalizeAngle(deg);
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Whether a screen point lies inside an axis-aligned rectangle (edges inclusive). */
export function pointInRect(x: number, y: number, rect: Rect): boolean {
  return (
    x >= rect.left &&
    x <= rect.left + rect.width &&
    y >= rect.top &&
    y <= rect.top + rect.height
  );
}

/**
 * Index of the rectangle containing `(x, y)`, or of the rectangle whose centre
 * is closest when the point falls outside all of them. Returns `-1` for an
 * empty list.
 */
export function nearestRectIndex(x: number, y: number, rects: Rect[]): number {
  if (rects.length === 0) return -1;

  for (let index = 0; index < rects.length; index += 1) {
    if (pointInRect(x, y, rects[index])) return index;
  }

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const distance = (x - centerX) ** 2 + (y - centerY) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}
