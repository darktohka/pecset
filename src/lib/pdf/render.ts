/**
 * pdf.js loading and page rasterisation helpers.
 *
 * `pdf.js` takes ownership of (and detaches) the buffer it is given, so callers
 * must hand it a copy - the original bytes are still needed for signing.
 */
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjsLib };
export type PdfDocumentProxy = pdfjsLib.PDFDocumentProxy;
export type PdfPageProxy = pdfjsLib.PDFPageProxy;

export async function openPdfDocument(bytes: Uint8Array): Promise<PdfDocumentProxy> {
  return pdfjsLib.getDocument({ data: bytes.slice() }).promise;
}

export interface RenderedViewport {
  width: number;
  height: number;
}

/** Render a 1-based page into a canvas at the given scale. */
export async function renderPageToCanvas(
  document: PdfDocumentProxy,
  pageNumber: number,
  scale: number,
  canvas: HTMLCanvasElement,
): Promise<RenderedViewport> {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable.');

  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  await page.render({
    canvas,
    canvasContext: context,
    viewport,
    transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
  }).promise;

  return { width: viewport.width, height: viewport.height };
}
