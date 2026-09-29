import { useRef } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { useAppStore } from '@/state/useAppStore';

interface EmptyStateProps {
  loading: boolean;
  onOpenCertificates: () => void;
}

const features: { title: string; body: string; icon: ReactNode }[] = [
  {
    title: 'Invisible signature',
    body: 'Cryptographic only, nothing drawn on the page.',
    icon: (
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
        <path d="M3 3l18 18" />
        <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
        <path d="M9.4 5.1A9.8 9.8 0 0 1 12 4.8c5 0 8.5 4.2 9.6 6.2.2.4.2.9 0 1.3-.4.8-1.3 2-2.5 3.1" />
        <path d="M6.1 6.7C4 8.1 2.7 10 2.1 11.4c-.2.4-.2.9 0 1.3.9 1.7 4.5 6.2 9.9 6.2 1.4 0 2.7-.3 3.8-.8" />
      </svg>
    ),
  },
  {
    title: 'Visible signature',
    body: 'Adobe-style appearance with name, date and check mark.',
    icon: (
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
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
        <path d="M14 3v5h5" />
        <path d="m8.5 14 2 2 3.5-3.5" />
      </svg>
    ),
  },
  {
    title: 'Image signature',
    body: 'Use your own PNG or JPEG as the appearance.',
    icon: (
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
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="m4 18 5-5 4 4 3-3 4 4" />
      </svg>
    ),
  },
];

export function EmptyState({ loading, onOpenCertificates }: EmptyStateProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const openDocument = useAppStore((s) => s.openDocument);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    await openDocument(file.name, new Uint8Array(buffer));
    event.target.value = '';
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center" aria-busy={loading}>
      <span className="text-ink-300">
        <svg viewBox="0 0 96 96" fill="none" className="h-24 w-24" aria-hidden="true">
          <rect x="22" y="10" width="52" height="72" rx="6" stroke="currentColor" strokeWidth="2.5" />
          <path d="M34 28h28M34 40h20" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.55" />
          <path
            d="M31 64c4.5 0 5.5-9 9.5-9s3.5 12 8.5 12 4.5-7 8.5-5"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>

      <h2 className="mt-6 text-xl font-semibold text-ink-900">No PDF loaded</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-500">
        Pecsét signs your documents entirely in the browser. Your file and your certificate never
        leave this device - nothing is uploaded to a server.
      </p>

      {loading ? (
        <div className="mt-7 flex items-center gap-2 text-sm font-medium text-ink-500" role="status">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            className="h-4 w-4 animate-spin text-accent-500"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path
              d="M21 12a9 9 0 0 0-9-9"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
          Reading document…
        </div>
      ) : (
        <>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <input
              ref={fileInput}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={handleFile}
            />
            <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()}>
              Open a PDF
            </button>
            <button type="button" className="btn btn-secondary" onClick={onOpenCertificates}>
              Manage certificates
            </button>
          </div>

          <ul className="mt-10 grid w-full max-w-2xl gap-4 text-left sm:grid-cols-3">
            {features.map((feature) => (
              <li key={feature.title} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-ink-600">
                  {feature.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink-800">{feature.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">{feature.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
