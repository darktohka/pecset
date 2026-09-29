/**
 * End-to-end check of the signing engine against local assets.
 *
 *   VERIFY_P12_PASSWORD=… bun run verify:sign
 *
 * Signs Digitalsignature_example.pdf (which already contains a signature) with
 * the local signer.p12 three times - an Adobe-style visible signature, a custom
 * image signature and a rotated Adobe-style signature - then writes the result
 * to out/ and (when available) runs `pdfsig` over it.
 *
 * The PDF and PKCS#12 are not committed (`.gitignore` excludes `*.pdf`/`*.p12`),
 * so provide them locally. Override the names with VERIFY_PDF / VERIFY_P12.
 */
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument } from '@cantoo/pdf-lib';

import { loadP12, probeP12 } from '../src/lib/crypto/p12';
import { DEFAULT_TSA_URL, OID_SIGNATURE_TIME_STAMP } from '../src/lib/crypto/timestamp';
import { toXmpDate } from '../src/lib/pdf/documentDates';
import { inspectPdf } from '../src/lib/pdf/inspect';
import { signPdf } from '../src/lib/pdf/sign';
import type { SignaturePlacement, SignerRef } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'out');
const pdfFile = process.env.VERIFY_PDF ?? 'Digitalsignature_example.pdf';
const p12File = process.env.VERIFY_P12 ?? 'signer.p12';

/* ----------------------------- tiny PNG encoder ---------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

function makePng(width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = rowStart + 1 + x * 4;
      const border = x < 6 || y < 6 || x >= width - 6 || y >= height - 6;
      raw[i] = border ? 20 : 245;
      raw[i + 1] = border ? 90 : 245;
      raw[i + 2] = border ? 160 : 250;
      raw[i + 3] = border ? 255 : 200;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function toDataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

/* ---------------------------- verification helpers -------------------------- */

/**
 * Run a command and return its stdout, even when the command exits non-zero
 * (e.g. `pdfsig` may report "Certificate has Expired"). Returns `null` only
 * when the command could not be executed or produced no stdout.
 */
function executableOutput(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error) {
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === 'string') return stdout;
      if (stdout instanceof Uint8Array) return new TextDecoder('utf8').decode(stdout);
    }
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const length = Math.floor(clean.length / 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Extract the DER of the LAST signature's CMS blob from the PDF `/Contents`
 * hex literal, trimming the zero padding to the ASN.1 total length.
 *
 * Returns `null` when the literal cannot be found (the signer may have written
 * the signature dictionary into an object stream) or its DER header is not a
 * plain `SEQUENCE`.
 */
function extractTrailingCms(pdfBytes: Uint8Array): Uint8Array | null {
  const text = new TextDecoder('latin1').decode(pdfBytes);
  const marker = text.lastIndexOf('/Contents');
  if (marker < 0) return null;
  const open = text.indexOf('<', marker);
  const close = open < 0 ? -1 : text.indexOf('>', open);
  if (open < 0 || close < 0) return null;

  const decoded = hexToBytes(text.slice(open + 1, close));
  if (decoded.length < 2 || decoded[0] !== 0x30) return null;

  const second = decoded[1];
  let total: number;
  if (second === 0x82) {
    if (decoded.length < 4) return null;
    total = 4 + ((decoded[2] << 8) | decoded[3]);
  } else if (second === 0x81) {
    if (decoded.length < 3) return null;
    total = 3 + decoded[2];
  } else if (second < 0x80) {
    total = 2 + second;
  } else {
    return null;
  }
  if (total < 2 || total > decoded.length) return null;
  return decoded.subarray(0, total);
}

/* ---------------------------------- main ---------------------------------- */

async function main(): Promise<void> {
  const pdfBytes = new Uint8Array(readFileSync(join(root, pdfFile)));
  const p12Bytes = new Uint8Array(readFileSync(join(root, p12File)));

  const probe = probeP12(p12Bytes);
  console.log(`probe: passwordRequired=${probe.passwordRequired}`);

  const password = process.env.VERIFY_P12_PASSWORD;
  if (!password) {
    throw new Error(
      `Set VERIFY_P12_PASSWORD to the password of the local ${p12File} before running verify:sign.`,
    );
  }
  const certificate = loadP12(p12Bytes, password);
  console.log(`signer: ${certificate.info.commonName} <${certificate.info.email}>`);
  console.log(`issuer: ${certificate.info.issuerCommonName}`);
  console.log(`valid:  ${certificate.info.notBefore} .. ${certificate.info.notAfter}`);
  console.log(`key:    ${certificate.info.keyAlgorithm} ${certificate.info.keySize}`);
  console.log(`sha256: ${certificate.info.fingerprintSha256}`);
  console.log(`chain:  ${certificate.chain.length} certificate(s)`);

  const before = await inspectPdf(pdfBytes);
  console.log(
    `before: ${before.pageCount} pages, signatures=${before.signatureCount} ` +
      `[${before.signatureFields.map((f) => `${f.name}:${f.signed}`).join(', ')}]`,
  );

  const certificateSigner: SignerRef = { type: 'certificate', id: 'verify-certificate' };
  const dummySigner: SignerRef = { type: 'dummy', id: 'verify-dummy' };
  const dummyLabel = 'Dummy Signer';
  const certificates = new Map([['verify-certificate', certificate]]);
  const dummyNames = new Map([['verify-dummy', dummyLabel]]);
  const overrideName = 'Overridden Signer Name';
  const certificateNames = new Map([['verify-certificate', overrideName]]);

  const placements: SignaturePlacement[] = [
    {
      id: 'a',
      kind: 'adobe',
      pageIndex: 0,
      cx: 400,
      cy: 700,
      width: 190,
      height: 65,
      rotation: 0,
      signer: certificateSigner,
    },
    {
      id: 'b',
      kind: 'image',
      pageIndex: 1,
      cx: 300,
      cy: 500,
      width: 160,
      height: 60,
      rotation: 0,
      imageDataUrl: toDataUrl(makePng(240, 90)),
      signer: certificateSigner,
    },
    {
      id: 'c',
      kind: 'adobe',
      pageIndex: 2,
      cx: 300,
      cy: 200,
      width: 190,
      height: 65,
      rotation: 20,
      signer: certificateSigner,
    },
    {
      id: 'd',
      kind: 'invisible',
      pageIndex: 0,
      cx: 0,
      cy: 0,
      width: 0,
      height: 0,
      rotation: 0,
      signer: certificateSigner,
    },
    {
      id: 'e',
      kind: 'adobe',
      pageIndex: 0,
      cx: 150,
      cy: 120,
      width: 190,
      height: 65,
      rotation: 0,
      signer: dummySigner,
    },
  ];

  const result = await signPdf({
    pdfBytes,
    placements,
    certificates,
    dummyNames,
    certificateNames,
    options: { chainMode: 'continue', reason: 'Approved for internal use', location: 'New York' },
    signingTime: new Date('2026-09-29T12:00:00Z'),
  });

  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'signed-chain.pdf');
  writeFileSync(outFile, result.pdfBytes);

  console.log(`\nsigned: ${result.byteLength} bytes (+${result.incrementalByteLength} appended)`);
  console.log(`fields: ${result.signatureFieldNames.join(', ')}`);
  console.log(`dummies: ${result.dummyNames.join(', ') || '(none)'}`);
  console.log(`certified: ${result.certified}`);
  for (const warning of result.warnings) console.log(`warning: ${warning}`);
  console.log(`written: ${outFile}`);

  const after = await inspectPdf(result.pdfBytes);
  console.log(
    `after:  ${after.pageCount} pages, signatures=${after.signatureCount} ` +
      `[${after.signatureFields.map((f) => `${f.name}:${f.signed}`).join(', ')}]`,
  );

  const problems: string[] = [];
  if (!result.dummyNames.includes(dummyLabel)) {
    problems.push(`the dummy name was not reported in dummyNames: ${JSON.stringify(result.dummyNames)}`);
  }
  if (after.signatureCount !== before.signatureCount + 4) {
    problems.push(
      `expected ${before.signatureCount + 4} signatures after the dummy stamp, found ${after.signatureCount}`,
    );
  }
  if (after.signatureFields.some((field) => field.name === dummyLabel)) {
    problems.push(`the dummy name "${dummyLabel}" was registered as a signature field`);
  }
  if (!new TextDecoder('latin1').decode(result.pdfBytes).includes('/Stamp')) {
    problems.push('the output does not contain a /Stamp annotation');
  }
  if (!new TextDecoder('latin1').decode(result.pdfBytes).includes(overrideName)) {
    problems.push(`the overridden certificate name "${overrideName}" was not written to the output`);
  }
  try {
    const output = execFileSync('pdfsig', [outFile], { encoding: 'utf8', stdio: 'pipe' });
    console.log('\n--- pdfsig ---\n' + output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\n(pdfsig not available or reported an error: ${message})`);
  }

  /* --------------------------- pass 2: RFC 3161 timestamp ------------------- */
  console.log('\n=== pass 2: RFC 3161 timestamped signature ===');
  const tsDoc = new Uint8Array(readFileSync(join(root, pdfFile)));
  const tsPlacement: SignaturePlacement = {
    id: 'ts',
    kind: 'adobe',
    pageIndex: 0,
    cx: 400,
    cy: 700,
    width: 190,
    height: 65,
    rotation: 0,
    signer: certificateSigner,
  };
  const tsResult = await signPdf({
    pdfBytes: tsDoc,
    placements: [tsPlacement],
    certificates,
    dummyNames,
    certificateNames,
    options: { chainMode: 'continue', reason: 'Timestamped' },
    timestamp: { url: DEFAULT_TSA_URL },
  });
  const tsFile = join(outDir, 'signed-timestamped.pdf');
  writeFileSync(tsFile, tsResult.pdfBytes);
  console.log(`signed:      ${tsResult.byteLength} bytes`);
  console.log(`timestamped: ${tsResult.timestamped}`);
  console.log(`authority:   ${tsResult.timestampAuthority ?? '(none)'}`);
  console.log(`signingTime: ${tsResult.signingTime}`);
  console.log(`written: ${tsFile}`);

  if (tsResult.timestamped !== true) {
    problems.push('the timestamped pass did not report timestamped=true');
  }
  if (tsResult.timestampAuthority !== DEFAULT_TSA_URL) {
    problems.push(
      `expected timestampAuthority "${DEFAULT_TSA_URL}", got ${JSON.stringify(tsResult.timestampAuthority)}`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(tsResult.signingTime)) {
    problems.push(`signingTime is not an ISO-8601 timestamp: ${tsResult.signingTime}`);
  }

  const timestampedCms = extractTrailingCms(tsResult.pdfBytes);
  if (timestampedCms) {
    const p7sFile = join(outDir, 'signature-timestamped.p7s');
    writeFileSync(p7sFile, timestampedCms);
    const opensslOut = executableOutput('openssl', [
      'cms',
      '-cmsout',
      '-print',
      '-inform',
      'DER',
      '-in',
      p7sFile,
    ]);
    if (opensslOut === null) {
      problems.push('openssl could not decode out/signature-timestamped.p7s');
    } else if (!opensslOut.includes(OID_SIGNATURE_TIME_STAMP)) {
      problems.push(
        `the timestamped CMS does not carry the RFC 3161 attribute ${OID_SIGNATURE_TIME_STAMP}`,
      );
    } else {
      console.log(`cms: RFC 3161 attribute ${OID_SIGNATURE_TIME_STAMP} present (openssl)`);
    }
  } else {
    console.log(
      'warning: could not locate the /Contents hex literal in out/signed-timestamped.pdf ' +
        '(the signature dictionary may live in an object stream); falling back to the ' +
        'CryptoResult flags and pdfsig validity only',
    );
  }

  const tsPdfsig = executableOutput('pdfsig', [tsFile]);
  if (tsPdfsig === null) {
    problems.push('pdfsig could not read out/signed-timestamped.pdf');
  } else {
    console.log('\n--- pdfsig (timestamped) ---\n' + tsPdfsig);
    if (!tsPdfsig.includes('Signature is Valid.')) {
      problems.push('pdfsig did not report the timestamped signature as valid');
    }
  }

  /* ------------------- pass 3: custom signing/document dates ---------------- */
  console.log('\n=== pass 3: custom signing + document dates ===');
  const customDoc = new Uint8Array(readFileSync(join(root, pdfFile)));
  const customPlacement: SignaturePlacement = {
    id: 'custom-date',
    kind: 'adobe',
    pageIndex: 0,
    cx: 400,
    cy: 700,
    width: 190,
    height: 65,
    rotation: 0,
    signer: certificateSigner,
  };
  const signatureDate = new Date('2024-05-06T07:08:09');
  const documentDate = new Date('2023-01-02T03:04:05');
  const customResult = await signPdf({
    pdfBytes: customDoc,
    placements: [customPlacement],
    certificates,
    dummyNames,
    certificateNames,
    options: { chainMode: 'continue', signingTimeMode: 'custom', pdfDates: 'custom' },
    signingTime: signatureDate,
    documentDates: documentDate,
  });
  const customFile = join(outDir, 'signed-custom-date.pdf');
  writeFileSync(customFile, customResult.pdfBytes);
  console.log(`signed:               ${customResult.byteLength} bytes`);
  console.log(`documentDatesChanged: ${customResult.documentDatesChanged}`);
  console.log(`timestamped:          ${customResult.timestamped}`);
  console.log(`signingTime:          ${customResult.signingTime}`);
  console.log(`written: ${customFile}`);

  if (customResult.documentDatesChanged !== true) {
    problems.push('the custom-date pass did not report documentDatesChanged=true');
  }
  if (customResult.timestamped !== false) {
    problems.push('the custom-date pass unexpectedly reported timestamped=true');
  }
  if (customResult.signingTime !== signatureDate.toISOString()) {
    problems.push(
      `expected signingTime ${signatureDate.toISOString()}, got ${customResult.signingTime}`,
    );
  }

  const reloaded = await PDFDocument.load(customResult.pdfBytes, { updateMetadata: false });
  if (reloaded.getCreationDate()?.toISOString() !== documentDate.toISOString()) {
    problems.push(
      `Info /CreationDate was not rewritten to ${documentDate.toISOString()} ` +
        `(got ${String(reloaded.getCreationDate()?.toISOString())})`,
    );
  }
  if (reloaded.getModificationDate()?.toISOString() !== documentDate.toISOString()) {
    problems.push(
      `Info /ModDate was not rewritten to ${documentDate.toISOString()} ` +
        `(got ${String(reloaded.getModificationDate()?.toISOString())})`,
    );
  }

  const xmpDate = toXmpDate(documentDate);
  if (new TextDecoder('latin1').decode(customResult.pdfBytes).includes(xmpDate)) {
    console.log(`xmp: document date ${xmpDate} present in the output`);
  } else {
    console.log(
      `warning: XMP date ${xmpDate} not found in out/signed-custom-date.pdf; ` +
        'the reference XMP may be absent or compressed',
    );
  }

  const customPdfsig = executableOutput('pdfsig', [customFile]);
  if (customPdfsig === null) {
    problems.push('pdfsig could not read out/signed-custom-date.pdf');
  } else {
    console.log('\n--- pdfsig (custom date) ---\n' + customPdfsig);
    if (!customPdfsig.includes('Signature is Valid.')) {
      problems.push('pdfsig did not report the custom-date signature as valid');
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`assertion failed: ${problem}`);
    throw new Error(`${problems.length} verification assertion(s) failed.`);
  }

  console.log('\nall checks passed. outputs:');
  console.log(`  ${outFile}`);
  console.log(`  ${tsFile}`);
  console.log(`  ${customFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
