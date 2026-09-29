/**
 * The single owner of the IndexedDB connection.
 *
 * All persistence modules in this folder go through {@link getDb} so that the
 * connection - and the schema upgrade path - exist in exactly one place.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DummySigner, SavedSignatureImage, StoredCertificate } from '@/types';

export interface AppDB extends DBSchema {
  certificates: {
    key: string;
    value: StoredCertificate;
    indexes: { addedAt: string };
  };
  signatureImages: {
    key: string;
    value: SavedSignatureImage;
    indexes: { order: number };
  };
  dummySigners: {
    key: string;
    value: DummySigner;
    indexes: { addedAt: string };
  };
}

// Kept as the legacy name so certificates and signature images saved before
// the rename are not orphaned. The value is an internal identifier only.
export const DB_NAME = 'pdf-signature';
export const DB_VERSION = 2;

let database: Promise<IDBPDatabase<AppDB>> | null = null;

/**
 * Opens (once) and returns the shared database connection.
 *
 * The upgrade is non-destructive: v1 databases already contain `certificates`
 * with all of their records, so each store is created only when it is missing.
 */
export function getDb(): Promise<IDBPDatabase<AppDB>> {
  if (!database) {
    database = openDB<AppDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('certificates')) {
          const store = db.createObjectStore('certificates', { keyPath: 'id' });
          store.createIndex('addedAt', 'addedAt');
        }
        if (!db.objectStoreNames.contains('signatureImages')) {
          const store = db.createObjectStore('signatureImages', { keyPath: 'id' });
          store.createIndex('order', 'order');
        }
        if (!db.objectStoreNames.contains('dummySigners')) {
          const store = db.createObjectStore('dummySigners', { keyPath: 'id' });
          store.createIndex('addedAt', 'addedAt');
        }
      },
    });
  }
  return database;
}
