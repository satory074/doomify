/** 見た/飛ばした/いいねした履歴と、アーティストへの親和度。IndexedDB(idb-keyval)に永続化。
 *  Spotify のメタデータ本体は保存せず、ID と時刻だけを持つ */
import type { KeyValueStore } from '../spotify/cache';

export type HistoryAction = 'played' | 'skipped' | 'liked';

export interface HistoryEntry {
  at: number;
  action: HistoryAction;
}

export interface HistoryData {
  version: 1;
  seen: Record<string, HistoryEntry>;
  artistAffinity: Record<string, number>;
}

export const HISTORY_KEY = 'doomify:history:v1';
/** この期間は同じ曲を出さない */
export const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SEEN_MAX = 5000;
export const AFFINITY_DELTA: Record<HistoryAction, number> = { played: 0.2, skipped: -1, liked: 2 };
export const AFFINITY_MIN = -5;
export const AFFINITY_MAX = 10;
/** 書き込みをまとめる待ち時間 */
export const FLUSH_DELAY_MS = 1000;

export interface History {
  load(): Promise<void>;
  has(trackId: string, now: number): boolean;
  actionOf(trackId: string): HistoryAction | null;
  record(trackId: string, action: HistoryAction, artistIds: readonly string[], now: number): void;
  affinity(artistId: string): number;
  likedIds(): string[];
  size(): number;
  flush(): Promise<void>;
  reset(): Promise<void>;
}

const empty = (): HistoryData => ({ version: 1, seen: {}, artistAffinity: {} });

function prune(data: HistoryData, now: number): void {
  const entries = Object.entries(data.seen).filter(([, e]) => now - e.at < SEEN_TTL_MS || e.action === 'liked');
  entries.sort((a, b) => b[1].at - a[1].at);
  data.seen = Object.fromEntries(entries.slice(0, SEEN_MAX));
}

export function createHistory(store: KeyValueStore, key = HISTORY_KEY): History {
  let data: HistoryData = empty();
  let dirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!dirty) return;
    dirty = false;
    try {
      await store.set(key, data);
    } catch {
      dirty = true;
    }
  };

  const scheduleFlush = () => {
    dirty = true;
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_DELAY_MS);
  };

  return {
    async load() {
      try {
        const loaded = await store.get<HistoryData>(key);
        if (loaded && loaded.version === 1 && typeof loaded.seen === 'object') {
          data = { version: 1, seen: loaded.seen ?? {}, artistAffinity: loaded.artistAffinity ?? {} };
          prune(data, Date.now());
        }
      } catch {
        data = empty();
      }
    },

    has(trackId, now) {
      const e = data.seen[trackId];
      if (e === undefined) return false;
      return now - e.at < SEEN_TTL_MS;
    },

    actionOf: (trackId) => data.seen[trackId]?.action ?? null,

    record(trackId, action, artistIds, now) {
      const prev = data.seen[trackId];
      // liked は played/skipped で上書きしない(いいねした事実を残す)
      const nextAction = prev?.action === 'liked' && action !== 'liked' ? 'liked' : action;
      data.seen[trackId] = { at: now, action: nextAction };
      for (const id of artistIds) {
        const cur = data.artistAffinity[id] ?? 0;
        data.artistAffinity[id] = Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, cur + AFFINITY_DELTA[action]));
      }
      if (Object.keys(data.seen).length > SEEN_MAX * 1.2) prune(data, now);
      scheduleFlush();
    },

    affinity: (artistId) => data.artistAffinity[artistId] ?? 0,

    likedIds: () =>
      Object.entries(data.seen)
        .filter(([, e]) => e.action === 'liked')
        .map(([id]) => id),

    size: () => Object.keys(data.seen).length,
    flush,

    async reset() {
      data = empty();
      dirty = false;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await store.del(key);
    },
  };
}
