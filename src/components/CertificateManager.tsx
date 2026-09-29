import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent, ReactNode } from 'react';
import { probeP12, verifyP12Password } from '@/lib/crypto/p12';
import { certificateIdOf, useAppStore } from '@/state/useAppStore';
import { P12Error } from '@/types';
import type { DummySigner, SignerInfo } from '@/types';

interface CertificateManagerProps {
  open: boolean;
  onClose: () => void;
}

type ValidationState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; info: SignerInfo }
  | { status: 'error'; message: string };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function display(value: string | null): string {
  return value && value.length > 0 ? value : '-';
}

function keyDescription(info: SignerInfo): string {
  return info.keySize > 0 ? `${info.keyAlgorithm} ${info.keySize}-bit` : info.keyAlgorithm;
}

function DetailRow({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={`min-w-0 ${wide ? 'sm:col-span-2' : ''}`}>
      <dt className="text-[0.7rem] font-semibold uppercase tracking-wide text-ink-400">{label}</dt>
      <dd
        className={`mt-0.5 truncate text-sm text-ink-800 ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-ink-400"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{children}</p>;
}

export function CertificateManager({ open, onClose }: CertificateManagerProps) {
  const certificates = useAppStore((state) => state.certificates);
  const activeSigner = useAppStore((state) => state.activeSigner);
  const setActiveSigner = useAppStore((state) => state.setActiveSigner);
  const activeCertificateId = certificateIdOf(activeSigner);
  const removeCertificate = useAppStore((state) => state.removeCertificate);
  const storeCertificate = useAppStore((state) => state.storeCertificate);
  const setCertificateNameOverride = useAppStore((state) => state.setCertificateNameOverride);

  const dummySigners = useAppStore((state) => state.dummySigners);
  const addDummySigner = useAppStore((state) => state.addDummySigner);
  const updateDummySigner = useAppStore((state) => state.updateDummySigner);
  const removeDummySigner = useAppStore((state) => state.removeDummySigner);

  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const copiedTimerRef = useRef<number | null>(null);
  const confirmTimerRef = useRef<number | null>(null);
  const dummyConfirmTimerRef = useRef<number | null>(null);

  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [pendingRemoveDummyId, setPendingRemoveDummyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});
  const [savingOverrideId, setSavingOverrideId] = useState<string | null>(null);

  const [dummyName, setDummyName] = useState('');
  const [dummyDescription, setDummyDescription] = useState('');
  const [editingDummyId, setEditingDummyId] = useState<string | null>(null);
  const [dummyEditName, setDummyEditName] = useState('');
  const [dummyEditDescription, setDummyEditDescription] = useState('');

  const [importFile, setImportFile] = useState<File | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [label, setLabel] = useState('');
  const [validation, setValidation] = useState<ValidationState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
      if (dummyConfirmTimerRef.current !== null) window.clearTimeout(dummyConfirmTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!open || !bytes || probeError) return;
    if (passwordRequired && password.length === 0) {
      setValidation({ status: 'idle' });
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setValidation({ status: 'checking' });
    const timer = window.setTimeout(
      () => {
        if (requestRef.current !== requestId) return;
        const result = verifyP12Password(bytes, password);
        if (requestRef.current !== requestId) return;
        if (result.ok) setValidation({ status: 'ok', info: result.info });
        else setValidation({ status: 'error', message: result.message });
      },
      passwordRequired ? 250 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [open, bytes, password, passwordRequired, probeError]);

  const resetImport = () => {
    requestRef.current += 1;
    setImportFile(null);
    setBytes(null);
    setProbeError(null);
    setPasswordRequired(false);
    setPassword('');
    setRemember(false);
    setLabel('');
    setValidation({ status: 'idle' });
    setSaveError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const applyFile = async (file: File) => {
    setProbeError(null);
    setSaveError(null);
    setValidation({ status: 'idle' });
    setPassword('');
    setRemember(false);
    setLabel(file.name);
    setImportFile(file);
    setBytes(null);
    try {
      const buffer = await file.arrayBuffer();
      const nextBytes = new Uint8Array(buffer);
      setBytes(nextBytes);
      const probe = probeP12(nextBytes);
      setPasswordRequired(probe.passwordRequired);
      if (probe.info) setValidation({ status: 'ok', info: probe.info });
    } catch (error) {
      setImportFile(null);
      setBytes(null);
      setPasswordRequired(false);
      setProbeError(
        error instanceof P12Error ? error.message : 'This file could not be read.',
      );
    }
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void applyFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void applyFile(file);
  };

  const handleCopy = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(id);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setCopiedId(null);
    }
  };

  const handleRemove = async (id: string) => {
    if (pendingRemoveId !== id) {
      setPendingRemoveId(id);
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = window.setTimeout(() => setPendingRemoveId(null), 4000);
      return;
    }
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    setPendingRemoveId(null);
    await removeCertificate(id);
  };

  const handleUse = (id: string) => {
    setActiveSigner({ type: 'certificate', id });
    onClose();
  };

  const handleSaveOverride = async (id: string) => {
    const draft = (overrideDrafts[id] ?? '').trim();
    setSavingOverrideId(id);
    try {
      await setCertificateNameOverride(id, draft.length > 0 ? draft : null);
      setOverrideDrafts((prev) => ({ ...prev, [id]: draft }));
    } finally {
      setSavingOverrideId(null);
    }
  };

  const handleResetOverride = async (id: string) => {
    setSavingOverrideId(id);
    try {
      await setCertificateNameOverride(id, null);
      setOverrideDrafts((prev) => ({ ...prev, [id]: '' }));
    } finally {
      setSavingOverrideId(null);
    }
  };

  const handleCreateDummy = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = dummyName.trim();
    if (name.length === 0) return;
    await addDummySigner({ name, description: dummyDescription.trim() });
    setDummyName('');
    setDummyDescription('');
  };

  const handleUseDummy = (id: string) => {
    setActiveSigner({ type: 'dummy', id });
    onClose();
  };

  const startDummyEdit = (signer: DummySigner) => {
    setEditingDummyId(signer.id);
    setDummyEditName(signer.name);
    setDummyEditDescription(signer.description);
  };

  const handleSaveDummyEdit = async (id: string) => {
    const name = dummyEditName.trim();
    if (name.length === 0) return;
    await updateDummySigner(id, { name, description: dummyEditDescription.trim() });
    setEditingDummyId(null);
  };

  const handleRemoveDummy = async (id: string) => {
    if (pendingRemoveDummyId !== id) {
      setPendingRemoveDummyId(id);
      if (dummyConfirmTimerRef.current !== null) window.clearTimeout(dummyConfirmTimerRef.current);
      dummyConfirmTimerRef.current = window.setTimeout(() => setPendingRemoveDummyId(null), 4000);
      return;
    }
    if (dummyConfirmTimerRef.current !== null) window.clearTimeout(dummyConfirmTimerRef.current);
    setPendingRemoveDummyId(null);
    await removeDummySigner(id);
  };

  const handleSave = async () => {
    if (!importFile || !bytes || validation.status !== 'ok') return;
    setSaving(true);
    setSaveError(null);
    try {
      await storeCertificate({
        fileName: importFile.name,
        p12Bytes: bytes,
        info: validation.info,
        label: label.trim() || importFile.name,
        password,
        rememberPassword: remember,
      });
      resetImport();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The certificate could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-950/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="certificate-manager-title"
        tabIndex={-1}
        className="panel max-h-[85vh] w-full max-w-3xl overflow-y-auto outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-ink-200 p-5">
          <div className="min-w-0">
            <h2 id="certificate-manager-title" className="text-lg font-semibold text-ink-900">
              Certificates
            </h2>
            <p className="mt-1 text-sm text-ink-500">
              Certificates, dummy signatures and passwords are stored only in this browser&apos;s
              IndexedDB and are never uploaded. Dummy signatures are managed here.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost -mr-2 -mt-1 shrink-0 px-2"
            onClick={onClose}
            aria-label="Close certificates dialog"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <path d="M6 6 18 18M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="space-y-6 p-5">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink-900">Stored certificates</h3>
              <span className="text-xs text-ink-500">
                {certificates.length} {certificates.length === 1 ? 'certificate' : 'certificates'}
              </span>
            </div>

            {certificates.length === 0 ? (
              <div className="rounded-lg border border-dashed border-ink-200 bg-ink-50 px-4 py-8 text-center">
                <p className="text-sm font-medium text-ink-700">No certificates stored yet</p>
                <p className="mt-1 text-xs text-ink-500">
                  Import a .p12 or .pfx file below to get started.
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {certificates.map((certificate) => {
                  const info = certificate.info;
                  const isActive = certificate.id === activeCertificateId;
                  const isPending = pendingRemoveId === certificate.id;
                  const nearExpiry = !info.isExpired && info.daysUntilExpiry <= 30;
                  const storedOverride = certificate.nameOverride ?? '';
                  const draftOverride = overrideDrafts[certificate.id] ?? storedOverride;
                  const hasOverride = storedOverride.trim().length > 0;
                  const overrideDirty = draftOverride.trim() !== storedOverride.trim();
                  const savingOverride = savingOverrideId === certificate.id;
                  return (
                    <li
                      key={certificate.id}
                      className="rounded-lg border border-ink-200 bg-white p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold text-ink-900">
                              {certificate.label}
                            </p>
                            {isActive && (
                              <span className="rounded-full bg-accent-600 px-2 py-0.5 text-[0.7rem] font-semibold text-white">
                                In use
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 truncate text-xs text-ink-500">
                            {certificate.fileName}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => handleUse(certificate.id)}
                          >
                            Use
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => void handleRemove(certificate.id)}
                          >
                            {isPending ? 'Confirm remove?' : 'Remove'}
                          </button>
                        </div>
                      </div>

                      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                        <DetailRow label="Common name" value={info.commonName} />
                        <DetailRow label="Email" value={display(info.email)} />
                        <DetailRow label="Organization" value={display(info.organization)} />
                        <DetailRow label="Issuer" value={display(info.issuerCommonName)} />
                        <DetailRow label="Serial number" value={info.serialNumber} mono />
                      </dl>

                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-600">
                        <span>
                          {formatDate(info.notBefore)} – {formatDate(info.notAfter)}
                        </span>
                        {info.isExpired && (
                          <span className="rounded-full bg-red-50 px-2 py-0.5 text-[0.7rem] font-semibold text-red-700">
                            Expired
                          </span>
                        )}
                        {nearExpiry && (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[0.7rem] font-semibold text-amber-700">
                            Expires in {info.daysUntilExpiry}{' '}
                            {info.daysUntilExpiry === 1 ? 'day' : 'days'}
                          </span>
                        )}
                      </div>

                      <div className="mt-3 flex items-center gap-2">
                        <span className="shrink-0 text-[0.7rem] font-semibold uppercase tracking-wide text-ink-400">
                          SHA-256
                        </span>
                        <code
                          className="min-w-0 flex-1 truncate font-mono text-xs text-ink-600"
                          title={info.fingerprintSha256}
                        >
                          {info.fingerprintSha256}
                        </code>
                        <button
                          type="button"
                          className="btn btn-ghost shrink-0 px-2 py-1 text-xs"
                          onClick={() => void handleCopy(certificate.id, info.fingerprintSha256)}
                        >
                          {copiedId === certificate.id ? 'Copied' : 'Copy'}
                        </button>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[0.7rem] font-medium ${
                            certificate.passwordStored
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-ink-100 text-ink-500'
                          }`}
                        >
                          {certificate.passwordStored ? 'Password saved' : 'Password not saved'}
                        </span>
                        <span className="text-[0.7rem] text-ink-400">
                          Added {formatDate(certificate.addedAt)}
                        </span>
                      </div>

                      <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label
                            className="field-label mb-0"
                            htmlFor={`certificate-name-override-${certificate.id}`}
                          >
                            Signature appearance name
                          </label>
                          {hasOverride && (
                            <span className="rounded-full bg-accent-500/10 px-2 py-0.5 text-[0.7rem] font-semibold text-accent-700">
                              Name overridden
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <input
                            id={`certificate-name-override-${certificate.id}`}
                            type="text"
                            className="text-input min-w-0 flex-1"
                            value={draftOverride}
                            placeholder={info.commonName}
                            onChange={(event) =>
                              setOverrideDrafts((prev) => ({
                                ...prev,
                                [certificate.id]: event.target.value,
                              }))
                            }
                            disabled={savingOverride}
                          />
                          <button
                            type="button"
                            className="btn btn-secondary shrink-0"
                            onClick={() => void handleSaveOverride(certificate.id)}
                            disabled={!overrideDirty || savingOverride}
                          >
                            {savingOverride ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost shrink-0"
                            onClick={() => void handleResetOverride(certificate.id)}
                            disabled={!hasOverride || savingOverride}
                          >
                            Reset
                          </button>
                        </div>
                        <p className="mt-1.5 text-[0.7rem] leading-snug text-ink-500">
                          This name is what the Adobe-style signature displays. The
                          certificate&apos;s cryptographic identity is unchanged.
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink-900">Dummy signatures</h3>
              <span className="text-xs text-ink-500">
                {dummySigners.length} {dummySigners.length === 1 ? 'dummy' : 'dummies'}
              </span>
            </div>
            <p className="mb-3 text-xs leading-snug text-ink-500">
              A dummy signature has no certificate. Its visible mark is added to the page, but no
              digital signature is created.
            </p>

            <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => void handleCreateDummy(event)}>
              <div>
                <label className="field-label" htmlFor="dummy-name">
                  Name
                </label>
                <input
                  id="dummy-name"
                  type="text"
                  className="text-input"
                  value={dummyName}
                  onChange={(event) => setDummyName(event.target.value)}
                  placeholder="e.g. Jane Doe"
                  required
                />
              </div>
              <div>
                <label className="field-label" htmlFor="dummy-description">
                  Description
                </label>
                <input
                  id="dummy-description"
                  type="text"
                  className="text-input"
                  value={dummyDescription}
                  onChange={(event) => setDummyDescription(event.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="flex justify-end sm:col-span-2">
                <button
                  type="submit"
                  className="btn btn-secondary"
                  disabled={dummyName.trim().length === 0}
                >
                  Create dummy
                </button>
              </div>
            </form>

            {dummySigners.length === 0 ? (
              <p className="mt-3 text-xs text-ink-400">
                No dummy signatures yet. Create one above to add a visible-only signer.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {dummySigners.map((signer) => {
                  const editing = editingDummyId === signer.id;
                  const pending = pendingRemoveDummyId === signer.id;
                  const isActive = activeSigner?.type === 'dummy' && activeSigner.id === signer.id;
                  return (
                    <li
                      key={signer.id}
                      className={`rounded-lg border p-3 ${
                        isActive ? 'border-accent-500 bg-accent-500/5' : 'border-ink-200 bg-white'
                      }`}
                    >
                      {editing ? (
                        <div className="space-y-2">
                          <div>
                            <label className="field-label" htmlFor={`dummy-edit-name-${signer.id}`}>
                              Name
                            </label>
                            <input
                              id={`dummy-edit-name-${signer.id}`}
                              type="text"
                              className="text-input"
                              value={dummyEditName}
                              onChange={(event) => setDummyEditName(event.target.value)}
                            />
                          </div>
                          <div>
                            <label
                              className="field-label"
                              htmlFor={`dummy-edit-description-${signer.id}`}
                            >
                              Description
                            </label>
                            <input
                              id={`dummy-edit-description-${signer.id}`}
                              type="text"
                              className="text-input"
                              value={dummyEditDescription}
                              onChange={(event) => setDummyEditDescription(event.target.value)}
                              placeholder="Optional"
                            />
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => setEditingDummyId(null)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={dummyEditName.trim().length === 0}
                              onClick={() => void handleSaveDummyEdit(signer.id)}
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p
                                className="truncate text-sm font-semibold text-ink-900"
                                title={signer.name}
                              >
                                {signer.name}
                              </p>
                              <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wide text-amber-700">
                                Dummy
                              </span>
                              {isActive && (
                                <span className="rounded-full bg-accent-600 px-2 py-0.5 text-[0.7rem] font-semibold text-white">
                                  In use
                                </span>
                              )}
                            </div>
                            {signer.description.length > 0 && (
                              <p
                                className="mt-0.5 truncate text-xs text-ink-500"
                                title={signer.description}
                              >
                                {signer.description}
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => handleUseDummy(signer.id)}
                            >
                              Use
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => startDummyEdit(signer)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger"
                              onClick={() => void handleRemoveDummy(signer.id)}
                            >
                              {pending ? 'Confirm remove?' : 'Remove'}
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-3 text-sm font-semibold text-ink-900">Import a certificate</h3>

            <label
              htmlFor="certificate-file-input"
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
                dragging
                  ? 'border-accent-500 bg-accent-400/10'
                  : 'border-ink-200 bg-ink-50 hover:border-accent-400'
              }`}
            >
              <input
                id="certificate-file-input"
                ref={fileInputRef}
                type="file"
                accept=".p12,.pfx,application/x-pkcs12"
                className="hidden"
                onChange={handleFileInput}
              />
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-6 w-6 text-ink-400"
                aria-hidden="true"
              >
                <path d="M12 16V4m0 0L8 8m4-4 4 4" />
                <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              <span className="mt-2 text-sm font-medium text-ink-800">
                {importFile ? importFile.name : 'Drop a .p12 or .pfx file here'}
              </span>
              <span className="mt-0.5 text-xs text-ink-500">
                {importFile ? 'Choose a different file' : 'or click to browse'}
              </span>
            </label>

            {probeError && (
              <div className="mt-4">
                <ErrorNote>{probeError}</ErrorNote>
              </div>
            )}

            {bytes && !probeError && (
              <div className="mt-4 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="field-label" htmlFor="certificate-label">
                      Label
                    </label>
                    <input
                      id="certificate-label"
                      type="text"
                      className="text-input"
                      value={label}
                      onChange={(event) => setLabel(event.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="certificate-password">
                      Password
                    </label>
                    <input
                      id="certificate-password"
                      type="password"
                      className="text-input"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder={passwordRequired ? 'Required' : 'Not required'}
                      autoComplete="off"
                      disabled={saving}
                    />
                  </div>
                </div>

                <div aria-live="polite" className="space-y-3">
                  {validation.status === 'checking' && (
                    <p className="flex items-center gap-2 text-sm text-ink-500">
                      <Spinner />
                      Checking password…
                    </p>
                  )}

                  {validation.status === 'error' && <ErrorNote>{validation.message}</ErrorNote>}

                  {validation.status === 'ok' && (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                      <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-800">
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-4 w-4"
                          aria-hidden="true"
                        >
                          <path d="m5 12 5 5L20 7" />
                        </svg>
                        Certificate verified
                      </p>
                      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                        <DetailRow label="Common name" value={validation.info.commonName} />
                        <DetailRow label="Email" value={display(validation.info.email)} />
                        <DetailRow
                          label="Organization"
                          value={display(validation.info.organization)}
                        />
                        <DetailRow
                          label="Organizational unit"
                          value={display(validation.info.organizationalUnit)}
                        />
                        <DetailRow label="Country" value={display(validation.info.country)} />
                        <DetailRow label="Locality" value={display(validation.info.locality)} />
                        <DetailRow label="State" value={display(validation.info.state)} />
                        <DetailRow
                          label="Issuer"
                          value={display(validation.info.issuerCommonName)}
                        />
                        <DetailRow
                          label="Serial number"
                          value={validation.info.serialNumber}
                          mono
                        />
                        <DetailRow label="Key" value={keyDescription(validation.info)} />
                        <DetailRow
                          label="Valid from"
                          value={formatDate(validation.info.notBefore)}
                        />
                        <DetailRow
                          label="Valid until"
                          value={formatDate(validation.info.notAfter)}
                        />
                        <DetailRow
                          label="SHA-256 fingerprint"
                          value={validation.info.fingerprintSha256}
                          mono
                          wide
                        />
                      </dl>
                    </div>
                  )}
                </div>

                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-ink-300 text-accent-600 focus:ring-accent-500"
                    checked={remember}
                    onChange={(event) => setRemember(event.target.checked)}
                    disabled={saving}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink-800">
                      Remember this password in this browser
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-500">
                      The password is saved in IndexedDB next to the certificate. Leave unchecked to
                      enter it each time you sign.
                    </span>
                  </span>
                </label>

                {saveError && <ErrorNote>{saveError}</ErrorNote>}

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={resetImport}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleSave()}
                    disabled={validation.status !== 'ok' || saving}
                  >
                    {saving ? 'Saving…' : 'Save certificate'}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
