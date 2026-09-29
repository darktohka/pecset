/**
 * IndexedDB persistence for certificates.
 *
 * A certificate is stored as the raw `.p12`/`.pfx` bytes plus its extracted
 * identity. The password is only persisted when the user explicitly opts in;
 * otherwise it must be re-entered on each use.
 */
import { getDb } from './db';
import type { StoredCertificate } from '@/types';

const STORE = 'certificates';

export async function listCertificates(): Promise<StoredCertificate[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex(STORE, 'addedAt');
  return all.reverse();
}

export async function saveCertificate(certificate: StoredCertificate): Promise<void> {
  const db = await getDb();
  await db.put(STORE, certificate);
}

export async function deleteCertificate(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
}

export async function getCertificate(id: string): Promise<StoredCertificate | undefined> {
  const db = await getDb();
  return db.get(STORE, id);
}

export async function markCertificateUsed(id: string): Promise<void> {
  const db = await getDb();
  const existing = await db.get(STORE, id);
  if (!existing) return;
  await db.put(STORE, { ...existing, lastUsedAt: new Date().toISOString() });
}

export function newCertificateId(): string {
  return crypto.randomUUID();
}
