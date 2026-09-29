/**
 * Central application state.
 *
 * Components read and mutate this store directly, which keeps the UI free of
 * prop drilling. Certificates are unlocked on demand; the unlocked key material
 * lives in a module-local map and is never persisted.
 */
import { create } from 'zustand';
import { loadP12, type LoadedP12 } from '@/lib/crypto/p12';
import { inspectPdf } from '@/lib/pdf/inspect';
import { signPdf } from '@/lib/pdf/sign';
import * as certStore from '@/lib/storage/certStore';
import * as signatureStore from '@/lib/storage/signatureStore';
import {
  resolvePlacementPosition,
  type PlacementAnchor,
} from '@/state/placement';
import {
  type ChainMode,
  type DummySigner,
  type PdfInspection,
  type SavedSignatureImage,
  type SignatureKind,
  type SignaturePlacement,
  type SignerInfo,
  type SignerRef,
  type SignOptions,
  type StoredCertificate,
} from '@/types';

const DEFAULT_ADOBE_SIZE = { width: 190, height: 65 };
const DEFAULT_IMAGE_SIZE = { width: 160, height: 60 };

const unlockedKeys = new Map<string, LoadedP12>();

/**
 * Where the viewer last saw its visible centre, in PDF points. The viewer
 * registers a provider while it is mounted so a new placement lands under the
 * user's eyes; without one the resolver falls back to page 0.
 */
let placementAnchorProvider: (() => PlacementAnchor | null) | null = null;

export function setPlacementAnchorProvider(
  provider: (() => PlacementAnchor | null) | null,
): void {
  placementAnchorProvider = provider;
}

/** The certificate id behind a signer reference, or `null` for a dummy / no signer. */
export function certificateIdOf(signer: SignerRef | null): string | null {
  return signer?.type === 'certificate' ? signer.id : null;
}

/**
 * Name shown for a certificate in the UI and in the Adobe-style appearance:
 * the user's non-blank override when present, otherwise the certificate's own
 * common name. The override is a display concern only; the CMS-signed identity
 * always remains the common name.
 */
export function certificateDisplayName(certificate: StoredCertificate): string {
  const override = certificate.nameOverride?.trim();
  return override ? override : certificate.info.commonName;
}

function fitImageSize(width: number, height: number): { width: number; height: number } {
  // Scale the natural size down until it fits inside the default box, never
  // enlarging it, and clamp each side to at least one point.
  const scale = Math.min(DEFAULT_IMAGE_SIZE.width / width, DEFAULT_IMAGE_SIZE.height / height);
  const round = (value: number) => Math.max(1, Math.round(value * 100) / 100);
  return { width: round(width * scale), height: round(height * scale) };
}

export interface SignOutcome {
  pdfBytes: Uint8Array;
  fileName: string;
  fieldNames: string[];
  /** Display names of placements written as visible-only dummy marks. */
  dummyNames: string[];
  certified: boolean;
  warnings: string[];
  byteLength: number;
  incrementalByteLength: number;
  /** `true` when an RFC 3161 timestamp token was embedded in the signatures. */
  timestamped: boolean;
  /** Endpoint of the authority used, when `timestamped`. */
  timestampAuthority: string | null;
  /** Effective signing date (ISO-8601) written to the document. */
  signingTime: string;
  /** `true` when the PDF Info/XMP dates were changed. */
  documentDatesChanged: boolean;
}

interface AppStore {
  pdfBytes: Uint8Array | null;
  fileName: string | null;
  inspection: PdfInspection | null;
  documentLoading: boolean;
  documentError: string | null;

  certificates: StoredCertificate[];
  unlockedBy: Record<string, SignerInfo>;
  unlocking: boolean;

  savedImages: SavedSignatureImage[];
  dummySigners: DummySigner[];
  activeSigner: SignerRef | null;

  placements: SignaturePlacement[];
  selectedPlacementId: string | null;
  activeKind: SignatureKind;

  options: SignOptions;
  signing: boolean;
  signError: string | null;
  outcome: SignOutcome | null;

  openDocument: (fileName: string, bytes: Uint8Array) => Promise<void>;
  closeDocument: () => void;

  refreshSignatures: () => Promise<void>;
  storeCertificate: (input: {
    fileName: string;
    p12Bytes: Uint8Array;
    info: SignerInfo;
    label: string;
    /** Password that opens the file, when one is required. Not persisted unless `rememberPassword`. */
    password?: string;
    /** Persist `password` in IndexedDB so the certificate auto-unlocks later. */
    rememberPassword?: boolean;
  }) => Promise<StoredCertificate>;
  removeCertificate: (id: string) => Promise<void>;
  setCertificateNameOverride: (id: string, nameOverride: string | null) => Promise<void>;
  setActiveSigner: (signer: SignerRef | null) => void;
  unlockCertificate: (id: string, password: string) => Promise<SignerInfo>;
  isUnlocked: (id: string) => boolean;

  addDummySigner: (input: { name: string; description?: string }) => Promise<DummySigner>;
  updateDummySigner: (id: string, patch: { name?: string; description?: string }) => Promise<void>;
  removeDummySigner: (id: string) => Promise<void>;

  saveImage: (input: {
    name: string;
    description?: string;
    imageDataUrl: string;
    width: number;
    height: number;
  }) => Promise<SavedSignatureImage>;
  updateSavedImage: (id: string, patch: { name?: string; description?: string }) => Promise<void>;
  removeSavedImage: (id: string) => Promise<void>;
  reorderSavedImages: (orderedIds: string[]) => Promise<void>;

  addPlacement: (
    kind: SignatureKind,
    options?: {
      imageDataUrl?: string;
      savedImageId?: string;
      imageWidth?: number;
      imageHeight?: number;
    },
  ) => void;
  updatePlacement: (id: string, patch: Partial<SignaturePlacement>) => void;
  removePlacement: (id: string) => void;
  selectPlacement: (id: string | null) => void;
  setActiveKind: (kind: SignatureKind) => void;
  movePlacementToPage: (id: string, pageIndex: number) => void;

  setOptions: (patch: Partial<SignOptions>) => void;
  sign: (mode: ChainMode) => Promise<void>;
  resetOutcome: () => void;
  setSignError: (message: string | null) => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  pdfBytes: null,
  fileName: null,
  inspection: null,
  documentLoading: false,
  documentError: null,

  certificates: [],
  unlockedBy: {},
  unlocking: false,

  savedImages: [],
  dummySigners: [],
  activeSigner: null,

  placements: [],
  selectedPlacementId: null,
  activeKind: 'adobe',

  options: { chainMode: 'continue' },
  signing: false,
  signError: null,
  outcome: null,

  async openDocument(fileName, bytes) {
    set({ documentLoading: true, documentError: null, outcome: null, signError: null });
    try {
      const inspection = await inspectPdf(bytes);
      set({
        pdfBytes: bytes,
        fileName,
        inspection,
        placements: [],
        selectedPlacementId: null,
        documentLoading: false,
      });
    } catch (error) {
      set({
        documentLoading: false,
        documentError: error instanceof Error ? error.message : String(error),
        pdfBytes: null,
        inspection: null,
      });
    }
  },

  closeDocument() {
    set({
      pdfBytes: null,
      fileName: null,
      inspection: null,
      placements: [],
      selectedPlacementId: null,
      outcome: null,
      signError: null,
      documentError: null,
    });
  },

  async refreshSignatures() {
    const [certificates, savedImages, dummySigners] = await Promise.all([
      certStore.listCertificates(),
      signatureStore.listSignatureImages(),
      signatureStore.listDummySigners(),
    ]);
    const unlockedBy = { ...get().unlockedBy };
    for (const certificate of certificates) {
      if (unlockedKeys.has(certificate.id)) continue;
      const secret = certificate.passwordStored ? certificate.password : undefined;
      if (!secret) continue;
      try {
        const loaded = loadP12(certificate.p12Bytes, secret);
        unlockedKeys.set(certificate.id, loaded);
        unlockedBy[certificate.id] = loaded.info;
      } catch {
        // Intentionally non-fatal: a stored password can stop working if the
        // record was tampered with or the cipher changed between versions.
        // Leave the certificate locked so the user is prompted to re-enter it,
        // rather than failing the whole refresh and hiding every certificate.
      }
    }
    const activeSigner =
      get().activeSigner ??
      (certificates.length > 0 ? { type: 'certificate' as const, id: certificates[0].id } : null);
    set({ certificates, savedImages, dummySigners, unlockedBy, activeSigner });
  },

  async storeCertificate(input) {
    const now = new Date().toISOString();
    // An empty string is treated the same as "no password": some callers pass
    // '' for unprotected files, and persisting '' would break refresh later.
    const secret = input.password && input.password.length > 0 ? input.password : undefined;
    const passwordStored = input.rememberPassword === true && secret !== undefined;
    const certificate: StoredCertificate = {
      id: certStore.newCertificateId(),
      label: input.label,
      fileName: input.fileName,
      p12Bytes: input.p12Bytes,
      passwordStored,
      ...(passwordStored ? { password: secret } : {}),
      info: input.info,
      addedAt: now,
      lastUsedAt: null,
    };
    await certStore.saveCertificate(certificate);

    // The UI already proved this password opens the file (verifyP12Password),
    // so unlock in memory immediately whether or not we chose to persist it.
    // The password itself never leaves the module-local `unlockedKeys` map.
    unlockedKeys.set(certificate.id, loadP12(input.p12Bytes, secret ?? ''));
    set((state) => ({
      certificates: [certificate, ...state.certificates],
      activeSigner: { type: 'certificate', id: certificate.id },
      unlockedBy: { ...state.unlockedBy, [certificate.id]: input.info },
    }));
    return certificate;
  },

  async removeCertificate(id) {
    await certStore.deleteCertificate(id);
    unlockedKeys.delete(id);
    set((state) => {
      const certificates = state.certificates.filter((item) => item.id !== id);
      const unlockedBy = { ...state.unlockedBy };
      delete unlockedBy[id];
      const activeSigner =
        state.activeSigner?.type === 'certificate' && state.activeSigner.id === id
          ? null
          : state.activeSigner;
      const placements = state.placements.filter(
        (item) => !(item.signer?.type === 'certificate' && item.signer.id === id),
      );
      const selectedPlacementId =
        state.selectedPlacementId !== null &&
        placements.some((item) => item.id === state.selectedPlacementId)
          ? state.selectedPlacementId
          : null;
      return { certificates, unlockedBy, activeSigner, placements, selectedPlacementId };
    });
  },

  async setCertificateNameOverride(id, nameOverride) {
    const certificate = get().certificates.find((item) => item.id === id);
    if (!certificate) return;
    const trimmed = nameOverride?.trim() ?? '';
    const updated: StoredCertificate = { ...certificate };
    if (trimmed.length > 0) {
      updated.nameOverride = trimmed;
    } else {
      delete updated.nameOverride;
    }
    await certStore.saveCertificate(updated);
    set((state) => ({
      certificates: state.certificates.map((item) => (item.id === id ? updated : item)),
    }));
  },

  setActiveSigner(signer) {
    set({ activeSigner: signer });
  },

  async unlockCertificate(id, password) {
    set({ unlocking: true });
    try {
      const certificate = get().certificates.find((item) => item.id === id);
      if (!certificate) throw new Error('Certificate not found.');
      const loaded = loadP12(certificate.p12Bytes, password);
      unlockedKeys.set(id, loaded);
      void certStore.markCertificateUsed(id);
      set((state) => ({
        unlocking: false,
        activeSigner: { type: 'certificate', id },
        unlockedBy: { ...state.unlockedBy, [id]: loaded.info },
      }));
      return loaded.info;
    } catch (error) {
      set({ unlocking: false });
      throw error;
    }
  },

  isUnlocked(id) {
    return unlockedKeys.has(id);
  },

  async addDummySigner(input) {
    const signer: DummySigner = {
      id: signatureStore.newId(),
      name: input.name,
      description: input.description ?? '',
      addedAt: new Date().toISOString(),
    };
    await signatureStore.saveDummySigner(signer);
    set((state) => ({ dummySigners: [...state.dummySigners, signer] }));
    return signer;
  },

  async updateDummySigner(id, patch) {
    const updated = await signatureStore.updateDummySigner(id, patch);
    set((state) => ({
      dummySigners: state.dummySigners.map((item) => (item.id === id ? updated : item)),
    }));
  },

  async removeDummySigner(id) {
    await signatureStore.deleteDummySigner(id);
    set((state) => {
      const dummySigners = state.dummySigners.filter((item) => item.id !== id);
      const activeSigner =
        state.activeSigner?.type === 'dummy' && state.activeSigner.id === id
          ? null
          : state.activeSigner;
      const placements = state.placements.filter(
        (item) => !(item.signer?.type === 'dummy' && item.signer.id === id),
      );
      const selectedPlacementId =
        state.selectedPlacementId !== null &&
        placements.some((item) => item.id === state.selectedPlacementId)
          ? state.selectedPlacementId
          : null;
      return { dummySigners, activeSigner, placements, selectedPlacementId };
    });
  },

  async saveImage(input) {
    const image: SavedSignatureImage = {
      id: signatureStore.newId(),
      name: input.name,
      description: input.description ?? '',
      imageDataUrl: input.imageDataUrl,
      width: input.width,
      height: input.height,
      order: await signatureStore.nextSignatureOrder(),
      addedAt: new Date().toISOString(),
    };
    await signatureStore.saveSignatureImage(image);
    set((state) => ({ savedImages: [...state.savedImages, image] }));
    return image;
  },

  async updateSavedImage(id, patch) {
    const updated = await signatureStore.updateSignatureImage(id, patch);
    set((state) => ({
      savedImages: state.savedImages.map((item) => (item.id === id ? updated : item)),
    }));
  },

  async removeSavedImage(id) {
    await signatureStore.deleteSignatureImage(id);
    set((state) => ({ savedImages: state.savedImages.filter((item) => item.id !== id) }));
  },

  async reorderSavedImages(orderedIds) {
    const savedImages = await signatureStore.reorderSignatureImages(orderedIds);
    set({ savedImages });
  },

  addPlacement(kind, options) {
    const state = get();
    const activeSigner = state.activeSigner;
    // A dummy signer has no key material, so an invisible dummy would leave no
    // trace at all; refuse rather than silently writing nothing.
    if (activeSigner?.type === 'dummy' && kind === 'invisible') return;

    const naturalWidth = options?.imageWidth;
    const naturalHeight = options?.imageHeight;
    const size =
      kind === 'image'
        ? naturalWidth !== undefined && naturalHeight !== undefined
          ? fitImageSize(naturalWidth, naturalHeight)
          : DEFAULT_IMAGE_SIZE
        : kind === 'adobe'
          ? DEFAULT_ADOBE_SIZE
          : { width: 0, height: 0 };

    const pages = state.inspection?.pages ?? [];
    const position = resolvePlacementPosition(
      placementAnchorProvider?.() ?? null,
      pages,
      size,
    );

    const placement: SignaturePlacement = {
      id: crypto.randomUUID(),
      kind,
      pageIndex: position.pageIndex,
      cx: position.cx,
      cy: position.cy,
      width: size.width,
      height: size.height,
      rotation: 0,
      // Attach the signer chosen now; leaving it off lets the placement inherit
      // whatever is active when the user finally signs.
      ...(activeSigner ? { signer: activeSigner } : {}),
      ...(kind === 'image' && options?.imageDataUrl ? { imageDataUrl: options.imageDataUrl } : {}),
      ...(kind === 'image' && options?.savedImageId ? { savedImageId: options.savedImageId } : {}),
    };
    set({
      placements: [...state.placements, placement],
      selectedPlacementId: placement.id,
    });
  },

  updatePlacement(id, patch) {
    set((state) => ({
      placements: state.placements.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  },

  removePlacement(id) {
    set((state) => ({
      placements: state.placements.filter((item) => item.id !== id),
      selectedPlacementId: state.selectedPlacementId === id ? null : state.selectedPlacementId,
    }));
  },

  selectPlacement(id) {
    set({ selectedPlacementId: id });
  },

  setActiveKind(kind) {
    set({ activeKind: kind });
  },

  movePlacementToPage(id, pageIndex) {
    set((state) => ({
      placements: state.placements.map((item) =>
        item.id === id ? { ...item, pageIndex } : item,
      ),
    }));
  },

  setOptions(patch) {
    set((state) => ({ options: { ...state.options, ...patch } }));
  },

  async sign(mode) {
    const state = get();
    const { pdfBytes, inspection, placements, fileName, activeSigner } = state;
    if (!pdfBytes || !inspection) return;
    if (placements.length === 0) {
      set({ signError: 'Add at least one signature placement.' });
      return;
    }

    // Each placement resolves to the signer it was added under, or the one
    // selected at signing time, so one run can mix real and dummy signers.
    const resolved: SignaturePlacement[] = [];
    for (const placement of placements) {
      const signer = placement.signer ?? activeSigner;
      if (!signer) {
        set({ signError: 'Choose a signer for every signature placement.' });
        return;
      }
      resolved.push({ ...placement, signer });
    }

    if (mode === 'finalize' && resolved.some((item) => item.signer?.type === 'dummy')) {
      set({
        signError:
          'A certification signature needs a real certificate. Remove the dummy signature placements or use "Sign, allow more".',
      });
      return;
    }

    for (const item of resolved) {
      if (item.signer?.type === 'dummy' && item.kind === 'invisible') {
        set({ signError: 'Invisible signatures are unavailable for dummy signers.' });
        return;
      }
    }

    for (const item of resolved) {
      const signer = item.signer;
      if (!signer || signer.type !== 'certificate') continue;
      if (unlockedKeys.has(signer.id)) continue;
      const certificate = state.certificates.find((entry) => entry.id === signer.id);
      set({
        activeSigner: signer,
        signError: `Unlock "${certificate?.label ?? signer.id}" before signing.`,
      });
      return;
    }

    const signable = resolved.filter((item) => item.kind !== 'image' || item.imageDataUrl);
    if (signable.length === 0) {
      set({ signError: 'Add at least one signature placement.' });
      return;
    }

    const timestampUrl = state.options.timestamp?.url?.trim();
    let resolvedSigningTime: Date | undefined;
    let documentDates: Date | null = null;

    if (!timestampUrl && state.options.signingTimeMode === 'custom') {
      const rawSigningTime = state.options.signingTime?.trim();
      const parsedSigningTime = rawSigningTime ? new Date(rawSigningTime) : null;
      if (!parsedSigningTime || Number.isNaN(parsedSigningTime.getTime())) {
        set({ signError: 'Choose a valid custom signing date, or use the current time.' });
        return;
      }
      resolvedSigningTime = parsedSigningTime;

      if (state.options.pdfDates === 'signature') {
        documentDates = parsedSigningTime;
      } else if (state.options.pdfDates === 'custom') {
        const rawPdfDate = state.options.pdfCustomDate?.trim();
        const parsedPdfDate = rawPdfDate ? new Date(rawPdfDate) : null;
        if (!parsedPdfDate || Number.isNaN(parsedPdfDate.getTime())) {
          set({
            signError: 'Choose a valid custom PDF date, or leave the document dates unchanged.',
          });
          return;
        }
        documentDates = parsedPdfDate;
      }
    }

    const dummyNames = new Map(state.dummySigners.map((signer) => [signer.id, signer.name]));
    const certificateNames = new Map<string, string>();
    for (const item of resolved) {
      const id = certificateIdOf(item.signer ?? null);
      if (!id) continue;
      const certificate = state.certificates.find((entry) => entry.id === id);
      if (certificate) certificateNames.set(id, certificateDisplayName(certificate));
    }

    set({ signing: true, signError: null, outcome: null });
    try {
      const result = await signPdf({
        pdfBytes,
        placements: signable,
        certificates: unlockedKeys,
        dummyNames,
        certificateNames,
        options: {
          ...state.options,
          chainMode: mode,
        },
        timestamp: timestampUrl
          ? { url: timestampUrl, timeoutMs: state.options.timestamp?.timeoutMs }
          : null,
        signingTime: resolvedSigningTime,
        documentDates,
      });
      const baseName = (fileName ?? 'document.pdf').replace(/\.pdf$/i, '');
      const suffix = mode === 'finalize' ? 'signed-final' : 'signed';
      set({
        signing: false,
        outcome: {
          pdfBytes: result.pdfBytes,
          fileName: `${baseName}-${suffix}.pdf`,
          fieldNames: result.signatureFieldNames,
          dummyNames: result.dummyNames,
          certified: result.certified,
          warnings: result.warnings,
          byteLength: result.byteLength,
          incrementalByteLength: result.incrementalByteLength,
          timestamped: result.timestamped,
          timestampAuthority: result.timestampAuthority,
          signingTime: result.signingTime,
          documentDatesChanged: result.documentDatesChanged,
        },
      });
    } catch (error) {
      set({
        signing: false,
        signError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  resetOutcome() {
    set({ outcome: null });
  },

  setSignError(message) {
    set({ signError: message });
  },
}));
