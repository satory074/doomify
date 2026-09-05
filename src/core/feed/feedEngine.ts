/** フィードエンジン。種(ユーザーのデータ) → 候補プール(3 バケット) → 重み付き抽選 → items(追記専用)。
 *  - 種は届いた順に合流し(startSeeds)、曲を含む最初の 1 本で bootstrap が解決する。残りは裏で合流
 *  - items が空のときは拡張(API)の応答を待たずにプールから先に出す(最初のカードを最初の 1 レスポンスで)
 *  - ensureAhead(i) で残りが少なければ補充する。1 回の補充で使う API 呼び出しは予算内
 *  - レート制限中は API を呼ばず、既知プールだけで供給してスクロールを止めない
 *  - 重複(ID と正規化タイトル)・30 日以内に見た曲・同一アーティストの連続を避ける */
import type { KeyValueStore } from '../spotify/cache';
import type { SpotifyApi } from '../spotify/endpoints';
import { appearsOn, deepCut, genreSearch, tagHipster, tagNew, type ExpandContext, type ExpandResult } from './expanders';
import type { History } from './history';
import { mathRandom, pickOne, pickWeighted, randomInt, shuffle, type Rng } from './rng';
import { bucketWeights, dedupeKey, planRefill, STRATEGY_COST, violatesArtistSpacing, type Strategy } from './scheduler';
import { playlistRandomPage, savedRandomPage, startSeeds, type Candidate, type SeedArtist, type Seeds } from './sources';
import { BUCKET_OF, type Bucket, type FeedItem } from './types';

export interface FeedSettings {
  /** 発見度 0..1 */
  discovery: number;
  /** ユーザーが選んだジャンル */
  genres: readonly string[];
}

export const DEFAULT_FEED_SETTINGS: FeedSettings = { discovery: 0.5, genres: [] };

export interface FeedConstants {
  /** 残りがこの枚数を切ったら補充 */
  aheadMin: number;
  /** 1 回の補充で追加したい枚数 */
  refillTarget: number;
  /** 1 回の補充で使える API 呼び出し回数 */
  budgetPerRefill: number;
  /** 同一アーティストを空ける枚数 */
  artistSpacing: number;
  /** items の上限(超えたら「続きを読み込む」でリセット) */
  maxItems: number;
  maxRoundsPerRefill: number;
  /** 隣接アーティストプールの上限 */
  maxArtists: number;
  /** items が空のとき、拡張の応答を待たずにプールから先に出す枚数 */
  initialDraw: number;
}

export const FEED_CONSTANTS: FeedConstants = {
  aheadMin: 8,
  refillTarget: 20,
  budgetPerRefill: 6,
  artistSpacing: 5,
  maxItems: 500,
  maxRoundsPerRefill: 2,
  maxArtists: 300,
  initialDraw: 6,
};

export interface FeedStatus {
  /** 補充中(ユーザーがカードを待っている可能性がある) */
  loading: boolean;
  error: string | null;
  /** 補充しても何も増えなかった */
  exhausted: boolean;
  /** 種の全ソースが確定した(stale の裏再取得も含む) */
  seedsLoaded: boolean;
  /** 種の取得に失敗した数 */
  seedFailures: number;
  /** items が上限に達した */
  full: boolean;
}

export interface FeedEngine {
  items(): readonly FeedItem[];
  itemById(id: string): FeedItem | undefined;
  status(): FeedStatus;
  /** 最初の種(曲を含むソース 1 つ)が使えるまで待つ。残りの種は裏で合流する */
  bootstrap(): Promise<void>;
  /** 全ソースの取得(stale の再取得を含む)が終わるまで待つ。テスト・診断用 */
  seedsSettled(): Promise<void>;
  ensureAhead(activeIndex: number): Promise<void>;
  markPlayed(id: string): void;
  markSkipped(id: string): void;
  markLiked(id: string): void;
  /** 履歴を消してフィードを作り直す */
  reset(): Promise<void>;
  /** items だけ捨てて作り直す(履歴は残す。上限到達時) */
  restart(): Promise<void>;
  subscribe(listener: (items: readonly FeedItem[], status: FeedStatus) => void): () => void;
}

export interface FeedEngineDeps {
  api: SpotifyApi;
  store: KeyValueStore;
  history: History;
  settings: () => FeedSettings;
  rng?: Rng;
  now?: () => number;
  isRateLimited?: () => boolean;
  constants?: Partial<FeedConstants>;
}

const BUCKETS: readonly Bucket[] = ['known', 'adjacent', 'discover'];

export function createFeedEngine(deps: FeedEngineDeps): FeedEngine {
  const rng = deps.rng ?? mathRandom;
  const now = deps.now ?? (() => Date.now());
  const isRateLimited = deps.isRateLimited ?? (() => false);
  const C: FeedConstants = { ...FEED_CONSTANTS, ...deps.constants };

  let items: FeedItem[] = [];
  const byId = new Map<string, FeedItem>();
  const pools: Record<Bucket, Candidate[]> = { known: [], adjacent: [], discover: [] };
  const poolIds = new Set<string>();
  const usedIds = new Set<string>();
  const usedKeys = new Set<string>();
  let seeds: Seeds | null = null;
  /** 一度立てたら null に戻さない(二重起動ガード) */
  let seedsFirst: Promise<void> | null = null;
  let seedsDone: Promise<void> | null = null;
  let artists: SeedArtist[] = [];
  let recentStrategies: Strategy[] = [];
  let refilling: Promise<void> | null = null;
  let status: FeedStatus = { loading: false, error: null, exhausted: false, seedsLoaded: false, seedFailures: 0, full: false };
  const listeners = new Set<(items: readonly FeedItem[], status: FeedStatus) => void>();

  const ctx: ExpandContext = {
    api: deps.api,
    rng,
    currentYear: new Date(now()).getFullYear(),
    preferredGenres: [],
    albumTotals: new Map(),
    searchTotals: new Map(),
  };

  const emit = () => {
    for (const l of listeners) l(items, status);
  };
  const setStatus = (patch: Partial<FeedStatus>) => {
    status = { ...status, ...patch };
  };

  const acceptable = (c: Candidate): boolean => {
    const t = c.track;
    if (usedIds.has(t.id) || deps.history.has(t.id, now())) return false;
    return !usedKeys.has(dedupeKey(t));
  };

  const addToPool = (cands: readonly Candidate[]) => {
    for (const c of cands) {
      if (poolIds.has(c.track.id) || !acceptable(c)) continue;
      poolIds.add(c.track.id);
      pools[BUCKET_OF[c.reason]].push(c);
    }
  };

  /** 既知 id は重みを max で更新、未知はコピーを追加(種の集約は更新のたびに作り直されるので、その重みを引き写す) */
  const mergeArtists = (found: readonly SeedArtist[]) => {
    const known = new Map(artists.map((a) => [a.id, a] as const));
    for (const a of found) {
      const cur = known.get(a.id);
      if (cur === undefined) {
        const copy = { ...a };
        known.set(a.id, copy);
        artists.push(copy);
      } else {
        cur.weight = Math.max(cur.weight, a.weight);
      }
    }
    if (artists.length > C.maxArtists) {
      artists.sort((a, b) => b.weight - a.weight);
      artists = artists.slice(0, C.maxArtists);
    }
  };

  const refreshPreferredGenres = () => {
    ctx.preferredGenres = [...new Set([...deps.settings().genres, ...(seeds?.genres ?? [])])];
  };

  /** 種の集約が更新されるたびに呼ばれる(部分・最終・stale の再取得すべて同じ経路) */
  const applySeeds = (loaded: Seeds, final: boolean) => {
    seeds = loaded;
    mergeArtists(loaded.artists);
    refreshPreferredGenres();
    addToPool(shuffle(rng, loaded.known));
    setStatus({ seedFailures: loaded.failures });
    if (final) {
      setStatus({
        seedsLoaded: true,
        error: loaded.known.length === 0 && loaded.failures > 0 ? 'Spotify からデータを取得できませんでした' : status.error,
      });
    }
  };

  const bootstrap = (): Promise<void> => {
    if (seedsFirst !== null) return seedsFirst;
    const load = startSeeds({ api: deps.api, store: deps.store, now }, { onUpdate: applySeeds });
    seedsDone = load.done.then(() => emit());
    seedsFirst = load.first.then(() => emit());
    return seedsFirst;
  };

  const seedsSettled = async (): Promise<void> => {
    await bootstrap();
    if (seedsDone !== null) await seedsDone;
  };

  const availability = (): Record<Strategy, boolean> => ({
    saved_random: (seeds?.savedTotal ?? 0) > 0,
    playlist_random: (seeds?.playlists.length ?? 0) > 0,
    deep_cut: artists.length > 0,
    appears_on: artists.length > 0,
    genre_search: true,
    tag_new: true,
    tag_hipster: true,
  });

  const affinity = (artistId: string) => deps.history.affinity(artistId);
  const offsetPick = (max: number) => randomInt(rng, 0, max + 1);

  const runStrategy = async (s: Strategy): Promise<ExpandResult> => {
    switch (s) {
      case 'saved_random':
        return { candidates: await savedRandomPage(deps.api, seeds?.savedTotal ?? 0, offsetPick), newArtists: [] };
      case 'playlist_random': {
        const pl = pickWeighted(rng, seeds?.playlists ?? [], (p) => Math.sqrt(p.total));
        if (pl === undefined) return { candidates: [], newArtists: [] };
        return { candidates: await playlistRandomPage(deps.api, pl, offsetPick), newArtists: [] };
      }
      case 'deep_cut':
        return deepCut(ctx, artists, affinity);
      case 'appears_on':
        return appearsOn(ctx, artists, affinity);
      case 'genre_search':
        return genreSearch(ctx);
      case 'tag_new':
        return tagNew(ctx);
      case 'tag_hipster':
        return tagHipster(ctx);
    }
  };

  const candidateWeight = (c: Candidate): number => 1 + Math.max(0, affinity(c.track.artists[0]?.id ?? '')) * 0.3;

  /** プールから count 件を抽選して items に追加できる形にする */
  const draw = (count: number): FeedItem[] => {
    const weights = bucketWeights(deps.settings().discovery);
    const out: FeedItem[] = [];
    const deferred: Candidate[] = [];
    let attempts = 0;
    while (out.length < count && attempts < count * 20) {
      attempts++;
      const nonEmpty = BUCKETS.filter((b) => pools[b].length > 0);
      if (nonEmpty.length === 0) break;
      const bucket = pickWeighted(rng, nonEmpty, (b) => weights[b]) ?? pickOne(rng, nonEmpty);
      if (bucket === undefined) break;
      const pool = pools[bucket];
      const cand = pickWeighted(rng, pool, candidateWeight);
      if (cand === undefined) break;
      pool.splice(pool.indexOf(cand), 1);
      poolIds.delete(cand.track.id);
      if (!acceptable(cand)) continue;
      if (violatesArtistSpacing(cand.track, [...items.slice(-C.artistSpacing), ...out], C.artistSpacing)) {
        deferred.push(cand);
        continue;
      }
      usedIds.add(cand.track.id);
      usedKeys.add(dedupeKey(cand.track));
      out.push({ id: cand.track.id, track: cand.track, reason: cand.reason, reasonDetail: cand.reasonDetail, bucket });
    }
    addToPool(deferred);
    return out;
  };

  /** 抽選して items に追記し、増えたら通知する。増えた枚数を返す(ゼロコール) */
  const appendDrawn = (count: number): number => {
    const drawn = draw(count);
    if (drawn.length === 0) return 0;
    items = items.concat(drawn);
    for (const it of drawn) byId.set(it.id, it);
    emit();
    return drawn.length;
  };

  const poolSizes = (): Record<Bucket, number> => ({
    known: pools.known.length,
    adjacent: pools.adjacent.length,
    discover: pools.discover.length,
  });

  const refill = (): Promise<void> => {
    if (refilling !== null) return refilling;
    refilling = (async () => {
      setStatus({ loading: true, error: null });
      emit();
      try {
        await bootstrap();
        refreshPreferredGenres();
        let added = 0;
        let budget = C.budgetPerRefill;
        // 最初のカードを拡張の応答で待たせない: items が空なら、いまプールにある分から先に出す
        if (items.length === 0) added += appendDrawn(Math.min(C.initialDraw, C.maxItems));
        for (let round = 0; round < C.maxRoundsPerRefill; round++) {
          const room = C.maxItems - items.length;
          const need = Math.min(room, C.refillTarget - added);
          if (need <= 0) break;
          const plan = planRefill({
            discovery: deps.settings().discovery,
            budget,
            rateLimited: isRateLimited(),
            poolSizes: poolSizes(),
            target: C.refillTarget,
            availability: availability(),
            recent: recentStrategies,
            rng,
          });
          if (plan.length > 0) {
            budget -= plan.reduce((sum, s) => sum + STRATEGY_COST[s], 0);
            recentStrategies = plan;
            const results = await Promise.allSettled(plan.map(runStrategy));
            for (const r of results) {
              if (r.status !== 'fulfilled') continue;
              addToPool(r.value.candidates);
              mergeArtists(r.value.newArtists);
            }
          }
          const drawn = appendDrawn(need);
          added += drawn;
          if (plan.length === 0 && drawn === 0) break;
        }
        setStatus({ exhausted: added === 0 && items.length < C.maxItems, full: items.length >= C.maxItems });
      } catch (e) {
        setStatus({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        setStatus({ loading: false });
        refilling = null;
        emit();
      }
    })();
    return refilling;
  };

  const record = (id: string, action: 'played' | 'skipped' | 'liked') => {
    const item = byId.get(id);
    deps.history.record(id, action, item?.track.artists.map((a) => a.id) ?? [], now());
  };

  const clearItems = () => {
    items = [];
    byId.clear();
    usedIds.clear();
    usedKeys.clear();
    for (const b of BUCKETS) pools[b] = [];
    poolIds.clear();
    setStatus({ exhausted: false, full: false, error: null });
  };

  return {
    items: () => items,
    itemById: (id) => byId.get(id),
    status: () => status,
    bootstrap,
    seedsSettled,

    async ensureAhead(activeIndex) {
      if (items.length >= C.maxItems) {
        setStatus({ full: true });
        emit();
        return;
      }
      const remaining = items.length - 1 - activeIndex;
      if (remaining >= C.aheadMin) return;
      await refill();
    },

    markPlayed: (id) => record(id, 'played'),
    markSkipped: (id) => record(id, 'skipped'),
    markLiked: (id) => record(id, 'liked'),

    async reset() {
      await deps.history.reset();
      clearItems();
      if (seeds !== null) addToPool(shuffle(rng, seeds.known));
      emit();
      await refill();
    },

    async restart() {
      clearItems();
      if (seeds !== null) addToPool(shuffle(rng, seeds.known));
      emit();
      await refill();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
