import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { DocumentViewer } from '@/components/DocumentViewer';
import { SignaturePanel } from '@/components/SignaturePanel';
import { CertificateManager } from '@/components/CertificateManager';
import { ResultBanner } from '@/components/ResultBanner';
import { EmptyState } from '@/components/EmptyState';
import { useAppStore } from '@/state/useAppStore';

export function App() {
  const pdfBytes = useAppStore((state) => state.pdfBytes);
  const documentLoading = useAppStore((state) => state.documentLoading);
  const refreshSignatures = useAppStore((state) => state.refreshSignatures);
  const [certificatesOpen, setCertificatesOpen] = useState(false);

  useEffect(() => {
    void refreshSignatures();
  }, [refreshSignatures]);

  const openCertificates = () => setCertificatesOpen(true);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Header onOpenCertificates={openCertificates} />
      <main className="flex min-h-0 flex-1 gap-4 p-4">
        <section className="panel flex min-w-0 flex-1 flex-col overflow-hidden">
          {pdfBytes ? (
            <DocumentViewer />
          ) : (
            <EmptyState loading={documentLoading} onOpenCertificates={openCertificates} />
          )}
        </section>
        <aside className="flex w-[22rem] shrink-0 flex-col gap-4 overflow-y-auto">
          <SignaturePanel onOpenCertificates={openCertificates} />
        </aside>
      </main>
      <CertificateManager open={certificatesOpen} onClose={() => setCertificatesOpen(false)} />
      <ResultBanner />
    </div>
  );
}
