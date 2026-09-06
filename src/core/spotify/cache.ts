/** キャッシュ層。
 *  - SyncTtlCache: ApiClient 内の短命メモリキャッシュ(同期)
 *  - KeyValueStore: フィードのプール・履歴の永続化(IndexedDB。テストは MemoryStore)
 *  - getEntry: 期限切れでも保存から 24h 以内なら stale として返す(stale-while-revalidate 用)
 *  Spotify コンテンツの長期保存はポリシーで禁止されているため、TTL も stale の猶予も最長 24 時間に制限する */
import { createStore, del, get, keys, set, type UseStore } from 'idb-keyval';

export const MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** Spotify 以外(MusicBrainz / ListenBrainz の ID・類似・タグ)の上限。Spotify コンテンツは含めない */
export const EXTERNAL_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function clampTtl(ttlMs: number, maxTtlMs: number = MAX_TTL_MS): number {
  return Math.min(Math.max(0, ttlMs), maxTtlMs);
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
  /** 保存時刻。無い旧エントリは期限内のときだけ使う */
  storedAt?: number;
}

export interface CacheHit<T> {
  value: T;
  /** expiresAt を過ぎていない */
  fresh: boolean;
  /** 保存からの経過 ms(storedAt が無ければ 0) */
  ageMs: number;
}

/** TTL 付きエントリを読む。期限切れでも保存から maxAgeMs(既定・上限 24h。外部データは maxTtlMs で緩和)以内なら stale として返す。
 *  読み出しでは削除しない(setWithTtl が上書きする) */
export async function getEntry<T>(
  store: KeyValueStore,
  key: string,
  now: number,
  maxAgeMs: number = MAX_TTL_MS,
  maxTtlMs: number = MAX_TTL_MS,
): Promise<CacheHit<T> | undefined> {
  const entry = await store.get<TtlEntry<T>>(key);
  if (entry === undefined || typeof entry !== 'object' || entry === null) return undefined;
  if (typeof entry.expiresAt !== 'number') return undefined;
  const storedAt = typeof entry.storedAt === 'number' ? entry.storedAt : null;
  const ageMs = storedAt === null ? 0 : Math.max(0, now - storedAt);
  if (entry.expiresAt > now) return { value: entry.value, fresh: true, ageMs };
  if (storedAt === null) return undefined;
  if (now - storedAt > clampTtl(maxAgeMs, maxTtlMs)) return undefined;
  return { value: entry.value, fresh: false, ageMs };
}

export async function getFresh<T>(store: KeyValueStore, key: string, now: number): Promise<T | undefined> {
  const hit = await getEntry<T>(store, key, now);
  return hit !== undefined && hit.fresh ? hit.value : undefined;
}

export async function setWithTtl<T>(
  store: KeyValueStore,
  key: string,
  value: T,
  ttlMs: number,
  now: number,
  maxTtlMs: number = MAX_TTL_MS,
): Promise<void> {
  const entry: TtlEntry<T> = { value, expiresAt: now + clampTtl(ttlMs, maxTtlMs), storedAt: now };
  await store.set(key, entry);
}
