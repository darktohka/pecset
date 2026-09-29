/**
 * Document creation/modification date control.
 *
 * The Info dictionary dates are always written; the XMP packet is updated on a
 * best-effort basis because not every PDF carries one and its encoding varies.
 * XMP problems are reported as warnings and never abort signing - only a
 * failure to write the Info dates propagates.
 */
import { PDFDocument, PDFName, PDFStream } from '@cantoo/pdf-lib';

const UNSUPPORTED_FILTER_WARNING =
  'The document XMP metadata uses an unsupported filter, so its dates were left unchanged.';
const NO_DATE_FIELDS_WARNING = 'No XMP date fields were found to update.';

const XMP_DATE_NAMES = 'CreateDate|ModifyDate|MetadataDate';
const XMP_ELEMENT_RE = new RegExp(`<xmp:(${XMP_DATE_NAMES})>[^<]*</xmp:\\1>`, 'g');
const XMP_ATTRIBUTE_RE = new RegExp(`(xmp:(?:${XMP_DATE_NAMES})=")[^"]*(")`, 'g');

/**
 * Format a `Date` as XMP/ISO-8601 in local time with a numeric offset, e.g.
 * `2026-09-29T18:30:00+03:00`. The offset is derived from
 * `Date#getTimezoneOffset()` so the value matches what editors write.
 */
export function toXmpDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
  );
}

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(raw)]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Rewrite the six XMP date fields (three elements, three attributes).
 *
 * Returns the rewritten XML and whether any field matched.
 */
function rewriteXmpDates(xml: string, date: string): { xml: string; matched: boolean } {
  let matched = false;

  let next = xml.replace(XMP_ELEMENT_RE, (element) => {
    const name = /<xmp:([A-Za-z]+)>/.exec(element);
    if (!name) return element;
    matched = true;
    return `<xmp:${name[1]}>${date}</xmp:${name[1]}>`;
  });

  next = next.replace(XMP_ATTRIBUTE_RE, (_full, prefix: string, suffix: string) => {
    matched = true;
    return `${prefix}${date}${suffix}`;
  });

  return { xml: next, matched };
}

/**
 * Apply `date` to the document's Info `/CreationDate` + `/ModDate` and, on a
 * best-effort basis, to its XMP packet.
 *
 * The Info dates are always set; XMP failures are returned as warnings so the
 * caller can surface them without aborting signing.
 */
export async function applyDocumentDates(
  doc: PDFDocument,
  date: Date,
): Promise<{ xmpUpdated: boolean; warnings: string[] }> {
  doc.setCreationDate(date);
  doc.setModificationDate(date);

  const stream = doc.catalog.lookup(PDFName.of('Metadata'), PDFStream);
  if (!stream) {
    // Not every PDF carries XMP; that is not a problem worth warning about.
    return { xmpUpdated: false, warnings: [] };
  }

  const raw = stream.getContents();
  const filter = stream.dict.get(PDFName.of('Filter'));

  let decoded: Uint8Array;
  if (!filter) {
    decoded = raw;
  } else if (filter.toString() === '/FlateDecode') {
    try {
      decoded = await inflate(raw);
    } catch {
      return { xmpUpdated: false, warnings: [UNSUPPORTED_FILTER_WARNING] };
    }
  } else {
    return { xmpUpdated: false, warnings: [UNSUPPORTED_FILTER_WARNING] };
  }

  const xml = new TextDecoder('utf-8').decode(decoded);
  const result = rewriteXmpDates(xml, toXmpDate(date));
  if (!result.matched) {
    return { xmpUpdated: false, warnings: [NO_DATE_FIELDS_WARNING] };
  }

  const bytes = new TextEncoder().encode(result.xml);
  const next = doc.context.stream(bytes, { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(next));

  return { xmpUpdated: true, warnings: [] };
}
