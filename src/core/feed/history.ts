/** 見た/飛ばした/いいねした履歴と学習した親和度。IndexedDB(idb-keyval)に永続化。
 *  Spotify のメタデータ本体は保存せず、ID と数値だけを持つ。
 *  v2: 報酬つきのフィードバック、タグ・種・戦略ごとの学習、探索量の状態、避けるアーティスト、空振りタグ
 *  v3: 行動ごとの計数(グローバル / 戦略 / タグ / アーティスト。価値モデル用)、未知アーティストの試験状態(段階配信)、
 *      セッション(滞在ベクトル)と同日に見たタグの回数。キーは v1 のまま、中身の version で区別する */
import { PRIORS, updateStats, type BetaStats } from './bandit';
import { INITIAL_EXPLORATION, type ExplorationState } from './exploration';
import type { TrialState } from './pacing';
import { REWARD } from './reward';
import type { Strategy } from './scheduler';
import { createSession, dayKeyOf, type SessionState } from './session';
import { bump, type ActionCounts, type ActionName } from './valueModel';
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

/** 価値モデルの計数(4 階層) */
export interface ActionStats {
  global: ActionCounts;
  artist: Record<string, ActionCounts>;
  tag: Record<string, ActionCounts>;
  strategy: Record<string, ActionCounts>;
}

/** 永続化するセッション: 滞在ベクトルに加えて、同日に見たタグの回数 */
export interface SessionRecord extends SessionState {
  dayKey: string;
  dayTags: Record<string, number>;
}

export interface HistoryData {
  version: 3;
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
  actions: ActionStats;
  /** アーティスト ID → 試験(段階配信)の状態 */
  trials: Record<string, TrialState>;
  session: SessionRecord;
}

interface LegacyHistoryData {
  version: 1 | 2;
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
/** 1 回のフィードバックで親和度を学習するタグ数の上限(同日タグ回数も同じ) */
export const MAX_TAGS_PER_FEEDBACK = 3;
/** 価値モデルの計数に使うタグ数の上限 */
export const MAX_ACTION_TAGS = 8;
export const RECENT_MAX = 50;
/** 書き込みをまとめる待ち時間 */
export const FLUSH_DELAY_MS = 1000;
export const ACTION_ARTISTS_MAX = 2000;
export const ACTION_TAGS_MAX = 300;
export const TRIALS_MAX = 500;

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

/** 価値モデルの計数先(主アーティスト・タグ・戦略) */
export interface LevelInput {
  artistIds: readonly string[];
  tags?: readonly string[];
  strategy?: string;
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
  /** カードを見た(離脱が来た)。価値モデルの表示回数と同日タグ回数を増やす */
  exposure(input: LevelInput): void;
  /** 行動を数える(delta −1 で取り消し) */
  observe(input: LevelInput & { action: ActionName; delta?: 1 | -1 }): void;
  actionCounts(level: 'global'): ActionCounts;
  actionCounts(level: 'artist' | 'tag' | 'strategy', key: string): ActionCounts | undefined;
  trialOf(artistId: string): TrialState | undefined;
  setTrial(artistId: string, state: TrialState): void;
  trials(): Readonly<Record<string, TrialState>>;
  session(): Readonly<SessionRecord>;
  setSession(state: SessionState): void;
  /** 日付が変わっていれば同日タグ回数を空にする */
  touchDay(now: number): void;
  flush(): Promise<void>;
  reset(): Promise<void>;
}

const emptyCounts = (): ActionCounts => ({ n: 0, k: {}, at: 0 });
const emptyActions = (): ActionStats => ({ global: emptyCounts(), artist: {}, tag: {}, strategy: {} });
const emptySession = (): SessionRecord => ({ ...createSession(0), dayKey: '', dayTags: {} });

const empty = (): HistoryData => ({
  version: 3,
  seen: {},
  artistAffinity: {},
  tagAffinity: {},
  seedAffinity: {},
  strategyStats: {},
  exploration: { ...INITIAL_EXPLORATION },
  avoidArtists: {},
  deadTags: {},
  recent: [],
  actions: emptyActions(),
  trials: {},
  session: emptySession(),
});

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** at の古い順に落として上限に収める */
function capByAge<T extends { at: number }>(record: Record<string, T>, max: number): Record<string, T> {
  const entries = Object.entries(record);
  if (entries.length <= max) return record;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, max));
}

function prune(data: HistoryData, now: number): void {
  const entries = Object.entries(data.seen).filter(([, e]) => now - e.at < SEEN_TTL_MS || e.action === 'liked');
  entries.sort((a, b) => b[1].at - a[1].at);
  data.seen = Object.fromEntries(entries.slice(0, SEEN_MAX));
  for (const [id, until] of Object.entries(data.avoidArtists)) if (until <= now) delete data.avoidArtists[id];
  for (const [tag, until] of Object.entries(data.deadTags)) if (until <= now) delete data.deadTags[tag];
  data.actions.artist = capByAge(data.actions.artist, ACTION_ARTISTS_MAX);
  data.actions.tag = capByAge(data.actions.tag, ACTION_TAGS_MAX);
  data.trials = capByAge(data.trials, TRIALS_MAX);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const isCounts = (c: unknown): c is ActionCounts => isRecord(c) && typeof c.n === 'number' && isRecord(c.k) && typeof c.at === 'number';

function countsRecord(o: unknown): Record<string, ActionCounts> {
  if (!isRecord(o)) return {};
  return Object.fromEntries(Object.entries(o).filter((e): e is [string, ActionCounts] => isCounts(e[1])));
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const numbers = (o: unknown): Record<string, number> => (isRecord(o) ? (o as Record<string, number>) : {});

function normalizeSession(v: unknown): SessionRecord {
  if (!isRecord(v)) return emptySession();
  return {
    startedAt: num(v.startedAt),
    lastAt: num(v.lastAt),
    cards: num(v.cards),
    totalDwellMs: num(v.totalDwellMs),
    dwellByArtist: numbers(v.dwellByArtist),
    dwellByTag: numbers(v.dwellByTag),
    dayKey: typeof v.dayKey === 'string' ? v.dayKey : '',
    dayTags: numbers(v.dayTags),
  };
}

function normalizeTrials(v: unknown): Record<string, TrialState> {
  if (!isRecord(v)) return {};
  const out: Record<string, TrialState> = {};
  for (const [id, t] of Object.entries(v)) {
    if (!isRecord(t) || typeof t.at !== 'number') continue;
    const stage = t.stage === 1 || t.stage === 2 || t.stage === 3 ? t.stage : 0;
    out[id] = { stage, shown: num(t.shown), at: t.at, ...(typeof t.blockedUntil === 'number' ? { blockedUntil: t.blockedUntil } : {}) };
  }
  return out;
}

/** v1 / v2 / v3 の保存データを v3 に正規化する。壊れていれば null */
export function migrateHistory(loaded: unknown): HistoryData | null {
  if (!isRecord(loaded) || !isRecord(loaded.seen)) return null;
  const v = loaded as Partial<HistoryData> & Partial<LegacyHistoryData>;
  if (v.version !== 1 && v.version !== 2 && v.version !== 3) return null;
  const exploration = isRecord(v.exploration) ? (v.exploration as ExplorationState) : INITIAL_EXPLORATION;
  const actions = isRecord(v.actions) ? v.actions : null;
  return {
    version: 3,
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
    actions:
      actions === null
        ? emptyActions()
        : {
            global: isCounts(actions.global) ? actions.global : emptyCounts(),
            artist: countsRecord(actions.artist),
            tag: countsRecord(actions.tag),
            strategy: countsRecord(actions.strategy),
          },
    trials: normalizeTrials(v.trials),
    session: normalizeSession(v.session),
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

  /** 4 階層の計数をまとめて更新する */
  const bumpLevels = (input: LevelInput, patch: { exposure?: boolean; action?: ActionName; delta?: 1 | -1 }) => {
    const a = data.actions;
    a.global = bump(a.global, input.now, patch);
    if (input.strategy !== undefined) a.strategy[input.strategy] = bump(a.strategy[input.strategy], input.now, patch);
    for (const t of (input.tags ?? []).slice(0, MAX_ACTION_TAGS)) a.tag[t] = bump(a.tag[t], input.now, patch);
    const primary = input.artistIds[0];
    if (primary !== undefined && primary !== '') a.artist[primary] = bump(a.artist[primary], input.now, patch);
    if (Object.keys(a.artist).length > ACTION_ARTISTS_MAX * 1.2 || Object.keys(a.tag).length > ACTION_TAGS_MAX * 1.2) prune(data, input.now);
    scheduleFlush();
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
      // 'skipped' は早期スキップの崖(≤ −0.4)だけ。途中離脱は連続値なので 'played' 扱い
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

    exposure(input) {
      this.touchDay(input.now);
      for (const t of (input.tags ?? []).slice(0, MAX_TAGS_PER_FEEDBACK)) data.session.dayTags[t] = (data.session.dayTags[t] ?? 0) + 1;
      bumpLevels(input, { exposure: true });
    },
    observe(input) {
      bumpLevels(input, { action: input.action, delta: input.delta ?? 1 });
    },
    actionCounts(level: 'global' | 'artist' | 'tag' | 'strategy', key?: string) {
      if (level === 'global') return data.actions.global;
      return key === undefined ? undefined : data.actions[level][key];
    },

    trialOf: (artistId) => data.trials[artistId],
    setTrial(artistId, state) {
      data.trials[artistId] = state;
      if (Object.keys(data.trials).length > TRIALS_MAX * 1.2) prune(data, state.at);
      scheduleFlush();
    },
    trials: () => data.trials,

    session: () => data.session,
    setSession(state) {
      data.session = { ...state, dayKey: data.session.dayKey, dayTags: data.session.dayTags };
      scheduleFlush();
    },
    touchDay(now) {
      const dayKey = dayKeyOf(now);
      if (data.session.dayKey === dayKey) return;
      data.session = { ...data.session, dayKey, dayTags: {} };
      scheduleFlush();
    },

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
  } as History;
}
