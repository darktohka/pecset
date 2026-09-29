import { describe, expect, it } from 'vitest';
import { computeOrder } from '@/lib/storage/signatureStore';

describe('computeOrder', () => {
  it('returns the requested order when every id exists', () => {
    expect(computeOrder(['b', 'a', 'c'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
  });

  it('filters out ids that are not persisted', () => {
    expect(computeOrder(['a', 'ghost', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('removes duplicate ids, keeping the first occurrence', () => {
    expect(computeOrder(['a', 'a', 'b', 'a'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('appends persisted ids missing from the requested order, preserving their order', () => {
    expect(computeOrder(['c'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'a', 'b', 'd']);
  });

  it('returns the existing ids unchanged for an empty requested order', () => {
    expect(computeOrder([], ['x', 'y'])).toEqual(['x', 'y']);
  });

  it('returns an empty sequence when nothing is persisted', () => {
    expect(computeOrder(['a', 'b'], [])).toEqual([]);
  });
});
