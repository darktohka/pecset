/**
 * Signature appearance streams.
 *
 * Three flavours are produced, all as PDF form XObjects referenced from the
 * widget annotation's `/AP /N` entry:
 *
 * - `adobe`  - the Acrobat standard appearance: the reference vector mark plus a
 *              four line block reading "Digitally signed / by <name> / Date: /
 *              <time>". The signer name is auto-fitted across at most two lines
 *              (it only wraps when a single line would have to shrink too far).
 * - `image`  - a user supplied PNG/JPEG, contained inside the box.
 * - `invisible` - an empty appearance (kept because Adobe is happier with an
 *              `/AP` present, and it is required for PDF/A).
 *
 * Rotation is baked into the appearance: the box is drawn in the widget's
 * unrotated coordinate space and then rotated about its centre, while the
 * widget `/Rect` is grown to the axis aligned bounding box of the rotated box.
 *
 * Text is drawn with a standard PDF font (Helvetica / WinAnsi). That font is
 * single byte encoded, so the content stream itself must be written as bytes,
 * not as UTF-8: characters outside WinAnsi are transliterated - see
 * {@link pdfSafeText} - and the result is serialised through
 * `binaryStringToBytes` so `á` becomes the byte `0xE1` rather than the two byte
 * UTF-8 sequence `0xC3 0xA1`.
 */
import {
  PDFArray,
  PDFDocument,
  PDFFont,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  rgb,
} from "@cantoo/pdf-lib";
import type { SignaturePlacement } from "@/types";
import { binaryStringToBytes } from "../binary";
import {
  ADOBE_DETAIL_LEAD,
  ADOBE_HEIGHT,
  ADOBE_MARK_PDF,
  ADOBE_TEXT_LAYOUT,
  ADOBE_WIDTH,
  fitWrappedText,
} from "./adobeMark";

/** Literal shape accepted by `PDFContext.obj()` for a form XObject `/Resources`. */
type FormResources = Record<string, Record<string, PDFRef> | string[]>;

/* -------------------------------------------------------------------------- */
/*                              Text utilities                                 */
/* -------------------------------------------------------------------------- */

/**
 * Map characters that WinAnsi cannot encode onto close equivalents so names in
 * Hungarian, Romanian, Polish, … stay readable with the standard fonts.
 * Anything still unmapped becomes `?`.
 */
const TRANSLITERATION: Record<string, string> = {
  ő: "ö",
  Ő: "Ö",
  ű: "ü",
  Ű: "Ü",
  ș: "ş",
  Ș: "Ş",
  ț: "ţ",
  Ț: "Ţ",
  Ł: "L",
  ł: "l",
  Ą: "A",
  ą: "a",
  Ę: "E",
  ę: "e",
  Ś: "S",
  ś: "s",
  Ź: "Z",
  ź: "z",
  Ż: "Z",
  ż: "z",
  Ć: "C",
  ć: "c",
  Ń: "N",
  ń: "n",
  Ě: "E",
  ě: "e",
  Ř: "R",
  ř: "r",
  Ů: "U",
  ů: "u",
  Ň: "N",
  ň: "n",
  Ľ: "L",
  ľ: "l",
  Ď: "D",
  ď: "d",
  Ť: "T",
  ť: "t",
  "–": "-",
  "-": "-",
  "’": "'",
  "‘": "'",
  "“": '"',
  "”": '"',
  "…": "...",
  "\u00a0": " ",
};

/** Make a string safe for a WinAnsi encoded standard font. */
export function pdfSafeText(input: string): string {
  let out = "";
  for (const char of input) {
    if (TRANSLITERATION[char] !== undefined) {
      out += TRANSLITERATION[char];
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    // Printable ASCII + Latin-1 supplement are encodable in WinAnsi.
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += char;
    } else if (char === "\n" || char === "\r" || char === "\t") {
      out += " ";
    } else {
      out += "?";
    }
  }
  return out;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** `2025.09.26` - matches the reference appearance. */
export function formatAppearanceDate(date: Date): string {
  return `${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`;
}

/** `07:04:05 +03'00'` - matches the reference appearance (PDF offset syntax). */
export function formatAppearanceTime(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const tz = `${sign}${pad2(Math.floor(abs / 60))}'${pad2(abs % 60)}'`;
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${tz}`;
}

/** PDF literal string escaping. */
function pdfLiteral(text: string): string {
  return text.replace(/([\\()])/g, "\\$1");
}

function measure(font: PDFFont, text: string, size: number): number {
  return font.widthOfTextAtSize(text, size);
}

/** Largest font size (≤ `desired`) at which `text` fits into `maxWidth`. */
function fitSize(
  font: PDFFont,
  text: string,
  maxWidth: number,
  desired: number,
): number {
  if (text.length === 0) return desired;
  const width = measure(font, text, desired);
  if (width <= maxWidth) return desired;
  return Math.max(1, (maxWidth / width) * desired);
}

/* -------------------------------------------------------------------------- */
/*                                  Geometry                                   */
/* -------------------------------------------------------------------------- */

export interface BoundingBox {
  width: number;
  height: number;
}

/** Axis aligned bounding box of a `width × height` rectangle rotated by `deg`. */
export function rotatedBounds(
  width: number,
  height: number,
  deg: number,
): BoundingBox {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return {
    width: width * cos + height * sin,
    height: width * sin + height * cos,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Content builders                               */
/* -------------------------------------------------------------------------- */

/** The Acrobat-style appearance, drawn in design space. */
function adobeContent(font: PDFFont, signerName: string, date: Date): string {
  const safeName = pdfSafeText(signerName) || "Unknown signer";
  const { name, label, ascent, descent, centreY } = ADOBE_TEXT_LAYOUT;

  // Fit the name over at most two lines, then centre the whole block in the box
  // (the reference's own two-line block sits at ≈16.9 at 10.2pt).
  const nameLayout = fitWrappedText(
    safeName,
    name.maxWidth,
    name.fontSize,
    name.maxLines,
    (text, size) => measure(font, text, size),
  );
  const nameSize = nameLayout.size;
  const leading = nameSize * 1.2;
  const blockHeight =
    ascent * nameSize +
    (nameLayout.lines.length - 1) * leading +
    descent * nameSize;
  const firstBaseline = centreY + blockHeight / 2 - ascent * nameSize;

  const labelLines = [
    ADOBE_DETAIL_LEAD,
    `by ${safeName}`,
    `Date: ${formatAppearanceDate(date)}`,
    formatAppearanceTime(date),
  ];
  const labelSize = Math.min(
    label.fontSize,
    ...labelLines.map((line) =>
      fitSize(font, line, label.maxWidth, label.fontSize),
    ),
  );

  const parts: string[] = [ADOBE_MARK_PDF];
  parts.push("q", `${name.clip.join(" ")} re W* n`);
  parts.push("BT", "0 g", `/F0 ${nameSize.toFixed(4)} Tf`);
  parts.push(`${name.x} ${firstBaseline.toFixed(4)} Td`);
  nameLayout.lines.forEach((line, index) => {
    if (index > 0) parts.push(`0 ${(-leading).toFixed(4)} Td`);
    parts.push(`(${pdfLiteral(line)}) Tj`);
  });
  parts.push("ET", "Q");

  parts.push("q", `${label.clip.join(" ")} re W* n`);
  parts.push("BT", "0 g", `/F0 ${labelSize.toFixed(4)} Tf`);
  parts.push(`${label.x} ${label.firstBaseline} Td`);
  labelLines.forEach((line, index) => {
    if (index > 0)
      parts.push(`0 ${(-labelSize * label.lineHeight).toFixed(4)} Td`);
    parts.push(`(${pdfLiteral(line)}) Tj`);
  });
  parts.push("ET", "Q");

  return parts.join("\n");
}

/* -------------------------------------------------------------------------- */
/*                             Appearance builder                              */
/* -------------------------------------------------------------------------- */

export interface BuiltAppearance {
  /** Form XObject reference to hang off `/AP /N`. */
  ref: PDFRef;
  /** Widget `/Rect`, already grown to the rotated bounding box. */
  rect: [number, number, number, number];
}

interface BuildInput {
  doc: PDFDocument;
  font: PDFFont;
  placement: SignaturePlacement;
  signerName: string;
  date: Date;
  imageBytes?: Uint8Array;
  imageMime?: string;
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Unsupported image data URL.");
  const mime = match[1];
  const isBase64 = Boolean(match[2]);
  const payload = match[3];
  if (isBase64) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { bytes, mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime };
}

function registerForm(
  doc: PDFDocument,
  bbox: [number, number, number, number],
  content: string,
  resources: FormResources,
): PDFRef {
  const dict = doc.context.obj({
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: bbox,
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: resources,
  });
  const stream = PDFRawStream.of(dict, binaryStringToBytes(content));
  return doc.context.register(stream);
}

/**
 * Build the `/AP` appearance for a placement and return the reference plus the
 * widget rectangle it must be attached to.
 */
export async function buildAppearance(
  input: BuildInput,
): Promise<BuiltAppearance> {
  const { doc, font, placement, signerName, date } = input;
  const w = Math.max(1, placement.width);
  const h = Math.max(1, placement.height);
  const bounds = rotatedBounds(w, h, placement.rotation);

  let innerContent: string;
  let resources: FormResources;

  if (placement.kind === "image" && placement.imageDataUrl) {
    const { bytes, mime } = dataUrlToBytes(placement.imageDataUrl);
    const image = mime.includes("png")
      ? await doc.embedPng(bytes)
      : await doc.embedJpg(bytes);
    const scale = Math.min(w / image.width, h / image.height);
    const drawW = image.width * scale;
    const drawH = image.height * scale;
    const dx = (w - drawW) / 2;
    const dy = (h - drawH) / 2;
    innerContent = [
      "q",
      `${drawW.toFixed(4)} 0 0 ${drawH.toFixed(4)} ${dx.toFixed(4)} ${dy.toFixed(4)} cm`,
      "/Img Do",
      "Q",
    ].join("\n");
    resources = { XObject: { Img: image.ref } };
  } else if (placement.kind === "invisible") {
    innerContent = "";
    resources = {};
  } else {
    // Adobe-style appearance, contain-fitted into the box.
    const scale = Math.min(w / ADOBE_WIDTH, h / ADOBE_HEIGHT);
    const offsetX = (w - ADOBE_WIDTH * scale) / 2;
    const offsetY = (h - ADOBE_HEIGHT * scale) / 2;
    innerContent = [
      "q",
      `${scale.toFixed(6)} 0 0 ${scale.toFixed(6)} ${offsetX.toFixed(4)} ${offsetY.toFixed(4)} cm`,
      adobeContent(font, signerName, date),
      "Q",
    ].join("\n");
    resources = { Font: { F0: font.ref }, ProcSet: ["PDF", "Text"] };
  }

  let ref: PDFRef;
  if (placement.rotation % 360 === 0) {
    ref = registerForm(doc, [0, 0, w, h], innerContent, resources);
  } else {
    // Wrap the un-rotated appearance in a rotating parent form.
    const innerRef = registerForm(doc, [0, 0, w, h], innerContent, resources);
    const rad = (placement.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const wrapperContent = [
      "q",
      `1 0 0 1 ${(bounds.width / 2).toFixed(4)} ${(bounds.height / 2).toFixed(4)} cm`,
      `${cos.toFixed(6)} ${sin.toFixed(6)} ${(-sin).toFixed(6)} ${cos.toFixed(6)} 0 0 cm`,
      `1 0 0 1 ${(-w / 2).toFixed(4)} ${(-h / 2).toFixed(4)} cm`,
      "/Inner Do",
      "Q",
    ].join("\n");
    ref = registerForm(
      doc,
      [0, 0, bounds.width, bounds.height],
      wrapperContent,
      {
        XObject: { Inner: innerRef },
      },
    );
  }

  const rect: [number, number, number, number] = [
    placement.cx - bounds.width / 2,
    placement.cy - bounds.height / 2,
    placement.cx + bounds.width / 2,
    placement.cy + bounds.height / 2,
  ];
  return { ref, rect };
}

/** Standard font used for appearances. */
export async function loadAppearanceFont(doc: PDFDocument): Promise<PDFFont> {
  return doc.embedFont(StandardFonts.Helvetica);
}

/** Convenience: build a colour for future use (kept for parity with Acrobat). */
export const APPEARANCE_TEXT_COLOR = rgb(0, 0, 0);

/** Re-exported so callers can build `PDFArray` based rects without extra imports. */
export { PDFArray, PDFName, PDFNumber };
