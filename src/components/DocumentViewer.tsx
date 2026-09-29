import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import {
  openPdfDocument,
  renderPageToCanvas,
  type PdfDocumentProxy,
} from '@/lib/pdf/render';
import {
  formatAppearanceDate,
  formatAppearanceTime,
  pdfSafeText,
} from '@/lib/pdf/appearance';
import {
  ADOBE_DETAIL_LEAD,
  ADOBE_HEIGHT,
  ADOBE_MARK_FILL,
  ADOBE_MARK_SVG_PATH,
  ADOBE_TEXT_LAYOUT,
  ADOBE_WIDTH,
  fitWrappedText,
} from '@/lib/pdf/adobeMark';
import {
  certificateDisplayName,
  setPlacementAnchorProvider,
  useAppStore,
} from '@/state/useAppStore';
import type { PlacementAnchor } from '@/state/placement';
import type {
  DummySigner,
  SignaturePlacement,
  SignerInfo,
  SignerRef,
  StoredCertificate,
} from '@/types';
import {
  nearestRectIndex,
  resizeBox,
  rotationFromPointer,
  snapAngle,
  type Rect,
} from '@/components/viewer/geometry';

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const DEFAULT_SCALE = 1.1;
const SCALE_STEP = 0.1;
const DRAG_THRESHOLD = 3;
const SCROLL_EDGE = 64;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScale(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundAngle(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Advance widths measured from the browser's own Helvetica/Arial stack, which
 * tracks the standard PDF font closely enough that the preview and the signed
 * PDF agree to well under a point.
 */
let measureContext: CanvasRenderingContext2D | null | undefined;

function measureHelvetica(text: string, size: number): number {
  if (measureContext === undefined) {
    measureContext = document.createElement('canvas').getContext('2d');
  }
  if (!measureContext) return text.length * size * 0.5; // non-browser fallback
  measureContext.font = `${size}px Helvetica, Arial, sans-serif`;
  return measureContext.measureText(text).width;
}

/** Largest size <= `desired` at which `text` fits `maxWidth`. */
function fitHelvetica(text: string, maxWidth: number, desired: number): number {
  if (text.length === 0) return desired;
  const width = measureHelvetica(text, desired);
  if (width <= maxWidth) return desired;
  return Math.max(1, (maxWidth / width) * desired);
}

interface ResolvedSigner {
  name: string;
  dummy: boolean;
}

const UNKNOWN_SIGNER: ResolvedSigner = { name: 'Unknown signer', dummy: false };

/**
 * A placement remembers the signer it was added under and falls back to the
 * active one, so one document can mix certificate and dummy signers. A dummy
 * has no unlocked identity, so its name comes from the saved `DummySigner`.
 */
function resolveSigner(
  signer: SignerRef | null,
  dummySigners: DummySigner[],
  certificates: StoredCertificate[],
  unlockedBy: Record<string, SignerInfo>,
): ResolvedSigner {
  if (!signer) return UNKNOWN_SIGNER;
  if (signer.type === 'dummy') {
    return {
      name:
        dummySigners.find((entry) => entry.id === signer.id)?.name ??
        'Dummy signature',
      dummy: true,
    };
  }
  // The drawing uses the certificate's presentation name (override when set),
  // exactly like the PDF engine, and only falls back to the true identity when
  // the stored record is missing.
  const certificate = certificates.find((entry) => entry.id === signer.id);
  return {
    name:
      (certificate ? certificateDisplayName(certificate) : undefined) ??
      unlockedBy[signer.id]?.commonName ??
      certificate?.label ??
      'Unknown signer',
    dummy: false,
  };
}

interface AdobeAppearancePreviewProps {
  signerName: string;
  date: Date;
}

function AdobeAppearancePreview({
  signerName,
  date,
}: AdobeAppearancePreviewProps) {
  const uid = useId();
  const safeName = pdfSafeText(signerName) || 'Unknown signer';
  const { name, label, ascent, descent, centreY } = ADOBE_TEXT_LAYOUT;

  const nameLayout = fitWrappedText(
    safeName,
    name.maxWidth,
    name.fontSize,
    name.maxLines,
    measureHelvetica,
  );
  const nameSize = nameLayout.size;
  const nameLeading = nameSize * 1.2;
  const nameBlockHeight =
    ascent * nameSize +
    (nameLayout.lines.length - 1) * nameLeading +
    descent * nameSize;
  const nameFirstBaseline = centreY + nameBlockHeight / 2 - ascent * nameSize;

  const labelLines = [
    ADOBE_DETAIL_LEAD,
    `by ${safeName}`,
    `Date: ${formatAppearanceDate(date)}`,
    formatAppearanceTime(date),
  ];
  const labelSize = Math.min(
    label.fontSize,
    ...labelLines.map((line) =>
      fitHelvetica(line, label.maxWidth, label.fontSize),
    ),
  );

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${ADOBE_WIDTH} ${ADOBE_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        <clipPath id={`${uid}-name`}>
          <rect
            x={name.clip[0]}
            y={ADOBE_HEIGHT - name.clip[1] - name.clip[3]}
            width={name.clip[2]}
            height={name.clip[3]}
          />
        </clipPath>
        <clipPath id={`${uid}-label`}>
          <rect
            x={label.clip[0]}
            y={ADOBE_HEIGHT - label.clip[1] - label.clip[3]}
            width={label.clip[2]}
            height={label.clip[3]}
          />
        </clipPath>
      </defs>
      <path d={ADOBE_MARK_SVG_PATH} fill={ADOBE_MARK_FILL} />
      <g clipPath={`url(#${uid}-name)`}>
        {nameLayout.lines.map((line, index) => (
          <text
            key={line}
            x={name.x}
            y={ADOBE_HEIGHT - (nameFirstBaseline - index * nameLeading)}
            fontSize={nameSize}
            fontFamily="Helvetica, Arial, sans-serif"
            fill="#000000"
          >
            {line}
          </text>
        ))}
      </g>
      <g clipPath={`url(#${uid}-label)`}>
        {labelLines.map((line, index) => (
          <text
            key={line}
            x={label.x}
            y={
              ADOBE_HEIGHT -
              (label.firstBaseline - index * labelSize * label.lineHeight)
            }
            fontSize={labelSize}
            fontFamily="Helvetica, Arial, sans-serif"
            fill="#000000"
          >
            {line}
          </text>
        ))}
      </g>
    </svg>
  );
}

function ImageAppearancePreview({ dataUrl }: { dataUrl?: string }) {
  if (!dataUrl) {
    return (
      <div className="pointer-events-none flex h-full w-full items-center justify-center text-[10px] font-semibold uppercase tracking-wide text-ink-400">
        No image
      </div>
    );
  }
  return (
    <img
      src={dataUrl}
      className="pointer-events-none h-full w-full object-contain"
      draggable={false}
      alt=""
    />
  );
}

type HandleName = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface HandleVector {
  hx: -1 | 0 | 1;
  hy: -1 | 0 | 1;
}

const RESIZE_HANDLES: readonly HandleName[] = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
];

const HANDLE_VECTORS: Record<HandleName, HandleVector> = {
  nw: { hx: -1, hy: -1 },
  n: { hx: 0, hy: -1 },
  ne: { hx: 1, hy: -1 },
  e: { hx: 1, hy: 0 },
  se: { hx: 1, hy: 1 },
  s: { hx: 0, hy: 1 },
  sw: { hx: -1, hy: 1 },
  w: { hx: -1, hy: 0 },
};

/** Live box geometry in PDF user space, used for the gesture preview. */
interface LiveGeometry {
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotation: number;
}

interface PlacementOverlayProps {
  placement: SignaturePlacement;
  viewport: PageViewport;
  scale: number;
  selected: boolean;
  hidden: boolean;
  preview: LiveGeometry | null;
  signer: ResolvedSigner;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizePointerDown: (
    handle: HandleName,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  onRotatePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

function PlacementOverlay({
  placement,
  viewport,
  scale,
  selected,
  hidden,
  preview,
  signer,
  onBodyPointerDown,
  onResizePointerDown,
  onRotatePointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: PlacementOverlayProps) {
  const previewDate = useMemo(() => new Date(), []);
  const geometry = preview ?? placement;

  const [centerX, centerY] = viewport.convertToViewportPoint(
    geometry.cx,
    geometry.cy,
  ) as [number, number];
  const screenWidth = geometry.width * scale;
  const screenHeight = geometry.height * scale;
  const baseTransform = `translate(-50%, -50%) rotate(${geometry.rotation}deg)`;

  return (
    <div
      className={`group absolute select-none ${hidden ? 'opacity-0' : 'cursor-move'}`}
      style={{
        left: centerX,
        top: centerY,
        width: screenWidth,
        height: screenHeight,
        transform: baseTransform,
        outline: selected
          ? '2px solid var(--color-accent-500)'
          : '1px dashed var(--color-ink-400)',
        outlineOffset: 1,
      }}
      onPointerDown={onBodyPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {placement.kind === 'image' ? (
        <ImageAppearancePreview dataUrl={placement.imageDataUrl} />
      ) : (
        <AdobeAppearancePreview
          signerName={signer.name}
          date={previewDate}
        />
      )}

      <div className="pointer-events-none absolute -left-3 -top-3 flex h-6 w-6 items-center justify-center rounded-full border border-ink-200 bg-white text-[10px] font-semibold text-ink-600 shadow-sm">
        {placement.pageIndex + 1}
      </div>

      <div
        className={`pointer-events-none absolute -bottom-6 left-0 whitespace-nowrap rounded bg-ink-900/85 px-1.5 py-0.5 text-[10px] font-medium capitalize text-white transition-opacity ${
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        {signer.dummy ? 'Dummy · ' : ''}
        {placement.kind} · page {placement.pageIndex + 1}
      </div>

      {selected && (
        <>
          {RESIZE_HANDLES.map((handle) => {
            const { hx, hy } = HANDLE_VECTORS[handle];
            return (
              <div
                key={handle}
                onPointerDown={(event) => onResizePointerDown(handle, event)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                className="absolute z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-accent-500 shadow"
                style={{ left: `${50 + hx * 50}%`, top: `${50 + hy * 50}%` }}
              />
            );
          })}

          <div className="pointer-events-none absolute left-1/2 top-0 h-7 w-px -translate-x-1/2 -translate-y-full bg-accent-500" />
          <div
            onPointerDown={onRotatePointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            className="absolute z-10 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full border border-accent-500 bg-white shadow"
            style={{ left: '50%', top: '-28px' }}
            title="Rotate signature"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3 w-3 text-accent-600"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                d="M21 12a9 9 0 1 1-3-6.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M21 3v6h-6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </>
      )}
    </div>
  );
}

interface PageCanvasProps {
  doc: PdfDocumentProxy;
  pageIndex: number;
  scale: number;
  viewport: PageViewport | null;
  placements: SignaturePlacement[];
  selectedId: string | null;
  previewId: string | null;
  preview: LiveGeometry | null;
  hiddenId: string | null;
  highlighted: boolean;
  signerById: Map<string, ResolvedSigner>;
  registerPageElement: (index: number, element: HTMLElement | null) => void;
  onSelect: (id: string | null) => void;
  onBodyPointerDown: (
    placement: SignaturePlacement,
    viewport: PageViewport,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  onResizePointerDown: (
    placement: SignaturePlacement,
    viewport: PageViewport,
    handle: HandleName,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  onRotatePointerDown: (
    placement: SignaturePlacement,
    viewport: PageViewport,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  onGestureMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onGestureEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onGestureCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

function PageCanvas({
  doc,
  pageIndex,
  scale,
  viewport,
  placements,
  selectedId,
  previewId,
  preview,
  hiddenId,
  highlighted,
  signerById,
  registerPageElement,
  onSelect,
  onBodyPointerDown,
  onResizePointerDown,
  onRotatePointerDown,
  onGestureMove,
  onGestureEnd,
  onGestureCancel,
}: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    const pageNumber = pageIndex + 1;

    const previous = renderChainRef.current.catch(() => {});
    renderChainRef.current = previous.then(async () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        await renderPageToCanvas(doc, pageNumber, scale, canvas);
      } catch {
        return;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [doc, pageIndex, scale]);

  const pagePlacements = placements.filter(
    (item) => item.pageIndex === pageIndex && item.kind !== 'invisible',
  );

  return (
    <figure className="flex flex-col items-center">
      <div
        ref={(element) => registerPageElement(pageIndex, element)}
        data-page-index={pageIndex}
        className={`relative bg-white shadow-[0_10px_30px_-12px_rgba(20,23,29,0.35)] ${
          highlighted
            ? 'ring-2 ring-accent-500 ring-offset-2 ring-offset-ink-100'
            : ''
        }`}
        style={{ width: viewport?.width, height: viewport?.height }}
      >
        <canvas
          ref={canvasRef}
          className="block"
          onPointerDown={() => onSelect(null)}
        />
        {viewport &&
          pagePlacements.map((placement) => (
            <PlacementOverlay
              key={placement.id}
              placement={placement}
              viewport={viewport}
              scale={scale}
              selected={placement.id === selectedId}
              hidden={placement.id === hiddenId}
              preview={previewId === placement.id ? preview : null}
              signer={signerById.get(placement.id) ?? UNKNOWN_SIGNER}
              onBodyPointerDown={(event) =>
                onBodyPointerDown(placement, viewport, event)
              }
              onResizePointerDown={(handle, event) =>
                onResizePointerDown(placement, viewport, handle, event)
              }
              onRotatePointerDown={(event) =>
                onRotatePointerDown(placement, viewport, event)
              }
              onPointerMove={onGestureMove}
              onPointerUp={onGestureEnd}
              onPointerCancel={onGestureCancel}
            />
          ))}
      </div>
      <figcaption className="mt-3 text-xs font-medium text-ink-500">
        Page {pageIndex + 1}
      </figcaption>
    </figure>
  );
}

interface DragGesture {
  mode: 'drag';
  id: string;
  pageIndex: number;
  width: number;
  height: number;
  rotation: number;
  startClient: { x: number; y: number };
  originClient: { x: number; y: number };
  client: { x: number; y: number };
  moved: boolean;
  dropPageIndex: number;
}

interface ResizeGesture {
  mode: 'resize';
  id: string;
  handle: HandleName;
  viewport: PageViewport;
  startClient: { x: number; y: number };
  viewCenter: { x: number; y: number };
  viewWidth: number;
  viewHeight: number;
  rotation: number;
  preview: LiveGeometry;
}

interface RotateGesture {
  mode: 'rotate';
  id: string;
  centerClient: { x: number; y: number };
  preview: LiveGeometry;
}

type Gesture = DragGesture | ResizeGesture | RotateGesture;

function dragGhostPosition(gesture: DragGesture): { x: number; y: number } {
  return {
    x: gesture.originClient.x + (gesture.client.x - gesture.startClient.x),
    y: gesture.originClient.y + (gesture.client.y - gesture.startClient.y),
  };
}

export function DocumentViewer() {
  const pdfBytes = useAppStore((state) => state.pdfBytes);
  const inspection = useAppStore((state) => state.inspection);
  const placements = useAppStore((state) => state.placements);
  const selectedPlacementId = useAppStore((state) => state.selectedPlacementId);
  const updatePlacement = useAppStore((state) => state.updatePlacement);
  const removePlacement = useAppStore((state) => state.removePlacement);
  const selectPlacement = useAppStore((state) => state.selectPlacement);
  const movePlacementToPage = useAppStore((state) => state.movePlacementToPage);
  const activeSigner = useAppStore((state) => state.activeSigner);
  const dummySigners = useAppStore((state) => state.dummySigners);
  const certificates = useAppStore((state) => state.certificates);
  const unlockedBy = useAppStore((state) => state.unlockedBy);

  const signerById = useMemo(() => {
    const resolved = new Map<string, ResolvedSigner>();
    for (const placement of placements) {
      resolved.set(
        placement.id,
        resolveSigner(
          placement.signer ?? activeSigner,
          dummySigners,
          certificates,
          unlockedBy,
        ),
      );
    }
    return resolved;
  }, [placements, activeSigner, dummySigners, certificates, unlockedBy]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageElementsRef = useRef<Map<number, HTMLElement>>(new Map());
  const gestureRef = useRef<Gesture | null>(null);
  const dragPointerRef = useRef<{ x: number; y: number } | null>(null);

  const [doc, setDoc] = useState<PdfDocumentProxy | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [pageViewports, setPageViewports] = useState<(PageViewport | null)[]>(
    [],
  );
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const previewDate = useMemo(() => new Date(), []);

  const pageCount = inspection?.pageCount ?? 0;

  const registerPageElement = useCallback(
    (index: number, element: HTMLElement | null) => {
      if (element) pageElementsRef.current.set(index, element);
      else pageElementsRef.current.delete(index);
    },
    [],
  );

  const computePlacementAnchor = useCallback((): PlacementAnchor | null => {
    const container = scrollRef.current;
    if (!container) return null;
    const rects: Rect[] = [];
    const indices: number[] = [];
    pageElementsRef.current.forEach((element, index) => {
      if (!pageViewports[index]) return;
      const bounds = element.getBoundingClientRect();
      rects.push({
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      });
      indices.push(index);
    });
    if (rects.length === 0) return null;
    const containerBounds = container.getBoundingClientRect();
    const pointX = containerBounds.left + containerBounds.width / 2;
    const pointY = containerBounds.top + containerBounds.height / 2;
    const found = nearestRectIndex(pointX, pointY, rects);
    if (found === -1) return null;
    const pageIndex = indices[found];
    const viewport = pageViewports[pageIndex];
    if (!viewport) return null;
    const rect = rects[found];
    const clampedX = clamp(pointX, rect.left, rect.left + rect.width);
    const clampedY = clamp(pointY, rect.top, rect.top + rect.height);
    const [cx, cy] = viewport.convertToPdfPoint(
      clampedX - rect.left,
      clampedY - rect.top,
    ) as [number, number];
    return { pageIndex, cx, cy };
  }, [pageViewports]);

  useEffect(() => {
    setPlacementAnchorProvider(computePlacementAnchor);
    return () => setPlacementAnchorProvider(null);
  }, [computePlacementAnchor]);

  useEffect(() => {
    if (!pdfBytes) return;
    let cancelled = false;
    let loadedDoc: PdfDocumentProxy | null = null;
    setStatus('loading');
    setDoc(null);

    openPdfDocument(pdfBytes)
      .then((loaded) => {
        if (cancelled) {
          void loaded.cleanup();
          return;
        }
        loadedDoc = loaded;
        setDoc(loaded);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
      if (loadedDoc) void loadedDoc.cleanup();
    };
  }, [pdfBytes]);

  useEffect(() => {
    if (!doc || pageCount === 0) {
      setPageViewports([]);
      return;
    }
    let cancelled = false;
    void Promise.all(
      Array.from({ length: pageCount }, (_, index) =>
        doc.getPage(index + 1).then((page) => page.getViewport({ scale })),
      ),
    )
      .then((viewports) => {
        if (!cancelled) setPageViewports(viewports);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [doc, scale, pageCount]);

  useEffect(() => {
    if (!selectedPlacementId) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      removePlacement(selectedPlacementId);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedPlacementId, removePlacement]);

  const dragActive = gesture?.mode === 'drag' && gesture.moved;

  useEffect(() => {
    if (!dragActive) return;
    let frame = 0;
    const tick = () => {
      const container = scrollRef.current;
      const pointer = dragPointerRef.current;
      if (container && pointer) {
        const bounds = container.getBoundingClientRect();
        if (pointer.y < bounds.top + SCROLL_EDGE) {
          container.scrollTop -= Math.ceil(
            (bounds.top + SCROLL_EDGE - pointer.y) / 4,
          );
        } else if (pointer.y > bounds.bottom - SCROLL_EDGE) {
          container.scrollTop += Math.ceil(
            (pointer.y - (bounds.bottom - SCROLL_EDGE)) / 4,
          );
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragActive]);

  const hitTestPage = (x: number, y: number, fallback: number): number => {
    const rects: Rect[] = [];
    const indices: number[] = [];
    pageElementsRef.current.forEach((element, index) => {
      if (!pageViewports[index]) return;
      const bounds = element.getBoundingClientRect();
      rects.push({
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      });
      indices.push(index);
    });
    const found = nearestRectIndex(x, y, rects);
    return found === -1 ? fallback : indices[found];
  };

  const beginDrag = (
    placement: SignaturePlacement,
    viewport: PageViewport,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectPlacement(placement.id);

    const [viewX, viewY] = viewport.convertToViewportPoint(
      placement.cx,
      placement.cy,
    ) as [number, number];
    const pageElement = pageElementsRef.current.get(placement.pageIndex);
    const bounds = pageElement?.getBoundingClientRect();
    const next: DragGesture = {
      mode: 'drag',
      id: placement.id,
      pageIndex: placement.pageIndex,
      width: placement.width,
      height: placement.height,
      rotation: placement.rotation,
      startClient: { x: event.clientX, y: event.clientY },
      originClient: {
        x: (bounds?.left ?? 0) + viewX,
        y: (bounds?.top ?? 0) + viewY,
      },
      client: { x: event.clientX, y: event.clientY },
      moved: false,
      dropPageIndex: placement.pageIndex,
    };
    gestureRef.current = next;
    dragPointerRef.current = { x: event.clientX, y: event.clientY };
    setGesture(next);
  };

  const beginResize = (
    placement: SignaturePlacement,
    viewport: PageViewport,
    handle: HandleName,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectPlacement(placement.id);

    const [viewX, viewY] = viewport.convertToViewportPoint(
      placement.cx,
      placement.cy,
    ) as [number, number];
    const origin: LiveGeometry = {
      cx: placement.cx,
      cy: placement.cy,
      width: placement.width,
      height: placement.height,
      rotation: placement.rotation,
    };
    const next: ResizeGesture = {
      mode: 'resize',
      id: placement.id,
      handle,
      viewport,
      startClient: { x: event.clientX, y: event.clientY },
      viewCenter: { x: viewX, y: viewY },
      viewWidth: placement.width * scale,
      viewHeight: placement.height * scale,
      rotation: placement.rotation,
      preview: origin,
    };
    gestureRef.current = next;
    setGesture(next);
  };

  const beginRotate = (
    placement: SignaturePlacement,
    viewport: PageViewport,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectPlacement(placement.id);

    const [viewX, viewY] = viewport.convertToViewportPoint(
      placement.cx,
      placement.cy,
    ) as [number, number];
    const pageElement = pageElementsRef.current.get(placement.pageIndex);
    const bounds = pageElement?.getBoundingClientRect();
    const centerClient = {
      x: (bounds?.left ?? 0) + viewX,
      y: (bounds?.top ?? 0) + viewY,
    };
    const raw = rotationFromPointer(
      centerClient.x,
      centerClient.y,
      event.clientX,
      event.clientY,
    );
    const rotation = event.shiftKey ? snapAngle(raw) : roundAngle(raw);
    const next: RotateGesture = {
      mode: 'rotate',
      id: placement.id,
      centerClient,
      preview: {
        cx: placement.cx,
        cy: placement.cy,
        width: placement.width,
        height: placement.height,
        rotation,
      },
    };
    gestureRef.current = next;
    setGesture(next);
  };

  const commitDrop = (current: DragGesture) => {
    const targetIndex = current.dropPageIndex;
    const viewport = pageViewports[targetIndex];
    const pageElement = pageElementsRef.current.get(targetIndex);
    if (!viewport || !pageElement) return;
    const ghost = dragGhostPosition(current);
    const bounds = pageElement.getBoundingClientRect();
    const [pdfX, pdfY] = viewport.convertToPdfPoint(
      ghost.x - bounds.left,
      ghost.y - bounds.top,
    ) as [number, number];
    movePlacementToPage(current.id, targetIndex);
    updatePlacement(current.id, { cx: pdfX, cy: pdfY });
    selectPlacement(current.id);
  };

  const handleGestureMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gestureRef.current;
    if (!current) return;
    event.stopPropagation();

    if (current.mode === 'drag') {
      const client = { x: event.clientX, y: event.clientY };
      const moved =
        current.moved ||
        Math.hypot(
          client.x - current.startClient.x,
          client.y - current.startClient.y,
        ) >= DRAG_THRESHOLD;
      dragPointerRef.current = client;
      const next: DragGesture = {
        ...current,
        client,
        moved,
        dropPageIndex: moved
          ? hitTestPage(
              current.originClient.x + (client.x - current.startClient.x),
              current.originClient.y + (client.y - current.startClient.y),
              current.dropPageIndex,
            )
          : current.pageIndex,
      };
      gestureRef.current = next;
      setGesture(next);
      return;
    }

    if (current.mode === 'resize') {
      const { hx, hy } = HANDLE_VECTORS[current.handle];
      const result = resizeBox({
        dx: event.clientX - current.startClient.x,
        dy: event.clientY - current.startClient.y,
        hx,
        hy,
        cx: current.viewCenter.x,
        cy: current.viewCenter.y,
        width: current.viewWidth,
        height: current.viewHeight,
        rotation: current.rotation,
      });
      const [pdfX, pdfY] = current.viewport.convertToPdfPoint(
        result.cx,
        result.cy,
      ) as [number, number];
      const next: ResizeGesture = {
        ...current,
        preview: {
          cx: pdfX,
          cy: pdfY,
          width: result.width / scale,
          height: result.height / scale,
          rotation: current.rotation,
        },
      };
      gestureRef.current = next;
      setGesture(next);
      return;
    }

    const raw = rotationFromPointer(
      current.centerClient.x,
      current.centerClient.y,
      event.clientX,
      event.clientY,
    );
    const rotation = event.shiftKey ? snapAngle(raw) : roundAngle(raw);
    const next: RotateGesture = {
      ...current,
      preview: { ...current.preview, rotation },
    };
    gestureRef.current = next;
    setGesture(next);
  };

  const clearGesture = () => {
    gestureRef.current = null;
    dragPointerRef.current = null;
    setGesture(null);
  };

  const handleGestureEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gestureRef.current;
    if (!current) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearGesture();

    if (current.mode === 'drag') {
      if (current.moved) commitDrop(current);
      else selectPlacement(current.id);
      return;
    }
    if (current.mode === 'resize') {
      updatePlacement(current.id, {
        cx: current.preview.cx,
        cy: current.preview.cy,
        width: current.preview.width,
        height: current.preview.height,
      });
      return;
    }
    updatePlacement(current.id, { rotation: current.preview.rotation });
  };

  const handleGestureCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!gestureRef.current) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearGesture();
  };

  const zoomBy = (delta: number) => {
    setScale((current) =>
      roundScale(clamp(current + delta, MIN_SCALE, MAX_SCALE)),
    );
  };

  const fitWidth = () => {
    const container = scrollRef.current;
    const first = inspection?.pages[0];
    if (!container || !first) return;
    const pageWidth = first.rotation % 180 === 0 ? first.width : first.height;
    if (pageWidth <= 0) return;
    const available = container.clientWidth - 48;
    setScale(roundScale(clamp(available / pageWidth, MIN_SCALE, MAX_SCALE)));
  };

  const gesturePreview =
    gesture && gesture.mode !== 'drag' ? gesture.preview : null;
  const gesturePreviewId =
    gesture && gesture.mode !== 'drag' ? gesture.id : null;
  const hiddenId =
    gesture?.mode === 'drag' && gesture.moved ? gesture.id : null;
  const dropPageIndex =
    gesture?.mode === 'drag' && gesture.moved ? gesture.dropPageIndex : null;

  const ghostPlacement =
    gesture?.mode === 'drag' && gesture.moved
      ? (placements.find((item) => item.id === gesture.id) ?? null)
      : null;
  const ghostPosition =
    gesture?.mode === 'drag' && gesture.moved
      ? dragGhostPosition(gesture)
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-ink-200 bg-white/95 px-4 py-2 backdrop-blur">
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-500">
          {pageCount} {pageCount === 1 ? 'page' : 'pages'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="btn btn-ghost h-8 w-8 px-0 text-base"
            onClick={() => zoomBy(-SCALE_STEP)}
            disabled={scale <= MIN_SCALE}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="w-12 text-center text-xs font-semibold tabular-nums text-ink-600">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="btn btn-ghost h-8 w-8 px-0 text-base"
            onClick={() => zoomBy(SCALE_STEP)}
            disabled={scale >= MAX_SCALE}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            className="btn btn-secondary h-8 px-3 text-xs"
            onClick={fitWidth}
          >
            Fit width
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto bg-ink-100 p-6"
      >
        {doc && inspection ? (
          <div className="flex flex-col items-center gap-8">
            {Array.from({ length: pageCount }, (_, index) => (
              <PageCanvas
                key={index}
                doc={doc}
                pageIndex={index}
                scale={scale}
                viewport={pageViewports[index] ?? null}
                placements={placements}
                selectedId={selectedPlacementId}
                previewId={gesturePreviewId}
                preview={gesturePreview}
                hiddenId={hiddenId}
                highlighted={dropPageIndex === index}
                signerById={signerById}
                registerPageElement={registerPageElement}
                onSelect={selectPlacement}
                onBodyPointerDown={beginDrag}
                onResizePointerDown={beginResize}
                onRotatePointerDown={beginRotate}
                onGestureMove={handleGestureMove}
                onGestureEnd={handleGestureEnd}
                onGestureCancel={handleGestureCancel}
              />
            ))}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm font-medium text-ink-500">
              {status === 'error'
                ? 'This document could not be rendered.'
                : 'Rendering document…'}
            </p>
          </div>
        )}
      </div>

      {gesture?.mode === 'drag' &&
        gesture.moved &&
        ghostPlacement &&
        ghostPosition && (
          <div
            className="pointer-events-none fixed z-50 opacity-90"
            style={{
              left: ghostPosition.x,
              top: ghostPosition.y,
              width: gesture.width * scale,
              height: gesture.height * scale,
              transform: `translate(-50%, -50%) rotate(${gesture.rotation}deg)`,
            }}
          >
            {ghostPlacement.kind === 'image' ? (
              <ImageAppearancePreview dataUrl={ghostPlacement.imageDataUrl} />
            ) : (
              <AdobeAppearancePreview
                signerName={(signerById.get(gesture.id) ?? UNKNOWN_SIGNER).name}
                date={previewDate}
              />
            )}
          </div>
        )}
    </div>
  );
}
