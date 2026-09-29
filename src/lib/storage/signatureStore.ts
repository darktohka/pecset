/**
 * IndexedDB persistence for saved custom signature images and dummy signers.
 *
 * Signature images carry an explicit `order` column kept contiguous (0..n-1)
 * by every reorder so the gallery has a stable, dense sequencing.
 */
import { getDb } from './db';
import type { DummySigner, SavedSignatureImage } from '@/types';

const IMAGE_STORE = 'signatureImages';
const SIGNER_STORE = 'dummySigners';

/**
 * Normalises a desired ordering against the ids that actually exist.
 *
 * Returns the valid `orderedIds` (filtered to `existingIds`, duplicates
 * removed) followed by every unmentioned `existingIds` entry in its original
 * relative order. The result always contains each existing id exactly once, so
 * a reorder can never drop a persisted entry.
 */
export function computeOrder(orderedIds: string[], existingIds: string[]): string[] {
  const existing = new Set(existingIds);
  const seen = new Set<string>();
  const sequence: string[] = [];

  for (const id of orderedIds) {
    if (!existing.has(id) || seen.has(id)) continue;
    seen.add(id);
    sequence.push(id);
  }

  for (const id of existingIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    sequence.push(id);
  }

  return sequence;
}

/** All saved signature images, sorted by `order` ascending. */
export async function listSignatureImages(): Promise<SavedSignatureImage[]> {
  const db = await getDb();
  return db.getAllFromIndex(IMAGE_STORE, 'order');
}

export async function saveSignatureImage(image: SavedSignatureImage): Promise<void> {
  const db = await getDb();
  await db.put(IMAGE_STORE, image);
}

/** Applies `name` / `description` to an existing image and returns the result. */
export async function updateSignatureImage(
  id: string,
  patch: { name?: string; description?: string },
): Promise<SavedSignatureImage> {
  const db = await getDb();
  const existing = await db.get(IMAGE_STORE, id);
  if (!existing) throw new Error(`Signature image not found: ${id}`);
  const updated: SavedSignatureImage = { ...existing, ...patch };
  await db.put(IMAGE_STORE, updated);
  return updated;
}

export async function deleteSignatureImage(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(IMAGE_STORE, id);
}

/**
 * Persists `orderedIds` as the gallery order, rewriting every image's `order`
 * to its index in the normalised sequence (see {@link computeOrder}).
 */
export async function reorderSignatureImages(
  orderedIds: string[],
): Promise<SavedSignatureImage[]> {
  const db = await getDb();
  const all = await db.getAll(IMAGE_STORE);
  const byId = new Map(all.map((image) => [image.id, image]));
  const sequence = computeOrder(
    orderedIds,
    all.map((image) => image.id),
  );
  const reordered = sequence.map((id, index) => ({ ...byId.get(id)!, order: index }));

  const tx = db.transaction(IMAGE_STORE, 'readwrite');
  await Promise.all(reordered.map((image) => tx.store.put(image)));
  await tx.done;

  return reordered;
}

/** Next free `order` value for a newly created image. */
export async function nextSignatureOrder(): Promise<number> {
  const db = await getDb();
  const all = await db.getAllFromIndex(IMAGE_STORE, 'order');
  return all.length === 0 ? 0 : all[all.length - 1].order + 1;
}

/** All dummy signers, sorted by `addedAt` ascending. */
export async function listDummySigners(): Promise<DummySigner[]> {
  const db = await getDb();
  return db.getAllFromIndex(SIGNER_STORE, 'addedAt');
}

export async function saveDummySigner(signer: DummySigner): Promise<void> {
  const db = await getDb();
  await db.put(SIGNER_STORE, signer);
}

/** Applies `name` / `description` to an existing dummy signer and returns it. */
export async function updateDummySigner(
  id: string,
  patch: { name?: string; description?: string },
): Promise<DummySigner> {
  const db = await getDb();
  const existing = await db.get(SIGNER_STORE, id);
  if (!existing) throw new Error(`Dummy signer not found: ${id}`);
  const updated: DummySigner = { ...existing, ...patch };
  await db.put(SIGNER_STORE, updated);
  return updated;
}

export async function deleteDummySigner(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(SIGNER_STORE, id);
}

export function newId(): string {
  return crypto.randomUUID();
}
