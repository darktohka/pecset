import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import { applyDocumentDates, toXmpDate } from '@/lib/pdf/documentDates';
import { createDummyPdfBytes } from './helpers/dummyFixtures';

const TARGET = new Date('2020-01-02T03:04:05Z');

let bytes: Uint8Array;

beforeAll(async () => {
  bytes = await createDummyPdfBytes();
});

describe('toXmpDate', () => {
  it('formats local time with a numeric offset', () => {
    expect(toXmpDate(TARGET)).toMatch(/^2020-01-02T\d{2}:\d{2}:05[+-]\d{2}:\d{2}$/);
  });
});

describe('applyDocumentDates', () => {
  it('writes the Info dates and rewrites the XMP dates', async () => {
    const doc = await PDFDocument.load(bytes, {
      forIncrementalUpdate: true,
      updateMetadata: false,
    });

    const result = await applyDocumentDates(doc, TARGET);

    const creation = doc.getCreationDate();
    const modification = doc.getModificationDate();
    if (!creation || !modification) throw new Error('expected Info dates to be set');
    expect(creation.toISOString()).toBe('2020-01-02T03:04:05.000Z');
    expect(modification.toISOString()).toBe('2020-01-02T03:04:05.000Z');
    expect(result.xmpUpdated).toBe(true);
    expect(result.warnings).toEqual([]);

    const saved = await doc.save();
    expect(saved.length).toBeGreaterThan(bytes.length);
  });
});
