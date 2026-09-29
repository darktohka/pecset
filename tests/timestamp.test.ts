import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TSA_URL,
  TSA_PRESETS,
  buildTimestampRequest,
  parseTimestampResponse,
} from '@/lib/crypto/timestamp';
import { bytesToBinaryString } from '@/lib/binary';
import { SignError } from '@/types';

type Asn1Node = forge.asn1.Asn1;

const SHA256_OID = '2.16.840.1.101.3.4.2.1';

function kids(node: Asn1Node): Asn1Node[] {
  return Array.isArray(node.value) ? (node.value as Asn1Node[]) : [];
}

function bin(node: Asn1Node): string {
  return typeof node.value === 'string' ? node.value : '';
}

function toBytes(node: Asn1Node): Uint8Array {
  const der = forge.asn1.toDer(node).getBytes();
  return Uint8Array.from(der, (char) => char.charCodeAt(0));
}

const HASH = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const NONCE = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

/** Build a granted `TimeStampResp` wrapping a hand-made TSTInfo. */
function buildGrantedResponse(options: { hashedMessage: string; nonce: string }): Uint8Array {
  const tstInfo = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, '\x01'),
    forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.OID,
      false,
      forge.asn1.oidToDer('1.2.3.4.5').getBytes(),
    ),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.OID,
          false,
          forge.asn1.oidToDer(SHA256_OID).getBytes(),
        ),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ''),
      ]),
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OCTETSTRING,
        false,
        options.hashedMessage,
      ),
    ]),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, '\x2a'),
    forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.GENERALIZEDTIME,
      false,
      '20260929120000Z',
    ),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, options.nonce),
  ]);

  const eContent = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.OCTETSTRING,
    false,
    forge.asn1.toDer(tstInfo).getBytes(),
  );
  const encapContentInfo = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    [
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OID,
        false,
        forge.asn1.oidToDer('1.2.840.113549.1.7.1').getBytes(),
      ),
      forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [eContent]),
    ],
  );
  const signedData = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, '\x03'),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, []),
    encapContentInfo,
  ]);
  const contentInfo = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.OID,
      false,
      forge.asn1.oidToDer('1.2.840.113549.1.7.2').getBytes(),
    ),
    forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [signedData]),
  ]);

  return toBytes(
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, '\x00'),
      ]),
      contentInfo,
    ]),
  );
}

describe('buildTimestampRequest', () => {
  it('encodes a well-formed RFC 3161 TimeStampReq', () => {
    const der = buildTimestampRequest(HASH, NONCE);
    const request = forge.asn1.fromDer(bytesToBinaryString(der));
    const top = kids(request);

    expect(request.tagClass).toBe(forge.asn1.Class.UNIVERSAL);
    expect(request.type).toBe(forge.asn1.Type.SEQUENCE);
    expect(top).toHaveLength(4);

    expect(top[0].type).toBe(forge.asn1.Type.INTEGER);
    expect(bin(top[0])).toBe('\x01');

    const imprint = kids(top[1]);
    expect(top[1].type).toBe(forge.asn1.Type.SEQUENCE);
    const algorithm = kids(imprint[0]);
    expect(algorithm[0].type).toBe(forge.asn1.Type.OID);
    expect(bin(algorithm[0])).toBe(forge.asn1.oidToDer(SHA256_OID).getBytes());
    expect(algorithm[1].type).toBe(forge.asn1.Type.NULL);
    expect(imprint[1].type).toBe(forge.asn1.Type.OCTETSTRING);
    expect(bin(imprint[1])).toBe(bytesToBinaryString(HASH));

    expect(top[2].type).toBe(forge.asn1.Type.INTEGER);
    expect(bin(top[2])).toBe(bytesToBinaryString(NONCE));

    expect(top[3].type).toBe(forge.asn1.Type.BOOLEAN);
    expect(bin(top[3])).toBe('\xff');
  });
});

describe('parseTimestampResponse', () => {
  it('throws a typed error when the authority rejects the request', () => {
    const rejected = toBytes(
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, '\x02'),
        ]),
      ]),
    );

    try {
      parseTimestampResponse(rejected, HASH, NONCE);
      throw new Error('expected parseTimestampResponse to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SignError);
      expect((error as SignError).code).toBe('timestamp-failed');
      expect((error as SignError).message).toContain('rejected');
    }
  });

  it('throws when the message imprint does not match the requested hash', () => {
    const response = buildGrantedResponse({
      hashedMessage: bytesToBinaryString(new Uint8Array(32).fill(7)),
      nonce: bytesToBinaryString(NONCE),
    });

    try {
      parseTimestampResponse(response, HASH, NONCE);
      throw new Error('expected parseTimestampResponse to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SignError);
      expect((error as SignError).code).toBe('timestamp-failed');
      expect((error as SignError).message).toContain('imprint');
    }
  });

  it('throws when the echoed nonce differs from the request nonce', () => {
    const response = buildGrantedResponse({
      hashedMessage: bytesToBinaryString(HASH),
      nonce: bytesToBinaryString(Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9])),
    });

    try {
      parseTimestampResponse(response, HASH, NONCE);
      throw new Error('expected parseTimestampResponse to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SignError);
      expect((error as SignError).code).toBe('timestamp-failed');
      expect((error as SignError).message).toContain('nonce');
    }
  });

  it('returns the token DER and genTime for a matching response', () => {
    const response = buildGrantedResponse({
      hashedMessage: bytesToBinaryString(HASH),
      nonce: bytesToBinaryString(NONCE),
    });

    const token = parseTimestampResponse(response, HASH, NONCE);
    expect(token.tokenDer.length).toBeGreaterThan(0);
    expect(token.genTime).toBe('2026-09-29T12:00:00.000Z');
  });
});

describe('TSA presets', () => {
  it('offers unique reachable endpoints and a default drawn from them', () => {
    const urls = TSA_PRESETS.map((preset) => preset.url);
    expect(urls).toHaveLength(9);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.every((url) => url.startsWith('https://rfc3161.ai.moda/'))).toBe(true);
    expect(urls).toContain(DEFAULT_TSA_URL);
  });
});
