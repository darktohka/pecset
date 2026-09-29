/**
 * RFC 3161 timestamp client.
 *
 * The request/response structures are hand-encoded with `node-forge` ASN.1 so
 * that no extra dependency is required. Only what PDF signing needs is
 * implemented: a SHA-256 message imprint over the CMS signature value, a
 * matching `messageImprint`/`nonce` check on the reply, and extraction of the
 * authority-provided `genTime`.
 */
import forge from 'node-forge';
import { SignError } from '@/types';
import { binaryStringToBytes, bytesToBinaryString } from '../binary';

/** OID of SHA-256 (`2.16.840.1.101.3.4.2.1`). */
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';

/** OID of the CMS `signature-time-stamp` unsigned attribute. */
export const OID_SIGNATURE_TIME_STAMP = '1.2.840.113549.1.9.16.2.14';

/** Default request timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Timestamp authorities offered in the UI, limited to those trusted by Adobe,
 * Windows or Apple. Every endpoint is fronted by `rfc3161.ai.moda`, which adds
 * the CORS headers a browser needs.
 */
export const TSA_PRESETS: ReadonlyArray<{ label: string; url: string }> = [
  { label: 'Sectigo', url: 'https://rfc3161.ai.moda/sectigo' },
  { label: 'SwissSign', url: 'https://rfc3161.ai.moda/swisssign' },
  { label: 'GlobalSign', url: 'https://rfc3161.ai.moda/globalsign' },
  { label: 'Digicert', url: 'https://rfc3161.ai.moda/digicert' },
  { label: 'Izenpe', url: 'https://rfc3161.ai.moda/izenpe' },
  { label: 'Azure', url: 'https://rfc3161.ai.moda/azure' },
  { label: 'QuoVadis', url: 'https://rfc3161.ai.moda/quovadis' },
  { label: 'Certum', url: 'https://rfc3161.ai.moda/certum' },
  { label: 'Apple', url: 'https://rfc3161.ai.moda/apple' },
];

/** Endpoint selected by default when the user first enables timestamping. */
export const DEFAULT_TSA_URL = 'https://rfc3161.ai.moda/sectigo';

/** Configuration for a single timestamp request. */
export interface TimestampConfig {
  url: string;
  /** Request timeout in milliseconds; defaults to 15000. */
  timeoutMs?: number;
  /** Injectable `fetch`, used by tests and non-browser callers. */
  fetchImpl?: typeof fetch;
}

/** A timestamp token returned by an authority. */
export interface TimestampToken {
  /** DER of the `TimeStampToken` (CMS `ContentInfo`). */
  tokenDer: Uint8Array;
  /** ISO-8601 `genTime` from the token's TSTInfo, or `null` if unavailable. */
  genTime: string | null;
}

/** A request/response pair, kept together for callers that need both. */
export interface TimestampRequest {
  hash: Uint8Array;
  token: TimestampToken;
}

/* -------------------------------------------------------------------------- */
/*                              ASN.1 helpers                                  */
/* -------------------------------------------------------------------------- */

type Asn1Node = forge.asn1.Asn1;

/** Child nodes of a composed ASN.1 node (empty for primitives). */
function children(node: Asn1Node): Asn1Node[] {
  return Array.isArray(node.value) ? (node.value as Asn1Node[]) : [];
}

/** Binary-string payload of a primitive ASN.1 node. */
function binaryValue(node: Asn1Node | undefined): string {
  return node && typeof node.value === 'string' ? node.value : '';
}

/** Strip redundant leading zero bytes so integer comparisons ignore sign padding. */
function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  return bytes.subarray(start);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Human-readable `PKIFreeText` from a `PKIStatusInfo`, when present. */
function statusString(statusInfo: Asn1Node): string | null {
  const parts: string[] = [];
  for (let i = 1; i < children(statusInfo).length; i += 1) {
    const node = children(statusInfo)[i];
    if (node.type !== forge.asn1.Type.SEQUENCE) continue;
    for (const entry of children(node)) {
      const text = binaryValue(entry);
      if (text.length > 0) parts.push(text);
    }
    if (parts.length > 0) break;
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * A candidate TSTInfo is a SEQUENCE whose third child is a MessageImprint
 * (`SEQUENCE { AlgorithmIdentifier, OCTET STRING }`) and whose fifth child is
 * a GeneralizedTime.
 */
function isTstInfo(node: Asn1Node): boolean {
  if (node.tagClass !== forge.asn1.Class.UNIVERSAL || node.type !== forge.asn1.Type.SEQUENCE) {
    return false;
  }
  const items = children(node);
  if (items.length < 5) return false;
  const imprint = items[2];
  if (!imprint || imprint.type !== forge.asn1.Type.SEQUENCE) return false;
  const imprintItems = children(imprint);
  if (imprintItems.length < 2) return false;
  if (imprintItems[1].type !== forge.asn1.Type.OCTETSTRING) return false;
  return items[4].type === forge.asn1.Type.GENERALIZEDTIME;
}

/**
 * Walk the token for the encapsulated TSTInfo. This deliberately does not
 * hard-code the SignedData nesting: it accepts any OCTET STRING whose payload
 * parses as a well-shaped TSTInfo, which survives the optional fields a TSA may
 * add.
 */
function findTstInfo(token: Asn1Node): Asn1Node | null {
  const stack: Asn1Node[] = [token];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (
      node.tagClass === forge.asn1.Class.UNIVERSAL &&
      node.type === forge.asn1.Type.OCTETSTRING &&
      typeof node.value === 'string' &&
      node.value.length > 0
    ) {
      let inner: Asn1Node | null = null;
      try {
        inner = forge.asn1.fromDer(node.value, false);
      } catch {
        inner = null;
      }
      if (inner && isTstInfo(inner)) return inner;
    }
    for (const child of children(node)) stack.push(child);
  }
  return null;
}

/**
 * Parse a GeneralizedTime (`YYYYMMDDHHMMSS[.fff][Z|±HHMM]`) into an ISO-8601
 * string, or `null` when it cannot be interpreted.
 */
function parseGeneralizedTime(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?(Z|[+-]\d{4})?$/.exec(
    value,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  let iso = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  if (fraction) iso += `.${fraction.slice(0, 3).padEnd(3, '0')}`;
  if (!zone || zone === 'Z') iso += 'Z';
  else iso += `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/* -------------------------------------------------------------------------- */
/*                                 Request                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build the DER of a `TimeStampReq`:
 *
 * ```
 * TimeStampReq ::= SEQUENCE {
 *   version        INTEGER 1,
 *   messageImprint SEQUENCE { hashAlgorithm SHA-256, hashedMessage OCTET STRING },
 *   nonce          INTEGER,
 *   certReq        BOOLEAN TRUE
 * }
 * ```
 */
export function buildTimestampRequest(hash: Uint8Array, nonce: Uint8Array): Uint8Array {
  const request = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, '\x01'),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.OID,
          false,
          forge.asn1.oidToDer(OID_SHA256).getBytes(),
        ),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ''),
      ]),
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OCTETSTRING,
        false,
        bytesToBinaryString(hash),
      ),
    ]),
    forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.INTEGER,
      false,
      bytesToBinaryString(nonce),
    ),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.BOOLEAN, false, '\xff'),
  ]);

  const der = forge.asn1.toDer(request).getBytes();
  return Uint8Array.from(der, (char) => char.charCodeAt(0));
}

/* -------------------------------------------------------------------------- */
/*                                 Response                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parse a `TimeStampResp`, verify it grants a token for `expectedHash` and
 * echo `expectedNonce`, and return the token DER plus `genTime`.
 *
 * Throws {@link SignError} with code `timestamp-failed` on rejection, a
 * malformed reply, or a hash/nonce mismatch.
 */
export function parseTimestampResponse(
  responseDer: Uint8Array,
  expectedHash: Uint8Array,
  expectedNonce: Uint8Array,
): TimestampToken {
  let response: Asn1Node;
  try {
    response = forge.asn1.fromDer(bytesToBinaryString(responseDer), false);
  } catch (error) {
    throw new SignError(
      'timestamp-failed',
      `Could not parse the timestamp authority response: ${messageOf(error)}`,
    );
  }

  const top = children(response);
  const statusInfo = top[0];
  if (!statusInfo) {
    throw new SignError('timestamp-failed', 'The timestamp authority returned a malformed response.');
  }

  const statusNode = children(statusInfo)[0];
  const status = binaryValue(statusNode).charCodeAt(0);
  if (status !== 0 && status !== 1) {
    const detail = statusString(statusInfo);
    const code = Number.isNaN(status) ? 'unknown' : String(status);
    throw new SignError(
      'timestamp-failed',
      'The timestamp authority rejected the request: ' + (detail ?? code),
    );
  }

  const token = top[1];
  if (!token) {
    throw new SignError('timestamp-failed', 'The timestamp authority granted no timestamp token.');
  }

  const tokenDerBytes = forge.asn1.toDer(token).getBytes();
  const tokenDer = Uint8Array.from(tokenDerBytes, (char) => char.charCodeAt(0));

  const tstInfo = findTstInfo(token);
  if (!tstInfo) {
    throw new SignError(
      'timestamp-failed',
      'The timestamp token did not contain a parsable TSTInfo to verify.',
    );
  }

  const items = children(tstInfo);
  const imprintItems = children(items[2]);
  const hashedMessage = binaryStringToBytes(binaryValue(imprintItems[1]));

  if (!bytesEqual(hashedMessage, expectedHash)) {
    throw new SignError(
      'timestamp-failed',
      'The timestamp token does not cover this signature (message imprint mismatch).',
    );
  }

  let nonce: Uint8Array | null = null;
  for (let i = 4; i < items.length; i += 1) {
    const item = items[i];
    if (
      item.tagClass === forge.asn1.Class.UNIVERSAL &&
      item.type === forge.asn1.Type.INTEGER &&
      typeof item.value === 'string'
    ) {
      nonce = binaryStringToBytes(item.value);
      break;
    }
  }

  if (!nonce || !bytesEqual(stripLeadingZeros(nonce), stripLeadingZeros(expectedNonce))) {
    throw new SignError(
      'timestamp-failed',
      'The timestamp token did not echo the request nonce.',
    );
  }

  const genTimeNode = items[4];
  const genTime =
    genTimeNode && typeof genTimeNode.value === 'string'
      ? parseGeneralizedTime(genTimeNode.value)
      : null;

  return { tokenDer, genTime };
}

/* -------------------------------------------------------------------------- */
/*                                  Client                                     */
/* -------------------------------------------------------------------------- */

/**
 * Request and validate an RFC 3161 timestamp token for `hash`.
 *
 * A random 8-byte nonce is generated per request and verified on the reply so
 * a replayed or mismatched token cannot be accepted.
 */
export async function requestTimestampToken(
  hash: Uint8Array,
  config: TimestampConfig,
): Promise<TimestampToken> {
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  const body = buildTimestampRequest(hash, nonce);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    const doFetch = config.fetchImpl ?? fetch;
    response = await doFetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/timestamp-query',
        Accept: 'application/timestamp-reply',
      },
      body: new Uint8Array(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new SignError(
      'timestamp-failed',
      `Could not reach the timestamp authority at ${hostOf(config.url)}: ${messageOf(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new SignError(
      'timestamp-failed',
      `The timestamp authority at ${hostOf(config.url)} responded with HTTP ${response.status}.`,
    );
  }

  const responseDer = new Uint8Array(await response.arrayBuffer());
  return parseTimestampResponse(responseDer, hash, nonce);
}
