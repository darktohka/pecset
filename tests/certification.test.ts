import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import { readCertification } from '@/lib/pdf/inspect';

interface BuildOptions {
  permission?: number;
  attachToPerms: boolean;
  omitTransform?: boolean;
}

async function buildDocument(options: BuildOptions): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  const context = doc.context;

  const signatureRef = context.register(
    context.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: [],
      Contents: PDFString.of('00'),
      M: PDFString.fromDate(new Date('2026-01-01T00:00:00Z')),
      ...(options.omitTransform
        ? {}
        : {
            Reference: [
              {
                Type: 'SigRef',
                TransformMethod: 'DocMDP',
                TransformParams: {
                  Type: 'TransformParams',
                  V: '1.2',
                  P: options.permission ?? 1,
                },
                DigestMethod: 'SHA256',
              },
            ],
          }),
    }),
  );

  const fieldRef = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFString.of('CertificationField'),
      V: signatureRef,
    }),
  );

  const acroForm = doc.catalog.getOrCreateAcroForm();
  acroForm.dict.set(PDFName.of('Fields'), context.obj([fieldRef]));

  if (options.attachToPerms) {
    doc.catalog.set(PDFName.of('Perms'), context.obj({ DocMDP: signatureRef }));
  }

  return doc;
}

describe('readCertification', () => {
  it('reads permission 3 from a /Perms /DocMDP certification', async () => {
    const doc = await buildDocument({ permission: 3, attachToPerms: true });

    expect(readCertification(doc)).toEqual({ permission: 3, fieldName: 'CertificationField' });
  });

  it('reads permission 1 from a /Perms /DocMDP certification', async () => {
    const doc = await buildDocument({ permission: 1, attachToPerms: true });

    expect(readCertification(doc)).toEqual({ permission: 1, fieldName: 'CertificationField' });
  });

  it('returns null when the document is not certified', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);

    expect(readCertification(doc)).toBeNull();
  });

  it('finds a DocMDP transform on a field value when /Perms is absent', async () => {
    const doc = await buildDocument({ permission: 2, attachToPerms: false });

    expect(readCertification(doc)).toEqual({ permission: 2, fieldName: 'CertificationField' });
  });

  it('falls back to permission 1 when /P cannot be parsed', async () => {
    const doc = await buildDocument({ attachToPerms: true, omitTransform: true });

    expect(readCertification(doc)).toEqual({ permission: 1, fieldName: 'CertificationField' });
  });
});
