import { useRef } from 'react';
import type { ChangeEvent } from 'react';
import { certificateDisplayName, certificateIdOf, useAppStore } from '@/state/useAppStore';

interface HeaderProps {
  onOpenCertificates: () => void;
}

export function Header({ onOpenCertificates }: HeaderProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const fileName = useAppStore((s) => s.fileName);
  const outcome = useAppStore((s) => s.outcome);
  const pdfBytes = useAppStore((s) => s.pdfBytes);
  const closeDocument = useAppStore((s) => s.closeDocument);
  const openDocument = useAppStore((s) => s.openDocument);
  const activeSigner = useAppStore((s) => s.activeSigner);
  const certificates = useAppStore((s) => s.certificates);
  const dummySigners = useAppStore((s) => s.dummySigners);
  const pageCount = useAppStore((s) => s.inspection?.pageCount);

  const activeCertificate = certificates.find((c) => c.id === certificateIdOf(activeSigner));
  const activeDummy =
    activeSigner?.type === 'dummy' ? dummySigners.find((d) => d.id === activeSigner.id) : undefined;

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    await openDocument(file.name, new Uint8Array(buffer));
    event.target.value = '';
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-ink-200 bg-white px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-600 text-white">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="M12 3 5 6v5.4c0 4.2 2.9 8.1 7 9.6 4.1-1.5 7-5.4 7-9.6V6l-7-3Z" />
            <path d="m9.4 13.6 3.7-3.7a1.15 1.15 0 0 1 1.6 1.6l-3.7 3.7-2.2.6.6-2.2Z" />
          </svg>
        </span>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold text-ink-900">Pecsét</p>
          <p className="truncate text-xs text-ink-500">Client-side · nothing is uploaded</p>
        </div>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-2">
        {fileName && (
          <div className="hidden min-w-0 items-center gap-2 lg:flex">
            <span className="max-w-[16rem] truncate text-xs font-medium text-ink-700" title={fileName}>
              {fileName}
            </span>
            {typeof pageCount === 'number' && (
              <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-[0.7rem] font-medium text-ink-500">
                {pageCount} {pageCount === 1 ? 'page' : 'pages'}
              </span>
            )}
          </div>
        )}

        {activeCertificate && (
          <span className="hidden items-center gap-1.5 rounded-full bg-ink-100 px-2.5 py-1 text-xs font-medium text-ink-700 md:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            <span
              className="max-w-[10rem] truncate"
              title={
                activeCertificate.nameOverride
                  ? `Certificate name: ${activeCertificate.info.commonName}`
                  : undefined
              }
            >
              {certificateDisplayName(activeCertificate)}
            </span>
          </span>
        )}

        {activeDummy && (
          <span className="hidden items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 md:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
            <span className="max-w-[10rem] truncate">{activeDummy.name}</span>
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase leading-none tracking-wide">
              Dummy
            </span>
          </span>
        )}

        {outcome && (
          <span className="hidden rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 sm:inline">
            {outcome.certified ? 'Finalised' : 'Signed'}
          </span>
        )}

        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={handleFile}
        />

        <button type="button" className="btn btn-secondary" onClick={() => fileInput.current?.click()}>
          Open PDF
        </button>

        <button type="button" className="btn btn-ghost" onClick={onOpenCertificates}>
          Certificates
          {certificates.length > 0 && (
            <span className="rounded-full bg-accent-600 px-1.5 py-0.5 text-[0.65rem] font-semibold leading-none text-white">
              {certificates.length}
            </span>
          )}
        </button>

        {pdfBytes && (
          <button type="button" className="btn btn-ghost" onClick={closeDocument}>
            Close
          </button>
        )}
      </div>
    </header>
  );
}
