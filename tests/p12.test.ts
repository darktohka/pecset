import { beforeAll, describe, expect, it } from 'vitest';
import { decodeForgeString, loadP12, probeP12, verifyP12Password } from '@/lib/crypto/p12';
import { createDetachedCms } from '@/lib/crypto/cms';
import { P12Error } from '@/types';
import { createDummyP12Bytes, DUMMY_IDENTITY, DUMMY_P12_PASSWORD } from './helpers/dummyFixtures';

let bytes: Uint8Array;

beforeAll(() => {
  bytes = createDummyP12Bytes();
});

describe('decodeForgeString', () => {
  it('re-decodes UTF-8 payloads that forge returns as latin1', () => {
    expect(decodeForgeString('JÃ¶rg MÃ¼ller')).toBe('Jörg Müller');
  });

  it('leaves ASCII untouched', () => {
    expect(decodeForgeString('Plain Name')).toBe('Plain Name');
  });
});

describe('probeP12', () => {
  it('reports that a password is required', () => {
    expect(probeP12(bytes)).toEqual({ passwordRequired: true, info: null });
  });
});

describe('loadP12', () => {
  it('extracts the signer identity from a PBES2/AES PKCS#12', () => {
    const loaded = loadP12(bytes, DUMMY_P12_PASSWORD);
    expect(loaded.info.commonName).toBe(DUMMY_IDENTITY.commonName);
    expect(loaded.info.email).toBe(DUMMY_IDENTITY.email);
    expect(loaded.info.issuerCommonName).toBe(DUMMY_IDENTITY.issuerCommonName);
    expect(loaded.info.country).toBe(DUMMY_IDENTITY.country);
    expect(loaded.info.keyAlgorithm).toBe('RSA');
    expect(loaded.info.keySize).toBe(2048);
    expect(loaded.info.serialNumber).toMatch(/^[0-9A-F]+$/);
    expect(loaded.info.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(loaded.chain.length).toBeGreaterThanOrEqual(1);
  });

  it('throws a typed error for a wrong password', () => {
    try {
      loadP12(bytes, 'not-the-password');
      throw new Error('expected loadP12 to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(P12Error);
      expect((error as P12Error).code).toBe('wrong-password');
    }
  });

  it('throws invalid-format for a non PKCS#12 blob', () => {
    try {
      loadP12(new TextEncoder().encode('definitely not a p12'), '');
      throw new Error('expected loadP12 to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(P12Error);
      expect((error as P12Error).code).toBe('invalid-format');
    }
  });
});

describe('verifyP12Password', () => {
  it('returns the identity for the correct password', () => {
    const result = verifyP12Password(bytes, DUMMY_P12_PASSWORD);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.info.commonName).toBe(DUMMY_IDENTITY.commonName);
  });

  it('returns wrong-password for an incorrect password', () => {
    const result = verifyP12Password(bytes, 'nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('wrong-password');
  });
});

describe('createDetachedCms', () => {
  it('produces a detached CMS containing the signer certificate', async () => {
    const loaded = loadP12(bytes, DUMMY_P12_PASSWORD);
    const content = new TextEncoder().encode('the bytes that get signed');
    const der = await createDetachedCms(content, loaded, new Date('2026-09-29T12:00:00Z'));

    expect(der.length).toBeGreaterThan(500);
    const hex = Buffer.from(der).toString('hex');
    expect(hex.startsWith('3082')).toBe(true);
    expect(hex).toContain('2a864886f70d010702');
    expect(hex).toContain('2a864886f70d0107');
  });

  it('is deterministic in structure but differs when the content differs', async () => {
    const loaded = loadP12(bytes, DUMMY_P12_PASSWORD);
    const when = new Date('2026-09-29T12:00:00Z');
    const a = await createDetachedCms(new TextEncoder().encode('aaa'), loaded, when);
    const b = await createDetachedCms(new TextEncoder().encode('bbb'), loaded, when);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
