/**
 * Generated, throwaway test fixtures.
 *
 * The repository deliberately ships **no** real certificate, private key, PDF
 * or password. Instead the tests build their own tiny PKCS#12 and PDF in memory
 * so the suite runs from a clean checkout without any secret ever being
 * committed. Nothing here is a real credential and none of it is usable
 * anywhere except in these tests.
 */
import forge from 'node-forge';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';

/** Password of the generated dummy PKCS#12. Not a real secret. */
export const DUMMY_P12_PASSWORD = 'dummy-p12-password';

/** Identity baked into the generated dummy certificate. */
export const DUMMY_IDENTITY = {
  commonName: 'Test Signer',
  email: 'test.signer@example.com',
  issuerCommonName: 'Test Signer',
  country: 'ZZ',
  organization: 'Example Test Org',
} as const;

let cachedP12: Uint8Array | null = null;

/**
 * Build a self-signed PKCS#12 with an AES-256 (PBES2/PBKDF2) shrouded key bag -
 * the same container shape as a modern `.p12`/`.pfx`, so the parser is
 * exercised end to end. Memoised because RSA key generation is not free.
 */
export function createDummyP12Bytes(): Uint8Array {
  if (cachedP12) return cachedP12;

  const keys = forge.pki.rsa.generateKeyPair(2048);

  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date('2024-01-01T00:00:00Z');
  certificate.validity.notAfter = new Date('2034-01-01T00:00:00Z');

  const attributes = [
    { name: 'commonName', value: DUMMY_IDENTITY.commonName },
    { name: 'emailAddress', value: DUMMY_IDENTITY.email },
    { name: 'countryName', shortName: 'C', value: DUMMY_IDENTITY.country },
    { name: 'organizationName', shortName: 'O', value: DUMMY_IDENTITY.organization },
  ];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', emailProtection: true },
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());

  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [certificate], DUMMY_P12_PASSWORD, {
    algorithm: 'aes256',
    useMac: true,
  });
  const der = forge.asn1.toDer(asn1).getBytes();

  cachedP12 = Uint8Array.from(der, (character) => character.charCodeAt(0));
  return cachedP12;
}

const DUMMY_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="dummy-fixture">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreateDate="2020-01-01T00:00:00Z" xmp:ModifyDate="2020-01-01T00:00:00Z" xmp:MetadataDate="2020-01-01T00:00:00Z">
      <xmp:CreateDate>2020-01-01T00:00:00Z</xmp:CreateDate>
      <xmp:ModifyDate>2020-01-01T00:00:00Z</xmp:ModifyDate>
      <xmp:MetadataDate>2020-01-01T00:00:00Z</xmp:MetadataDate>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

let cachedPdf: Promise<Uint8Array> | null = null;

/**
 * Build a single-page PDF that carries an uncompressed XMP packet with the six
 * date fields `applyDocumentDates` rewrites, so the document-date path can be
 * tested without a checked-in reference PDF.
 */
export function createDummyPdfBytes(): Promise<Uint8Array> {
  if (!cachedPdf) {
    cachedPdf = (async () => {
      const doc = await PDFDocument.create();
      doc.addPage([300, 400]);
      const metadata = doc.context.stream(new TextEncoder().encode(DUMMY_XMP), {
        Type: 'Metadata',
        Subtype: 'XML',
      });
      doc.catalog.set(PDFName.of('Metadata'), doc.context.register(metadata));
      return doc.save();
    })();
  }
  return cachedPdf;
}
