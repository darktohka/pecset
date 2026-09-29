/**
 * PKCS#12 (`.p12` / `.pfx`) parsing, password validation and identity
 * extraction, implemented with `node-forge`.
 *
 * Runs entirely in the browser. `node-forge` ships a `browser` field that maps
 * the Node built-ins to `false`, and its `ByteStringBuffer` constructor accepts
 * `Uint8Array`/`ArrayBuffer` directly, so no Node polyfills are required.
 */
import forge from 'node-forge';
import type { pki } from 'node-forge';
import { P12Error, type P12ErrorCode, type SignerInfo } from '@/types';
import { bytesToBinaryString } from '../binary';

/* -------------------------------------------------------------------------- */
/*                                  Types                                      */
/* -------------------------------------------------------------------------- */

/** A certificate that has been unlocked and is ready to sign with. */
export interface LoadedP12 {
  info: SignerInfo;
  /** Private key that matches `certificate`. */
  key: pki.rsa.PrivateKey;
  /** Signer certificate (leaf). */
  certificate: pki.Certificate;
  /** The full certificate chain as found in the PKCS#12, leaf first. */
  chain: pki.Certificate[];
}

/** Outcome of probing a `.p12` without knowing its password. */
export interface P12Probe {
  /** `true` when the file cannot be opened with an empty password. */
  passwordRequired: boolean;
  /** Identity, when the file opened with an empty password. */
  info: SignerInfo | null;
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                    */
/* -------------------------------------------------------------------------- */

/**
 * Some producers encode RDN values as UTF8String. `node-forge` hands those back
 * as latin1 binary strings (e.g. `JÃ¶rg`), so re-decode them as UTF-8 when
 * the payload clearly contains high bytes.
 */
export function decodeForgeString(value: string | undefined | null): string {
  if (value == null) return '';
  // Fast path: pure ASCII.
  if (!/[\u0080-\u00ff]/.test(value)) return value;
  try {
    const bytes = Uint8Array.from(value, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

function getField(name: pki.Certificate['subject'], shortName: string): string | null {
  const field = name.getField(shortName);
  const value = field && (field as { value?: string }).value;
  const decoded = decodeForgeString(value);
  return decoded.length > 0 ? decoded : null;
}

function buildDistinguishedName(cert: pki.Certificate): string {
  const parts: string[] = [];
  for (const attr of cert.subject.attributes) {
    const short = attr.shortName ?? attr.name ?? String(attr.type);
    const value = decodeForgeString(attr.value as string);
    parts.push(`${short}=${value}`);
  }
  return parts.join(',');
}

function fingerprintSha256(cert: pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const digest = forge.md.sha256.create().update(der).digest().toHex();
  return digest.toUpperCase().replace(/(..)(?=.)/g, '$1:');
}

function detectKey(key: pki.rsa.PrivateKey): { algorithm: string; size: number } {
  const modulus = key.n as unknown as { bitLength?: () => number } | undefined;
  if (modulus && typeof modulus.bitLength === 'function') {
    return { algorithm: 'RSA', size: modulus.bitLength() };
  }
  return { algorithm: 'unknown', size: 0 };
}

export function toSignerInfo(
  cert: pki.Certificate,
  key: pki.rsa.PrivateKey,
  now: Date = new Date(),
): SignerInfo {
  const notBefore = cert.validity.notBefore;
  const notAfter = cert.validity.notAfter;
  const msPerDay = 24 * 60 * 60 * 1000;
  const { algorithm, size } = detectKey(key);

  return {
    commonName: getField(cert.subject, 'CN') ?? '(unnamed)',
    email: getField(cert.subject, 'E') ?? getField(cert.subject, 'emailAddress'),
    organization: getField(cert.subject, 'O'),
    organizationalUnit: getField(cert.subject, 'OU'),
    distinguishedName: buildDistinguishedName(cert),
    country: getField(cert.subject, 'C'),
    locality: getField(cert.subject, 'L'),
    state: getField(cert.subject, 'ST') ?? getField(cert.subject, 'S'),
    issuerCommonName: getField(cert.issuer, 'CN'),
    serialNumber: (cert.serialNumber ?? '').toUpperCase(),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    fingerprintSha256: fingerprintSha256(cert),
    keyAlgorithm: algorithm,
    keySize: size,
    isExpired: notAfter.getTime() < now.getTime(),
    daysUntilExpiry: Math.floor((notAfter.getTime() - now.getTime()) / msPerDay),
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Parsing                                    */
/* -------------------------------------------------------------------------- */

function toAsn1(bytes: Uint8Array) {
  const buffer = forge.util.createBuffer(bytesToBinaryString(bytes));
  try {
    return forge.asn1.fromDer(buffer, false);
  } catch {
    throw new P12Error('invalid-format', 'This file is not a valid PKCS#12 (.p12/.pfx) file.');
  }
}

function classifyError(error: unknown): P12Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/MAC could not be verified/i.test(message)) {
    return new P12Error('wrong-password', 'Incorrect password for this certificate.');
  }
  if (/PKCS#12 PFX/i.test(message)) {
    return new P12Error('invalid-format', 'This file is not a valid PKCS#12 (.p12/.pfx) file.');
  }
  if (/invalid password|decrypt|pbe|Invalid password/i.test(message)) {
    return new P12Error('wrong-password', 'Incorrect password for this certificate.');
  }
  return new P12Error('unknown', message);
}

function readKeyAndCerts(
  p12: forge.pkcs12.Pkcs12Pfx,
): { key: pki.rsa.PrivateKey; certs: pki.Certificate[] } {
  const certBags =
    p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const certs = certBags
    .map((bag) => bag.cert)
    .filter((cert): cert is pki.Certificate => Boolean(cert));

  const shrouded =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] ?? [];
  const plain = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [];
  const key = (shrouded[0]?.key ?? plain[0]?.key) as pki.rsa.PrivateKey | undefined;

  if (!key) {
    throw new P12Error('no-private-key', 'This certificate file does not contain a private key.');
  }
  if (certs.length === 0) {
    throw new P12Error('no-private-key', 'This certificate file does not contain a certificate.');
  }
  return { key, certs };
}

/** Pick the certificate whose public key matches the private key. */
function matchSigner(certs: pki.Certificate[], key: pki.rsa.PrivateKey): pki.Certificate {
  const keyN = (key as unknown as { n?: pki.rsa.PublicKey['n'] }).n;
  if (keyN) {
    const found = certs.find((cert) => {
      const pub = cert.publicKey as unknown as { n?: unknown };
      return pub.n === keyN;
    });
    if (found) return found;
  }
  return certs[0];
}

/** Parse and unlock a PKCS#12 file. Throws {@link P12Error} on failure. */
export function loadP12(bytes: Uint8Array, password?: string): LoadedP12 {
  const asn1 = toAsn1(bytes);
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password ?? '');
  } catch (error) {
    throw classifyError(error);
  }

  const { key, certs } = readKeyAndCerts(p12);
  const certificate = matchSigner(certs, key);
  return {
    info: toSignerInfo(certificate, key),
    key,
    certificate,
    chain: certs,
  };
}

/**
 * Determine whether a password is required, without throwing.
 * Tries to open the file with an empty password first.
 */
export function probeP12(bytes: Uint8Array): P12Probe {
  try {
    const loaded = loadP12(bytes, '');
    return { passwordRequired: false, info: loaded.info };
  } catch (error) {
    if (error instanceof P12Error && error.code === 'wrong-password') {
      return { passwordRequired: true, info: null };
    }
    throw error;
  }
}

/** Validate a password for a `.p12` in one call - used for live UI feedback. */
export function verifyP12Password(
  bytes: Uint8Array,
  password: string,
): { ok: true; info: SignerInfo } | { ok: false; code: P12ErrorCode; message: string } {
  try {
    const loaded = loadP12(bytes, password);
    return { ok: true, info: loaded.info };
  } catch (error) {
    if (error instanceof P12Error) {
      return { ok: false, code: error.code, message: error.message };
    }
    return {
      ok: false,
      code: 'unknown',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
