import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { DEFAULT_TSA_URL, TSA_PRESETS } from '@/lib/crypto/timestamp';
import { certificateDisplayName, useAppStore } from '@/state/useAppStore';
import {
  P12Error,
  type SavedSignatureImage,
  type SignatureKind,
  type SignerRef,
} from '@/types';

interface SignaturePanelProps {
  onOpenCertificates: () => void;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const CONFIRM_TIMEOUT_MS = 4000;

const KIND_TILES: ReadonlyArray<{ kind: SignatureKind; label: string; description: string }> = [
  {
    kind: 'invisible',
    label: 'Invisible',
    description: 'Cryptographic signature only, nothing is drawn on the page.',
  },
  {
    kind: 'adobe',
    label: 'Adobe style',
    description: 'Name, date and a check mark drawn by the app.',
  },
  {
    kind: 'image',
    label: 'Custom image',
    description: 'Use your own PNG or JPEG signature image.',
  },
];

const KIND_LABELS: Record<SignatureKind, string> = {
  invisible: 'Invisible',
  adobe: 'Adobe style',
  image: 'Custom image',
};

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Encodes a signer reference as a `<select>` option value. */
function signerValue(signer: SignerRef | null): string {
  return signer ? `${signer.type}:${signer.id}` : '';
}

/** Parses a `<select>` option value back into a signer reference. */
function parseSignerValue(value: string): SignerRef | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const rawType = value.slice(0, separator);
  if (rawType !== 'certificate' && rawType !== 'dummy') return null;
  const id = value.slice(separator + 1);
  if (id.length === 0) return null;
  return { type: rawType, id };
}

/** `signature.png` → `signature`. */
function fileNameWithoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Resolves an uploaded data URL to its natural pixel size. */
function loadImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (width <= 0 || height <= 0) {
        reject(new Error('The image has no usable dimensions.'));
        return;
      }
      resolve({ width, height });
    };
    image.onerror = () => reject(new Error('Could not read that image.'));
    image.src = dataUrl;
  });
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className ?? ''}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M12 3a9 9 0 0 1 9 9h-3a6 6 0 0 0-6-6V3z" />
    </svg>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
      {children}
    </h2>
  );
}

function DummyTag() {
  return (
    <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
      Dummy
    </span>
  );
}

function KindIcon({ kind }: { kind: SignatureKind }) {
  if (kind === 'invisible') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5"
        aria-hidden="true"
      >
        <path d="M3 3l18 18" />
        <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
        <path d="M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4 10 7a13.5 13.5 0 0 1-3 4.2" />
        <path d="M6.3 6.3A13.4 13.4 0 0 0 2 12c1 3 5 7 10 7a10 10 0 0 0 3.5-.6" />
      </svg>
    );
  }
  if (kind === 'adobe') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5"
        aria-hidden="true"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}

export function SignaturePanel({ onOpenCertificates }: SignaturePanelProps) {
  const certificates = useAppStore((state) => state.certificates);
  const unlockedBy = useAppStore((state) => state.unlockedBy);
  const unlocking = useAppStore((state) => state.unlocking);
  const setActiveSigner = useAppStore((state) => state.setActiveSigner);
  const activeSigner = useAppStore((state) => state.activeSigner);
  const unlockCertificate = useAppStore((state) => state.unlockCertificate);
  const isUnlocked = useAppStore((state) => state.isUnlocked);

  const dummySigners = useAppStore((state) => state.dummySigners);

  const savedImages = useAppStore((state) => state.savedImages);
  const saveImage = useAppStore((state) => state.saveImage);
  const updateSavedImage = useAppStore((state) => state.updateSavedImage);
  const removeSavedImage = useAppStore((state) => state.removeSavedImage);
  const reorderSavedImages = useAppStore((state) => state.reorderSavedImages);

  const activeKind = useAppStore((state) => state.activeKind);
  const setActiveKind = useAppStore((state) => state.setActiveKind);
  const placements = useAppStore((state) => state.placements);
  const selectedPlacementId = useAppStore((state) => state.selectedPlacementId);
  const addPlacement = useAppStore((state) => state.addPlacement);
  const removePlacement = useAppStore((state) => state.removePlacement);
  const selectPlacement = useAppStore((state) => state.selectPlacement);

  const options = useAppStore((state) => state.options);
  const setOptions = useAppStore((state) => state.setOptions);

  const pdfBytes = useAppStore((state) => state.pdfBytes);
  const inspection = useAppStore((state) => state.inspection);
  const signing = useAppStore((state) => state.signing);
  const sign = useAppStore((state) => state.sign);

  const [password, setPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [pendingImage, setPendingImage] = useState<{
    dataUrl: string;
    width: number;
    height: number;
    defaultName: string;
  } | null>(null);
  const [imageName, setImageName] = useState('');
  const [imageDescription, setImageDescription] = useState('');
  const [saveToGallery, setSaveToGallery] = useState(true);
  const [timestampCustom, setTimestampCustom] = useState(false);

  const [editingImageId, setEditingImageId] = useState<string | null>(null);
  const [imageEditName, setImageEditName] = useState('');
  const [imageEditDescription, setImageEditDescription] = useState('');

  const [pendingRemoveImageId, setPendingRemoveImageId] = useState<string | null>(null);
  const imageConfirmTimerRef = useRef<number | null>(null);

  const activeCertificate =
    activeSigner?.type === 'certificate'
      ? certificates.find((item) => item.id === activeSigner.id) ?? null
      : null;
  const activeDummy =
    activeSigner?.type === 'dummy'
      ? dummySigners.find((item) => item.id === activeSigner.id) ?? null
      : null;
  const unlockedSigner = activeCertificate ? unlockedBy[activeCertificate.id] : undefined;
  const certificateUnlocked =
    activeCertificate !== null &&
    (unlockedSigner !== undefined || isUnlocked(activeCertificate.id));

  const activeCertificateDisplayName = activeCertificate
    ? certificateDisplayName(activeCertificate)
    : null;
  const activeCertificateHasNameOverride = Boolean(activeCertificate?.nameOverride?.trim());

  const dummyActive = activeSigner?.type === 'dummy';
  const hasDummyPlacement = placements.some(
    (placement) => (placement.signer ?? activeSigner)?.type === 'dummy',
  );

  useEffect(() => {
    return () => {
      if (imageConfirmTimerRef.current !== null) {
        window.clearTimeout(imageConfirmTimerRef.current);
      }
    };
  }, []);

  // A dummy has no key material, so an invisible mark would leave no trace.
  // Move off the now-unavailable tile when a dummy becomes the active signer.
  useEffect(() => {
    if (activeSigner?.type === 'dummy' && activeKind === 'invisible') {
      setActiveKind('adobe');
    }
  }, [activeSigner, activeKind, setActiveKind]);

  const blockedReason = signing
    ? 'Signing is already in progress.'
    : !pdfBytes
      ? 'Open a PDF document before signing.'
      : placements.length === 0
        ? 'Add at least one signature placement.'
        : !activeSigner
          ? 'Select a signer to sign.'
          : activeSigner.type === 'certificate' && !certificateUnlocked
            ? 'Unlock a certificate to sign.'
            : null;

  const continueDisabled = blockedReason !== null;
  const finalizeDisabled = blockedReason !== null || placements.length > 1 || hasDummyPlacement;

  function handleSignerChange(event: ChangeEvent<HTMLSelectElement>) {
    setActiveSigner(parseSignerValue(event.target.value));
    setPassword('');
    setUnlockError(null);
  }

  async function handleUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeCertificate) return;
    const certificateId = activeCertificate.id;
    setUnlockError(null);
    try {
      await unlockCertificate(certificateId, password);
      setPassword('');
    } catch (error) {
      const message =
        error instanceof P12Error
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      setUnlockError(message);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImageError(null);
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      setImageError('Only PNG or JPEG images are supported.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError('Image must be 5 MB or smaller.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      const dataUrl = reader.result;
      const defaultName = fileNameWithoutExtension(file.name);
      void loadImageSize(dataUrl)
        .then(({ width, height }) => {
          setPendingImage({ dataUrl, width, height, defaultName });
          setImageName(defaultName);
          setImageDescription('');
          setSaveToGallery(true);
        })
        .catch((error: unknown) => {
          setImageError(error instanceof Error ? error.message : 'Could not read that image.');
        });
    };
    reader.onerror = () => setImageError('Could not read that image.');
    reader.readAsDataURL(file);
  }

  function resetImageForm() {
    setPendingImage(null);
    setImageName('');
    setImageDescription('');
    setSaveToGallery(true);
    setImageError(null);
  }

  async function handleAddImage() {
    if (!pendingImage) return;
    const trimmedName = imageName.trim();
    let savedImageId: string | undefined;
    try {
      if (saveToGallery) {
        const saved = await saveImage({
          name: trimmedName.length > 0 ? trimmedName : pendingImage.defaultName,
          description: imageDescription.trim(),
          imageDataUrl: pendingImage.dataUrl,
          width: pendingImage.width,
          height: pendingImage.height,
        });
        savedImageId = saved.id;
      }
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'Could not save that image.');
      return;
    }
    addPlacement('image', {
      imageDataUrl: pendingImage.dataUrl,
      imageWidth: pendingImage.width,
      imageHeight: pendingImage.height,
      savedImageId,
    });
    resetImageForm();
  }

  function handleUseSavedImage(item: SavedSignatureImage) {
    addPlacement('image', {
      imageDataUrl: item.imageDataUrl,
      imageWidth: item.width,
      imageHeight: item.height,
      savedImageId: item.id,
    });
  }

  function startImageEdit(item: SavedSignatureImage) {
    setEditingImageId(item.id);
    setImageEditName(item.name);
    setImageEditDescription(item.description);
  }

  async function handleSaveImageEdit(id: string) {
    const name = imageEditName.trim();
    if (name.length === 0) return;
    await updateSavedImage(id, { name, description: imageEditDescription.trim() });
    setEditingImageId(null);
  }

  function handleRemoveImage(id: string) {
    if (pendingRemoveImageId !== id) {
      setPendingRemoveImageId(id);
      if (imageConfirmTimerRef.current !== null) window.clearTimeout(imageConfirmTimerRef.current);
      imageConfirmTimerRef.current = window.setTimeout(
        () => setPendingRemoveImageId(null),
        CONFIRM_TIMEOUT_MS,
      );
      return;
    }
    if (imageConfirmTimerRef.current !== null) window.clearTimeout(imageConfirmTimerRef.current);
    setPendingRemoveImageId(null);
    void removeSavedImage(id);
  }

  function moveImage(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= savedImages.length) return;
    const orderedIds = savedImages.map((item) => item.id);
    const current = orderedIds[index];
    orderedIds[index] = orderedIds[target];
    orderedIds[target] = current;
    void reorderSavedImages(orderedIds);
  }

  function describeSigner(signer: SignerRef | null): string {
    if (!signer) return 'No signer';
    if (signer.type === 'dummy') {
      return dummySigners.find((item) => item.id === signer.id)?.name ?? 'Dummy signer';
    }
    const certificate = certificates.find((item) => item.id === signer.id);
    if (certificate) return certificateDisplayName(certificate);
    return unlockedBy[signer.id]?.commonName ?? 'Certificate';
  }

  const noSigners = certificates.length === 0 && dummySigners.length === 0;

  const signingTimeMode = options.signingTimeMode ?? 'now';
  const pdfDatesChanged = options.pdfDates === 'signature' || options.pdfDates === 'custom';
  const timestampPresetValue = timestampCustom
    ? '__custom__'
    : (TSA_PRESETS.find((preset) => preset.url === options.timestamp?.url)?.url ?? '__custom__');

  return (
    <div className="space-y-4">
      <section className="panel p-4">
        <SectionTitle>Signer</SectionTitle>
        {noSigners ? (
          <div className="space-y-2">
            <p className="text-xs leading-snug text-ink-500">
              No signers yet. Add a PKCS#12 (.p12/.pfx) certificate to sign with, or create a dummy
              signature for a visible-only mark.
            </p>
            <button type="button" className="btn btn-secondary w-full" onClick={onOpenCertificates}>
              Add or manage signers
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="field-label" htmlFor="active-signer">
              Active signer
            </label>
            <select
              id="active-signer"
              className="text-input"
              value={signerValue(activeSigner)}
              onChange={handleSignerChange}
            >
              <option value="">Select a signer…</option>
              {certificates.length > 0 ? (
                <optgroup label="Certificates">
                  {certificates.map((certificate) => (
                    <option key={certificate.id} value={`certificate:${certificate.id}`}>
                      {certificate.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {dummySigners.length > 0 ? (
                <optgroup label="Dummy signatures">
                  {dummySigners.map((signer) => (
                    <option key={signer.id} value={`dummy:${signer.id}`}>
                      {signer.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>

            {activeCertificate && !certificateUnlocked ? (
              <form className="space-y-2 pt-1" onSubmit={handleUnlock}>
                <label className="field-label" htmlFor="certificate-password">
                  Password
                </label>
                <div className="flex gap-2">
                  <input
                    id="certificate-password"
                    type="password"
                    className="text-input"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Certificate password"
                    autoComplete="current-password"
                  />
                  <button type="submit" className="btn btn-primary shrink-0" disabled={unlocking}>
                    {unlocking ? (
                      <>
                        <Spinner className="h-4 w-4" />
                        Unlocking
                      </>
                    ) : (
                      'Unlock'
                    )}
                  </button>
                </div>
                {unlockError ? (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-snug text-red-700">
                    {unlockError}
                  </p>
                ) : null}
              </form>
            ) : null}

            {activeCertificate && certificateUnlocked && unlockedSigner ? (
              <div className="space-y-1.5 rounded-lg bg-ink-50 px-3 py-2.5">
                {activeCertificateHasNameOverride && activeCertificateDisplayName ? (
                  <>
                    <p
                      className="truncate text-sm font-semibold text-ink-900"
                      title={activeCertificateDisplayName}
                    >
                      {activeCertificateDisplayName}
                    </p>
                    <p
                      className="truncate text-[11px] text-ink-500"
                      title={unlockedSigner.commonName}
                    >
                      Certificate name: {unlockedSigner.commonName}
                    </p>
                  </>
                ) : (
                  <p
                    className="truncate text-sm font-semibold text-ink-900"
                    title={unlockedSigner.commonName}
                  >
                    {unlockedSigner.commonName}
                  </p>
                )}
                {unlockedSigner.email ? (
                  <p className="text-xs text-ink-600">{unlockedSigner.email}</p>
                ) : null}
                {unlockedSigner.organization ? (
                  <p className="text-xs text-ink-600">{unlockedSigner.organization}</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <p className="text-[11px] text-ink-500">
                    Valid {formatDate(unlockedSigner.notBefore)} →{' '}
                    {formatDate(unlockedSigner.notAfter)}
                  </p>
                  {unlockedSigner.isExpired ? (
                    <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700">
                      Expired
                    </span>
                  ) : unlockedSigner.daysUntilExpiry <= 30 ? (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                      Expires in {unlockedSigner.daysUntilExpiry} day
                      {unlockedSigner.daysUntilExpiry === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}

            {activeDummy ? (
              <div className="space-y-1.5 rounded-lg bg-ink-50 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 truncate text-sm font-semibold text-ink-900">
                    {activeDummy.name}
                  </p>
                  <DummyTag />
                </div>
                {activeDummy.description ? (
                  <p className="text-xs leading-snug text-ink-600">{activeDummy.description}</p>
                ) : null}
                <p className="text-[11px] leading-snug text-ink-500">
                  No digital signature is created - only the visible mark is added to the page.
                </p>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section className="panel p-4">
        <SectionTitle>Signature</SectionTitle>
        <div className="space-y-2">
          {KIND_TILES.map((tile) => {
            const active = activeKind === tile.kind;
            const disabled = tile.kind === 'invisible' && dummyActive;
            return (
              <button
                key={tile.kind}
                type="button"
                aria-pressed={active}
                aria-disabled={disabled || undefined}
                disabled={disabled}
                onClick={() => setActiveKind(tile.kind)}
                className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  disabled
                    ? 'cursor-not-allowed border-ink-200 bg-ink-50 opacity-60'
                    : active
                      ? 'border-accent-500 bg-accent-500/5'
                      : 'border-ink-200 bg-white hover:bg-ink-50'
                }`}
              >
                <span className={active && !disabled ? 'text-accent-600' : 'text-ink-500'}>
                  <KindIcon kind={tile.kind} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink-800">{tile.label}</span>
                  <span className="block text-xs leading-snug text-ink-500">
                    {tile.description}
                  </span>
                  {disabled ? (
                    <span className="mt-0.5 block text-[11px] font-medium text-amber-700">
                      Not available for dummy signatures
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-3">
          {activeKind === 'image' ? (
            <div className="space-y-1.5">
              <button
                type="button"
                className="btn btn-secondary w-full"
                onClick={() => fileInputRef.current?.click()}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="M17 8l-5-5-5 5" />
                  <path d="M12 3v12" />
                </svg>
                Choose image
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                aria-label="Choose a signature image"
                onChange={handleFileChange}
              />

              {imageError ? (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-snug text-red-700">
                  {imageError}
                </p>
              ) : pendingImage ? null : (
                <p className="text-[11px] text-ink-500">PNG or JPEG, up to 5 MB.</p>
              )}

              {pendingImage ? (
                <div className="space-y-2 rounded-lg border border-ink-200 bg-ink-50 p-2.5">
                  <img
                    src={pendingImage.dataUrl}
                    alt=""
                    className="mx-auto h-16 max-w-full rounded bg-ink-50 object-contain"
                  />
                  <div>
                    <label className="field-label" htmlFor="image-name">
                      Name
                    </label>
                    <input
                      id="image-name"
                      type="text"
                      className="text-input"
                      value={imageName}
                      onChange={(event) => setImageName(event.target.value)}
                    />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="image-description">
                      Description
                    </label>
                    <input
                      id="image-description"
                      type="text"
                      className="text-input"
                      value={imageDescription}
                      onChange={(event) => setImageDescription(event.target.value)}
                      placeholder="Optional"
                    />
                  </div>
                  <label className="flex items-start gap-2">
                    <input
                      id="image-save-gallery"
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-ink-300 text-accent-600 focus:ring-accent-500"
                      checked={saveToGallery}
                      onChange={(event) => setSaveToGallery(event.target.checked)}
                    />
                    <span className="text-xs text-ink-700">Save to the gallery</span>
                  </label>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      className="btn btn-ghost h-7 px-2 text-xs"
                      onClick={resetImageForm}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary h-8 px-3 text-sm"
                      onClick={() => void handleAddImage()}
                    >
                      Add to document
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-secondary w-full"
              onClick={() => addPlacement(activeKind)}
            >
              Add to document
            </button>
          )}
        </div>

        {activeKind === 'image' ? (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
              Saved images
            </h3>
            <span className="text-[11px] text-ink-400">{savedImages.length}</span>
          </div>

          {savedImages.length === 0 ? (
            <p className="text-xs text-ink-400">
              No saved images yet. Upload one from the Custom image option.
            </p>
          ) : (
            <ul className="space-y-2">
              {savedImages.map((item, index) => {
                const editing = editingImageId === item.id;
                const pending = pendingRemoveImageId === item.id;
                const isFirst = index === 0;
                const isLast = index === savedImages.length - 1;
                return (
                  <li key={item.id} className="rounded-lg border border-ink-200 bg-white p-2">
                    {editing ? (
                      <div className="space-y-2">
                        <div>
                          <label className="field-label" htmlFor={`image-edit-name-${item.id}`}>
                            Name
                          </label>
                          <input
                            id={`image-edit-name-${item.id}`}
                            type="text"
                            className="text-input"
                            value={imageEditName}
                            onChange={(event) => setImageEditName(event.target.value)}
                          />
                        </div>
                        <div>
                          <label
                            className="field-label"
                            htmlFor={`image-edit-description-${item.id}`}
                          >
                            Description
                          </label>
                          <input
                            id={`image-edit-description-${item.id}`}
                            type="text"
                            className="text-input"
                            value={imageEditDescription}
                            onChange={(event) => setImageEditDescription(event.target.value)}
                            placeholder="Optional"
                          />
                        </div>
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            className="btn btn-ghost h-7 px-2 text-xs"
                            onClick={() => setEditingImageId(null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary h-7 px-2 text-xs"
                            disabled={imageEditName.trim().length === 0}
                            onClick={() => void handleSaveImageEdit(item.id)}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-start gap-2">
                          <img
                            src={item.imageDataUrl}
                            alt=""
                            className="h-10 w-10 shrink-0 rounded border border-ink-200 bg-ink-50 object-contain"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-ink-800" title={item.name}>
                              {item.name}
                            </p>
                            {item.description ? (
                              <p
                                className="truncate text-[11px] text-ink-500"
                                title={item.description}
                              >
                                {item.description}
                              </p>
                            ) : null}
                          </div>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1">
                          <button
                            type="button"
                            className="btn btn-secondary h-7 px-2 text-xs"
                            onClick={() => handleUseSavedImage(item)}
                          >
                            Use
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost h-7 px-2 text-xs"
                            onClick={() => startImageEdit(item)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost h-7 w-7 p-0"
                            aria-label={`Move ${item.name} up`}
                            disabled={isFirst}
                            onClick={() => moveImage(index, -1)}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.75"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="h-4 w-4"
                              aria-hidden="true"
                            >
                              <path d="m18 15-6-6-6 6" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost h-7 w-7 p-0"
                            aria-label={`Move ${item.name} down`}
                            disabled={isLast}
                            onClick={() => moveImage(index, 1)}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.75"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="h-4 w-4"
                              aria-hidden="true"
                            >
                              <path d="m6 9 6 6 6-6" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger ml-auto h-7 px-2 text-xs"
                            onClick={() => handleRemoveImage(item.id)}
                          >
                            {pending ? 'Confirm remove?' : 'Remove'}
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        ) : null}

        <div className="mt-4 space-y-2">
          {placements.length === 0 ? (
            <p className="text-xs text-ink-400">No signatures placed yet</p>
          ) : (
            placements.map((placement) => {
              const selected = placement.id === selectedPlacementId;
              const effectiveSigner = placement.signer ?? activeSigner;
              const dummy = effectiveSigner?.type === 'dummy';
              return (
                <div
                  key={placement.id}
                  className={`flex items-center gap-2 rounded-lg border p-1.5 ${
                    selected ? 'border-accent-500 bg-accent-500/5' : 'border-ink-200 bg-white'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => selectPlacement(placement.id)}
                    className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-ink-800">
                          {KIND_LABELS[placement.kind]}
                        </span>
                        {dummy ? <DummyTag /> : null}
                      </span>
                      <span className="block text-[11px] text-ink-500">
                        Page {placement.pageIndex + 1} · {Math.round(placement.width)} ×{' '}
                        {Math.round(placement.height)} pt
                        {placement.rotation !== 0 ? ` · ${placement.rotation}°` : ''}
                      </span>
                      <span className="block truncate text-[11px] text-ink-500">
                        {describeSigner(effectiveSigner)}
                      </span>
                    </span>
                    {selected ? (
                      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-accent-600">
                        Selected
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    onClick={() => removePlacement(placement.id)}
                    aria-label={`Remove ${KIND_LABELS[placement.kind]} on page ${placement.pageIndex + 1}`}
                    className="btn btn-danger h-7 w-7 shrink-0 p-0"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-4 w-4"
                      aria-hidden="true"
                    >
                      <path d="M3 6h18" />
                      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                    </svg>
                  </button>
                </div>
              );
            })
          )}
        </div>

        {inspection?.hasSignatures ? (
          <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs leading-snug text-blue-800">
            This document already contains {inspection.signatureCount} signature
            {inspection.signatureCount === 1 ? '' : 's'}. Signing will append a new revision and keep{' '}
            {inspection.signatureCount === 1 ? 'it' : 'them'} valid.
          </p>
        ) : null}
      </section>

      <section className="panel p-4">
        <SectionTitle>Signing details</SectionTitle>
        <div className="space-y-3">
          <div>
            <label className="field-label" htmlFor="signing-reason">
              Reason
            </label>
            <input
              id="signing-reason"
              type="text"
              className="text-input"
              value={options.reason ?? ''}
              placeholder="Approved for internal use"
              onChange={(event) => setOptions({ reason: event.target.value })}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="signing-location">
              Location
            </label>
            <input
              id="signing-location"
              type="text"
              className="text-input"
              value={options.location ?? ''}
              placeholder="City, Country"
              onChange={(event) => setOptions({ location: event.target.value })}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="signing-contact">
              Contact
            </label>
            <input
              id="signing-contact"
              type="text"
              className="text-input"
              value={options.contactInfo ?? ''}
              placeholder="you@example.com"
              onChange={(event) => setOptions({ contactInfo: event.target.value })}
            />
          </div>
        </div>
      </section>

      <section className="panel p-4">
        <SectionTitle>Timestamp &amp; date</SectionTitle>
        <div className="space-y-3">
          <label className="flex items-start gap-2">
            <input
              id="use-timestamp"
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-ink-300 text-accent-600 focus:ring-accent-500"
              checked={Boolean(options.timestamp?.url)}
              onChange={(event) => {
                setTimestampCustom(false);
                setOptions({
                  timestamp: event.target.checked
                    ? { url: options.timestamp?.url || DEFAULT_TSA_URL }
                    : null,
                });
              }}
            />
            <span className="text-xs text-ink-700">Add a trusted timestamp (RFC 3161)</span>
          </label>

          {options.timestamp?.url ? (
            <div className="space-y-3">
              <div>
                <label className="field-label" htmlFor="timestamp-preset">
                  Timestamp authority
                </label>
                <select
                  id="timestamp-preset"
                  className="text-input"
                  value={timestampPresetValue}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === '__custom__') {
                      setTimestampCustom(true);
                      return;
                    }
                    setTimestampCustom(false);
                    setOptions({
                      timestamp: { url: value, timeoutMs: options.timestamp?.timeoutMs },
                    });
                  }}
                >
                  {TSA_PRESETS.map((preset) => (
                    <option key={preset.url} value={preset.url}>
                      {preset.label}
                    </option>
                  ))}
                  <option value="__custom__">Custom…</option>
                </select>
              </div>
              {timestampCustom ? (
                <>
                  <div>
                    <label className="field-label" htmlFor="timestamp-url">
                      Authority URL
                    </label>
                    <input
                      id="timestamp-url"
                      type="url"
                      className="text-input"
                      value={options.timestamp?.url ?? ''}
                      onChange={(event) =>
                        setOptions({
                          timestamp: {
                            url: event.target.value,
                            timeoutMs: options.timestamp?.timeoutMs,
                          },
                        })
                      }
                    />
                  </div>
                  <p className="text-[11px] leading-snug text-ink-500">
                    The request is relayed through rfc3161.ai.moda so the browser can reach the
                    authority. Only a hash of the signature - never the document or the certificate -
                    is sent.
                  </p>
                </>
              ) : null}
              <p className="text-[11px] leading-snug text-ink-500">
                The authority provides the trusted signing time, so the custom signing date controls
                below are hidden.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <fieldset id="signing-time-mode" className="space-y-2">
                <legend className="field-label">Signing time</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="signing-time-mode"
                    value="now"
                    className="h-4 w-4 border-ink-300 text-accent-600 focus:ring-accent-500"
                    checked={signingTimeMode === 'now'}
                    onChange={() => setOptions({ signingTimeMode: 'now' })}
                  />
                  <span className="text-xs text-ink-700">Current date &amp; time</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="signing-time-mode"
                    value="custom"
                    className="h-4 w-4 border-ink-300 text-accent-600 focus:ring-accent-500"
                    checked={signingTimeMode === 'custom'}
                    onChange={() => setOptions({ signingTimeMode: 'custom' })}
                  />
                  <span className="text-xs text-ink-700">Custom date &amp; time</span>
                </label>
              </fieldset>

              {signingTimeMode === 'custom' ? (
                <div className="space-y-2 pl-6">
                  <div>
                    <label className="field-label" htmlFor="signing-time">
                      Custom signing date
                    </label>
                    <input
                      id="signing-time"
                      type="datetime-local"
                      className="text-input"
                      value={options.signingTime ?? ''}
                      onChange={(event) => setOptions({ signingTime: event.target.value })}
                    />
                  </div>

                  <label className="flex items-start gap-2 pt-1">
                    <input
                      id="change-pdf-dates"
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-ink-300 text-accent-600 focus:ring-accent-500"
                      checked={pdfDatesChanged}
                      onChange={(event) =>
                        setOptions({ pdfDates: event.target.checked ? 'signature' : 'unmodified' })
                      }
                    />
                    <span className="text-xs text-ink-700">
                      Also change the PDF creation / modification date
                    </span>
                  </label>

                  {pdfDatesChanged ? (
                    <fieldset id="pdf-date-mode" className="space-y-2 pl-6">
                      <legend className="field-label">Document date</legend>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="pdf-date-mode"
                          value="signature"
                          className="h-4 w-4 border-ink-300 text-accent-600 focus:ring-accent-500"
                          checked={options.pdfDates === 'signature'}
                          onChange={() => setOptions({ pdfDates: 'signature' })}
                        />
                        <span className="text-xs text-ink-700">Change to the signature date</span>
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="pdf-date-mode"
                          value="custom"
                          className="h-4 w-4 border-ink-300 text-accent-600 focus:ring-accent-500"
                          checked={options.pdfDates === 'custom'}
                          onChange={() => setOptions({ pdfDates: 'custom' })}
                        />
                        <span className="text-xs text-ink-700">Custom date</span>
                      </label>
                    </fieldset>
                  ) : null}

                  {options.pdfDates === 'custom' ? (
                    <div className="pl-6">
                      <label className="field-label" htmlFor="pdf-custom-date">
                        Custom document date
                      </label>
                      <input
                        id="pdf-custom-date"
                        type="datetime-local"
                        className="text-input"
                        value={options.pdfCustomDate ?? ''}
                        onChange={(event) => setOptions({ pdfCustomDate: event.target.value })}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>

      <section className="panel p-4">
        <SectionTitle>Sign</SectionTitle>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <button
              type="button"
              className="btn btn-secondary w-full"
              disabled={continueDisabled}
              onClick={() => void sign('continue')}
            >
              {signing ? (
                <>
                  <Spinner className="h-4 w-4" />
                  Signing…
                </>
              ) : (
                'Sign, allow more'
              )}
            </button>
            <p className="text-[11px] leading-snug text-ink-500">
              Adds a signature that allows further signatures later.
            </p>
          </div>
          <div className="space-y-1.5">
            <button
              type="button"
              className="btn btn-primary w-full"
              disabled={finalizeDisabled}
              onClick={() => void sign('finalize')}
            >
              {signing ? (
                <>
                  <Spinner className="h-4 w-4" />
                  Signing…
                </>
              ) : (
                'Sign & finalise'
              )}
            </button>
            <p className="text-[11px] leading-snug text-ink-500">
              Creates a certification signature that locks the document.
            </p>
          </div>
        </div>

        {blockedReason ? <p className="mt-3 text-xs text-ink-500">{blockedReason}</p> : null}
        {placements.length > 1 ? (
          <p className="mt-2 text-xs leading-snug text-amber-700">
            A final signature must be a single signature. Remove the extra placements or use “Sign,
            allow more”.
          </p>
        ) : null}
        {hasDummyPlacement ? (
          <p className="mt-2 text-xs leading-snug text-amber-700">
            A final/certification signature needs a real certificate. Remove the dummy signature
            placements or use “Sign, allow more”.
          </p>
        ) : null}
        {inspection?.hasSignatures ? (
          <p className="mt-2 text-xs leading-snug text-amber-700">
            This document already has signatures, so “Sign & finalise” will fall back to an approval
            signature.
          </p>
        ) : null}
      </section>
    </div>
  );
}
