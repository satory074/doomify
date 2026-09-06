/** 見た/飛ばした/いいねした履歴と学習した親和度。IndexedDB(idb-keyval)に永続化。
 *  Spotify のメタデータ本体は保存せず、ID と数値だけを持つ。
 *  v2: 報酬つきのフィードバック、タグ・種・戦略ごとの学習、探索量の状態、避けるアーティスト、空振りタグ */
import { PRIORS, updateStats, type BetaStats } from './bandit';
import { INITIAL_EXPLORATION, type ExplorationState } from './exploration';
import { REWARD } from './reward';
import type { Strategy } from './scheduler';
import type { KeyValueStore } from '../spotify/cache';

export type HistoryAction = 'played' | 'skipped' | 'liked';

export interface HistoryEntry {
  at: number;
  action: HistoryAction;
  reward?: number;
  strategy?: string;
  seedId?: string;
  bucket?: string;
}

export interface RecentFeedback {
  at: number;
  reward: number;
  bucket: string;
  strategy?: string;
}

export interface HistoryData {
  version: 2;
  seen: Record<string, HistoryEntry>;
  artistAffinity: Record<string, number>;
  tagAffinity: Record<string, number>;
  seedAffinity: Record<string, number>;
  strategyStats: Record<string, BetaStats>;
  exploration: ExplorationState;
  /** アーティスト ID → 避ける期限(epoch ms) */
  avoidArtists: Record<string, number>;
  /** 検索が空振りしたタグ → 避ける期限 */
  deadTags: Record<string, number>;
  /** 直近のフィードバック(診断用) */
  recent: RecentFeedback[];
}

interface LegacyHistoryData {
  version: 1;
  seen: Record<string, HistoryEntry>;
  artistAffinity?: Record<string, number>;
}

export const HISTORY_KEY = 'doomify:history:v1';
/** この期間は同じ曲を出さない */
export const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SEEN_MAX = 5000;
/** 旧 API(record)の親和度の増減 */
export const AFFINITY_DELTA: Record<HistoryAction, number> = { played: 0.2, skipped: -1, liked: 2 };
export const AFFINITY_MIN = -5;
export const AFFINITY_MAX = 10;
/** 報酬 r をアーティスト親和度に足すときの倍率(いいね +1 → +2 で旧 API と同じ) */
export const ARTIST_REWARD_SCALE = 2;
export const TAG_REWARD_SCALE = 0.5;
export const TAG_MIN = -5;
export const TAG_MAX = 5;
export const SEED_REWARD_SCALE = 0.5;
export const SEED_MIN = -3;
export const SEED_MAX = 5;
/** 1 回のフィードバックで学習するタグ数の上限 */
export const MAX_TAGS_PER_FEEDBACK = 3;
export const RECENT_MAX = 50;
/** 書き込みをまとめる待ち時間 */
export const FLUSH_DELAY_MS = 1000;

export interface FeedbackInput {
  trackId: string;
  /** 報酬 -1..1 */
  reward: number;
  artistIds: readonly string[];
  tags?: readonly string[];
  seedId?: string;
  strategy?: Strategy | string;
  bucket?: string;
  /** いいねした(seen の action を liked にし、以後の played/skipped で上書きしない) */
  liked?: boolean;
  /** いいねを取り消した */
  unliked?: boolean;
  now: number;
}

export interface History {
  load(): Promise<void>;
  has(trackId: string, now: number): boolean;
  actionOf(trackId: string): HistoryAction | null;
  /** 旧 API。played/skipped/liked を固定の増減で記録する */
  record(trackId: string, action: HistoryAction, artistIds: readonly string[], now: number): void;
  /** 報酬つきのフィードバック。アーティスト・タグ・種・戦略の学習をまとめて行う */
  feedback(input: FeedbackInput): void;
  affinity(artistId: string): number;
  tagAffinity(tag: string): number;
  seedAffinity(seedId: string): number;
  strategyStats(): Readonly<Record<string, BetaStats>>;
  exploration(): ExplorationState;
  setExploration(state: ExplorationState): void;
  avoid(artistId: string, untilMs: number): void;
  isAvoided(artistId: string, now: number): boolean;
  markDeadTag(tag: string, untilMs: number): void;
  isDeadTag(tag: string, now: number): boolean;
  recent(): readonly RecentFeedback[];
  likedIds(): string[];
  size(): number;
  flush(): Promise<void>;
  reset(): Promise<void>;
}

const empty = (): HistoryData => ({
  version: 2,
  seen: {},
  artistAffinity: {},
  tagAffinity: {},
  seedAffinity: {},
  strategyStats: {},
  exploration: { ...INITIAL_EXPLORATION },
  avoidArtists: {},
  deadTags: {},
  recent: [],
});

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function prune(data: HistoryData, now: number): void {
  const entries = Object.entries(data.seen).filter(([, e]) => now - e.at < SEEN_TTL_MS || e.action === 'liked');
  entries.sort((a, b) => b[1].at - a[1].at);
  data.seen = Object.fromEntries(entries.slice(0, SEEN_MAX));
  for (const [id, until] of Object.entries(data.avoidArtists)) if (until <= now) delete data.avoidArtists[id];
  for (const [tag, until] of Object.entries(data.deadTags)) if (until <= now) delete data.deadTags[tag];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** v1 / v2 の保存データを v2 に正規化する。壊れていれば null */
export function migrateHistory(loaded: unknown): HistoryData | null {
  if (!isRecord(loaded) || !isRecord(loaded.seen)) return null;
  const v = loaded as Partial<HistoryData> & Partial<LegacyHistoryData>;
  if (v.version !== 1 && v.version !== 2) return null;
  const numbers = (o: unknown): Record<string, number> => (isRecord(o) ? (o as Record<string, number>) : {});
  const exploration = isRecord(v.exploration) ? (v.exploration as ExplorationState) : INITIAL_EXPLORATION;
  return {
    version: 2,
    seen: v.seen ?? {},
    artistAffinity: numbers(v.artistAffinity),
    tagAffinity: numbers(v.tagAffinity),
    seedAffinity: numbers(v.seedAffinity),
    strategyStats: isRecord(v.strategyStats) ? (v.strategyStats as Record<string, BetaStats>) : {},
    exploration: {
      ema: typeof exploration.ema === 'number' ? exploration.ema : 0,
      earlySkipStreak: typeof exploration.earlySkipStreak === 'number' ? exploration.earlySkipStreak : 0,
      cooldownLeft: typeof exploration.cooldownLeft === 'number' ? exploration.cooldownLeft : 0,
    },
    avoidArtists: numbers(v.avoidArtists),
    deadTags: numbers(v.deadTags),
    recent: Array.isArray(v.recent) ? (v.recent as RecentFeedback[]).slice(-RECENT_MAX) : [],
  };
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

  const bumpArtists = (artistIds: readonly string[], delta: number) => {
    for (const id of artistIds) {
      const cur = data.artistAffinity[id] ?? 0;
      data.artistAffinity[id] = clamp(cur + delta, AFFINITY_MIN, AFFINITY_MAX);
    }
  };

  const setSeen = (trackId: string, action: HistoryAction, entry: Omit<HistoryEntry, 'action'>, unliked = false) => {
    const prev = data.seen[trackId];
    const keepLiked = prev?.action === 'liked' && action !== 'liked' && !unliked;
    data.seen[trackId] = { ...entry, action: keepLiked ? 'liked' : action };
    if (Object.keys(data.seen).length > SEEN_MAX * 1.2) prune(data, entry.at);
  };

  return {
    async load() {
      try {
        const migrated = migrateHistory(await store.get<unknown>(key));
        if (migrated !== null) {
          data = migrated;
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
      setSeen(trackId, action, { at: now });
      bumpArtists(artistIds, AFFINITY_DELTA[action]);
      scheduleFlush();
    },

    feedback(input) {
      const reward = clamp(Number.isFinite(input.reward) ? input.reward : 0, -1, 1);
      const derived: HistoryAction = input.liked ? 'liked' : input.unliked === true ? 'played' : reward <= REWARD.midSkip ? 'skipped' : 'played';
      setSeen(
        input.trackId,
        derived,
        { at: input.now, reward, strategy: input.strategy, seedId: input.seedId, bucket: input.bucket },
        input.unliked === true,
      );
      bumpArtists(input.artistIds, reward * ARTIST_REWARD_SCALE);
      for (const tag of (input.tags ?? []).slice(0, MAX_TAGS_PER_FEEDBACK)) {
        data.tagAffinity[tag] = clamp((data.tagAffinity[tag] ?? 0) + reward * TAG_REWARD_SCALE, TAG_MIN, TAG_MAX);
      }
      if (input.seedId !== undefined) {
        data.seedAffinity[input.seedId] = clamp((data.seedAffinity[input.seedId] ?? 0) + reward * SEED_REWARD_SCALE, SEED_MIN, SEED_MAX);
      }
      if (input.strategy !== undefined) {
        const prior = (PRIORS as Record<string, BetaStats | undefined>)[input.strategy] ?? { a: 1, b: 1 };
        data.strategyStats[input.strategy] = updateStats(data.strategyStats[input.strategy] ?? prior, reward);
      }
      data.recent.push({ at: input.now, reward, bucket: input.bucket ?? 'known', strategy: input.strategy });
      if (data.recent.length > RECENT_MAX) data.recent = data.recent.slice(-RECENT_MAX);
      scheduleFlush();
    },

    affinity: (artistId) => data.artistAffinity[artistId] ?? 0,
    tagAffinity: (tag) => data.tagAffinity[tag] ?? 0,
    seedAffinity: (seedId) => data.seedAffinity[seedId] ?? 0,
    strategyStats: () => data.strategyStats,
    exploration: () => data.exploration,
    setExploration(state) {
      data.exploration = state;
      scheduleFlush();
    },

    avoid(artistId, untilMs) {
      data.avoidArtists[artistId] = Math.max(data.avoidArtists[artistId] ?? 0, untilMs);
      scheduleFlush();
    },
    isAvoided: (artistId, now) => (data.avoidArtists[artistId] ?? 0) > now,
    markDeadTag(tag, untilMs) {
      data.deadTags[tag] = Math.max(data.deadTags[tag] ?? 0, untilMs);
      scheduleFlush();
    },
    isDeadTag: (tag, now) => (data.deadTags[tag] ?? 0) > now,
    recent: () => data.recent,

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
