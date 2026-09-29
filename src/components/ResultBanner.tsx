import { useAppStore } from '@/state/useAppStore';

/** Host of a timestamp authority URL, falling back to the raw value when unparseable. */
function timestampHost(authority: string | null): string {
  if (!authority) return 'the timestamp authority';
  try {
    return new URL(authority).host;
  } catch {
    return authority;
  }
}

export function ResultBanner() {
  const outcome = useAppStore((s) => s.outcome);
  const resetOutcome = useAppStore((s) => s.resetOutcome);
  const signError = useAppStore((s) => s.signError);
  const setSignError = useAppStore((s) => s.setSignError);

  if (!outcome && !signError) return null;

  const shell =
    'panel fixed bottom-5 right-5 z-50 w-[26rem] max-w-[calc(100vw-2.5rem)] p-4 shadow-lg';

  if (!outcome) {
    return (
      <section className={`${shell} border-red-200 bg-red-50`} role="alert">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-700">
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
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-red-900">Could not sign the document</h3>
            <p className="mt-1 break-words text-xs leading-relaxed text-red-800">{signError}</p>
            <div className="mt-3">
              <button type="button" className="btn btn-ghost" onClick={() => setSignError(null)}>
                Dismiss
              </button>
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            className="btn btn-ghost -mr-1 -mt-1 px-2 py-1"
            onClick={() => setSignError(null)}
          >
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
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </section>
    );
  }

  const addedKb = (outcome.incrementalByteLength / 1024).toFixed(1);

  const summaryParts: string[] = [];
  if (outcome.fieldNames.length > 0) {
    summaryParts.push(
      `${outcome.fieldNames.length} digital signature${outcome.fieldNames.length === 1 ? '' : 's'}`,
    );
  }
  if (outcome.dummyNames.length > 0) {
    summaryParts.push(
      `${outcome.dummyNames.length} dummy mark${outcome.dummyNames.length === 1 ? '' : 's'} - not digitally signed`,
    );
  }

  const handleDownload = () => {
    const blob = new Blob([outcome.pdfBytes.slice()], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = outcome.fileName;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className={`${shell} border-emerald-200 bg-emerald-50`} role="status">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="m5 12.5 4.5 4.5L19 7" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-emerald-900">
            {outcome.certified
              ? 'Document finalised'
              : outcome.fieldNames.length > 0
                ? 'Signatures applied'
                : 'Dummy signature applied'}
          </h3>
          <p className="mt-1 truncate text-xs font-medium text-emerald-800" title={outcome.fileName}>
            {outcome.fileName}
          </p>
          {summaryParts.length > 0 && (
            <p className="mt-1 break-words text-xs text-emerald-800">{summaryParts.join(' · ')}</p>
          )}
          <p className="mt-1 text-xs text-emerald-700">added {addedKb} KB</p>

          {outcome.timestamped && (
            <p className="mt-1 break-words text-xs text-emerald-800">
              Timestamped by {timestampHost(outcome.timestampAuthority)}
            </p>
          )}

          {outcome.documentDatesChanged && (
            <p className="mt-1 text-xs text-emerald-700">
              PDF creation/modification date changed
            </p>
          )}

          {outcome.dummyNames.length > 0 && (
            <p className="mt-2 rounded-md bg-amber-100 px-2 py-1 text-xs leading-relaxed text-amber-800">
              Dummy marks are visual only: no certificate backs them and no digital signature was
              created.
            </p>
          )}

          {outcome.warnings.map((warning, index) => (
            <p
              key={`${warning}-${index}`}
              className="mt-2 rounded-md bg-amber-100 px-2 py-1 text-xs leading-relaxed text-amber-800"
            >
              {warning}
            </p>
          ))}

          <div className="mt-3 flex items-center gap-2">
            <button type="button" className="btn btn-primary" onClick={handleDownload}>
              Download
            </button>
            <button type="button" className="btn btn-ghost" onClick={resetOutcome}>
              Dismiss
            </button>
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          className="btn btn-ghost -mr-1 -mt-1 px-2 py-1"
          onClick={resetOutcome}
        >
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
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </section>
  );
}
