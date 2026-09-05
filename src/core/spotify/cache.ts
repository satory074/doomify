/** キャッシュ層。
 *  - SyncTtlCache: ApiClient 内の短命メモリキャッシュ(同期)
 *  - KeyValueStore: フィードのプール・履歴の永続化(IndexedDB。テストは MemoryStore)
 *  Spotify コンテンツの長期保存はポリシーで禁止されているため、TTL は最長 24 時間に制限する */
import { createStore, del, get, keys, set, type UseStore } from 'idb-keyval';

export const MAX_TTL_MS = 24 * 60 * 60 * 1000;

export function clampTtl(ttlMs: number): number {
  return Math.min(Math.max(0, ttlMs), MAX_TTL_MS);
}

export class SyncTtlCache {
  private readonly map = new Map<string, { value: unknown; expiresAt: number }>();

  get<T>(key: string, now: number): T | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    if (hit.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number, now: number): void {
    this.map.set(key, { value, expiresAt: now + clampTtl(ttlMs) });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

export function createIdbStore(dbName = 'doomify', storeName = 'kv'): KeyValueStore {
  const store: UseStore = createStore(dbName, storeName);
  return {
    get: <T>(key: string) => get<T>(key, store),
    set: <T>(key: string, value: T) => set(key, value, store),
    del: (key: string) => del(key, store),
    keys: async () => (await keys(store)).map(String),
  };
}

interface TtlEntry<T> {
  value: T;
  expiresAt: number;
}

export async function getFresh<T>(store: KeyValueStore, key: string, now: number): Promise<T | undefined> {
  const entry = await store.get<TtlEntry<T>>(key);
  if (entry === undefined || typeof entry !== 'object' || entry === null) return undefined;
  if (typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) return undefined;
  return entry.value;
}

export async function setWithTtl<T>(store: KeyValueStore, key: string, value: T, ttlMs: number, now: number): Promise<void> {
  const entry: TtlEntry<T> = { value, expiresAt: now + clampTtl(ttlMs) };
  await store.set(key, entry);
}
