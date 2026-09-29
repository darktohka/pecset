import { describe, expect, it } from 'vitest';
import {
  nearestRectIndex,
  normalizeAngle,
  pointInRect,
  resizeBox,
  rotationBasis,
  rotationFromPointer,
  snapAngle,
} from '@/components/viewer/geometry';
import type { Rect } from '@/components/viewer/geometry';

/** Screen-space corner of a rotated box for a handle vector `(hx, hy)`. */
function corner(
  cx: number,
  cy: number,
  width: number,
  height: number,
  rotation: number,
  hx: number,
  hy: number,
): { x: number; y: number } {
  const { u, v } = rotationBasis(rotation);
  return {
    x: cx + ((hx * width) / 2) * u.x + ((hy * height) / 2) * v.x,
    y: cy + ((hx * width) / 2) * u.y + ((hy * height) / 2) * v.y,
  };
}

describe('resizeBox', () => {
  it('keeps the opposite (nw) corner anchored for the se handle at any rotation', () => {
    for (const rotation of [0, 90, 180, 270, 45]) {
      const input = {
        dx: 40,
        dy: 25,
        hx: 1 as const,
        hy: 1 as const,
        cx: 100,
        cy: 80,
        width: 60,
        height: 30,
        rotation,
      };
      const before = corner(input.cx, input.cy, input.width, input.height, rotation, -1, -1);
      const output = resizeBox(input);
      const after = corner(output.cx, output.cy, output.width, output.height, rotation, -1, -1);

      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it('changes only one dimension for edge handles', () => {
    const base = { dx: 20, dy: 10, cx: 100, cy: 100, width: 80, height: 40, rotation: 0 };

    const north = resizeBox({ ...base, hx: 0, hy: -1 });
    expect(north.width).toBeCloseTo(80);
    expect(north.height).toBeCloseTo(30);

    const south = resizeBox({ ...base, hx: 0, hy: 1 });
    expect(south.width).toBeCloseTo(80);
    expect(south.height).toBeCloseTo(50);

    const east = resizeBox({ ...base, hx: 1, hy: 0 });
    expect(east.width).toBeCloseTo(100);
    expect(east.height).toBeCloseTo(40);

    const west = resizeBox({ ...base, hx: -1, hy: 0 });
    expect(west.width).toBeCloseTo(60);
    expect(west.height).toBeCloseTo(40);
  });

  it('clamps to minSize instead of inverting when dragged past the opposite edge', () => {
    const output = resizeBox({
      dx: -500,
      dy: -500,
      hx: 1,
      hy: 1,
      cx: 0,
      cy: 0,
      width: 100,
      height: 100,
      rotation: 0,
    });
    expect(output.width).toBe(14);
    expect(output.height).toBe(14);
    expect(output.width).toBeGreaterThan(0);
    expect(output.height).toBeGreaterThan(0);
  });

  it('honours a custom minSize', () => {
    const output = resizeBox({
      dx: -999,
      dy: -999,
      hx: 1,
      hy: 1,
      cx: 0,
      cy: 0,
      width: 100,
      height: 100,
      rotation: 0,
      minSize: 25,
    });
    expect(output.width).toBe(25);
    expect(output.height).toBe(25);
  });
});

describe('rotationFromPointer', () => {
  it('maps the four cardinal pointer directions to box angles', () => {
    expect(rotationFromPointer(0, 0, 0, -10)).toBeCloseTo(0);
    expect(rotationFromPointer(0, 0, 0, 10)).toBeCloseTo(180);
    expect(rotationFromPointer(0, 0, -10, 0)).toBeCloseTo(-90);
    expect(rotationFromPointer(0, 0, 10, 0)).toBeCloseTo(90);
  });
});

describe('normalizeAngle', () => {
  it('normalises into (-180, 180]', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(180)).toBe(180);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(190)).toBeCloseTo(-170);
    expect(normalizeAngle(-190)).toBeCloseTo(170);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(450)).toBeCloseTo(90);
    expect(Object.is(normalizeAngle(-0), 0)).toBe(true);
  });
});

describe('snapAngle', () => {
  it('snaps to the nearest multiple within the threshold', () => {
    expect(snapAngle(20)).toBe(15);
    expect(snapAngle(23)).toBe(30);
    expect(snapAngle(7)).toBe(0);
    expect(snapAngle(8)).toBe(15);
    expect(snapAngle(178)).toBe(180);
  });

  it('leaves angles outside the threshold normalised but unchanged', () => {
    expect(snapAngle(45, 90, 5)).toBe(45);
    expect(snapAngle(24, 15, 2)).toBe(24);
  });

  it('returns normalised values at the wraparound boundaries', () => {
    expect(snapAngle(-178)).toBe(180);
    expect(snapAngle(180)).toBe(180);
    expect(Object.is(snapAngle(-3), 0)).toBe(true);
  });
});

describe('pointInRect / nearestRectIndex', () => {
  const rects: Rect[] = [
    { left: 0, top: 0, width: 100, height: 100 },
    { left: 200, top: 0, width: 100, height: 100 },
  ];

  it('detects points inside and outside a rect', () => {
    expect(pointInRect(50, 50, rects[0])).toBe(true);
    expect(pointInRect(150, 50, rects[0])).toBe(false);
    expect(pointInRect(0, 0, rects[0])).toBe(true);
  });

  it('returns the containing rect', () => {
    expect(nearestRectIndex(50, 50, rects)).toBe(0);
    expect(nearestRectIndex(250, 50, rects)).toBe(1);
  });

  it('returns the nearest rect centre when outside all rects', () => {
    expect(nearestRectIndex(180, 50, rects)).toBe(1);
    expect(nearestRectIndex(150, 50, rects)).toBe(0);
  });

  it('returns -1 for an empty list', () => {
    expect(nearestRectIndex(10, 10, [])).toBe(-1);
  });
});
