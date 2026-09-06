/** フィードエンジン。種(ユーザーのデータ) → 候補プール(3 バケット) → スコア付き抽選 → items(追記専用)。
 *  - 種は届いた順に合流し(startSeeds)、曲を含む最初の 1 本で bootstrap が解決する。残りは裏で合流
 *  - items が空のときは拡張(API)の応答を待たずにプールから先に出す(最初のカードを最初の 1 レスポンスで)
 *  - ensureAhead(i) で残りが少なければ補充する。1 回の補充で使う Spotify API 呼び出しは予算内(保存済み判定も含む)
 *  - レート制限中は API を呼ばず、既知プールだけで供給してスクロールを止めない
 *  - 発見(adjacent / discover)は既知アーティスト・避けるアーティスト・保存済みの曲を出さない
 *  - フィードバック(離脱時間・いいね・もっと/違う)を報酬にして、アーティスト・タグ・種・戦略(バンディット)・探索量を学習する
 *  - 重複(ID と正規化タイトル)・30 日以内に見た曲・同一アーティストの連続・くじ引き系の連続を避ける */
import type { KeyValueStore } from '../spotify/cache';
import type { SpotifyApi } from '../spotify/endpoints';
import { meanOf, PRIORS, thetaFor } from './bandit';
import type { Enrichment, EnrichmentStats } from './enrichment';
import { appearsOn, deepCut, genreSearch, similarArtist, similarTrack, tagHipster, tagNew, type ExpandContext, type ExpandResult } from './expanders';
import { consumeCooldown, effectiveDiscovery, observeExploration, type ExplorationState } from './exploration';
import type { WeightedGenre } from './genres';
import type { History } from './history';
import { actionReward, isEarlySkip, leaveReward, type FeedbackKind, type LeaveSignal } from './reward';
import { mathRandom, pickOne, pickWeighted, randomInt, shuffle, type Rng } from './rng';
import { bucketWeights, dedupeKey, planRefill, sameAlbumRecently, STRATEGY_COST, violatesArtistSpacing, type Strategy } from './scheduler';
import { playlistRandomPage, savedRandomPage, startSeeds, type Candidate, type SeedArtist, type Seeds } from './sources';
import { absorbArtists, absorbKnownTracks, createTasteProfile, eraFit, isKnownArtist, scoreCandidate, tagFit, type TasteProfile } from './taste';
import { BUCKET_OF, isWildcardReason, type Bucket, type FeedItem } from './types';

export interface FeedSettings {
  /** 発見度 0..1 */
  discovery: number;
  /** ユーザーが選んだジャンル */
  genres: readonly string[];
  /** MusicBrainz / ListenBrainz を使う(既定 true) */
  externalSources?: boolean;
  /** 自動検出したジャンルのうち使わないもの */
  excludedTags?: readonly string[];
}

export const DEFAULT_FEED_SETTINGS: FeedSettings = { discovery: 0.5, genres: [], externalSources: true, excludedTags: [] };

export interface FeedConstants {
  /** 残りがこの枚数を切ったら補充 */
  aheadMin: number;
  /** 1 回の補充で追加したい枚数 */
  refillTarget: number;
  /** 1 回の補充で使える Spotify API 呼び出し回数(保存済み判定も含む) */
  budgetPerRefill: number;
  /** 同一アーティストを空ける枚数 */
  artistSpacing: number;
  /** 同一アルバムを減点する範囲(枚) */
  albumWindow: number;
  /** items の上限(超えたら「続きを読み込む」でリセット) */
  maxItems: number;
  maxRoundsPerRefill: number;
  /** 隣接アーティストプールの上限 */
  maxArtists: number;
  /** items が空のとき、拡張の応答を待たずにプールから先に出す枚数 */
  initialDraw: number;
  /** 「これは違う」でアーティストを避ける期間 ms */
  avoidMs: number;
  /** bridge(2 ホップ)を使う実効発見度の下限 */
  bridgeMinDiscovery: number;
  /** 類似が届いたとき、次の補充を待たずに先出しする枚数(0 で無効) */
  topUpCards: number;
}

export const FEED_CONSTANTS: FeedConstants = {
  aheadMin: 8,
  refillTarget: 20,
  budgetPerRefill: 6,
  artistSpacing: 5,
  albumWindow: 10,
  maxItems: 500,
  maxRoundsPerRefill: 2,
  maxArtists: 300,
  initialDraw: 6,
  avoidMs: 7 * 24 * 60 * 60 * 1000,
  bridgeMinDiscovery: 0.6,
  topUpCards: 2,
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

export interface StrategyStat {
  a: number;
  b: number;
  mean: number;
}

export interface FeedStats {
  /** スライダーと EMA から決めた実効発見度 */
  effectiveDiscovery: number;
  exploration: ExplorationState;
  strategies: Record<Strategy, StrategyStat>;
  /** 直近の探索カード(adjacent / discover)への手応え */
  recent: { count: number; hitRate: number; avgReward: number };
  external: EnrichmentStats | null;
  pools: Record<Bucket, number>;
  knownArtists: number;
  /** 聴取データ由来のジャンル(重み順) */
  topTags: { tag: string; weight: number }[];
  /** items に出した戦略ごとの枚数 */
  served: Partial<Record<Strategy, number>>;
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
  /** カードを離れた(次へ/前へ/自動送り) */
  markLeft(id: string, signal: LeaveSignal): void;
  /** 前のカードに戻ってきた */
  markReturned(id: string): void;
  markLiked(id: string): void;
  markUnliked(id: string): void;
  markAddedToPlaylist(id: string): void;
  markOpened(id: string): void;
  /** 「こういうのをもっと」 */
  markMore(id: string): void;
  /** 「これは違う」: アーティストをしばらく避ける */
  markLess(id: string): void;
  /** 履歴を消してフィードを作り直す */
  reset(): Promise<void>;
  /** items だけ捨てて作り直す(履歴は残す。上限到達時) */
  restart(): Promise<void>;
  feedStats(): FeedStats;
  subscribe(listener: (items: readonly FeedItem[], status: FeedStatus) => void): () => void;
}

export interface FeedEngineDeps {
  api: SpotifyApi;
  store: KeyValueStore;
  history: History;
  settings: () => FeedSettings;
  enrichment?: Enrichment | null;
  rng?: Rng;
  now?: () => number;
  isRateLimited?: () => boolean;
  constants?: Partial<FeedConstants>;
}

const BUCKETS: readonly Bucket[] = ['known', 'adjacent', 'discover'];
/** 既知アーティストでも出してよい理由(既知アーティストのアルバム深掘りは adjacent の本来の役目) */
const KNOWN_OK_REASONS = new Set<FeedItem['reason']>(['top', 'saved', 'recent', 'playlist', 'deepcut']);

export function createFeedEngine(deps: FeedEngineDeps): FeedEngine {
  const rng = deps.rng ?? mathRandom;
  const now = deps.now ?? (() => Date.now());
  const isRateLimited = deps.isRateLimited ?? (() => false);
  const C: FeedConstants = { ...FEED_CONSTANTS, ...deps.constants };
  const enrichment = deps.enrichment ?? null;

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
  let topUpPending = false;
  let topUpDone = false;
  const served = new Map<Strategy, number>();
  let status: FeedStatus = { loading: false, error: null, exhausted: false, seedsLoaded: false, seedFailures: 0, full: false };
  const listeners = new Set<(items: readonly FeedItem[], status: FeedStatus) => void>();
  const taste: TasteProfile = createTasteProfile();

  const externalEnabled = () => enrichment !== null && deps.settings().externalSources !== false;

  /** 聴取データ由来のタグ重み(設定で除外したものを除く) */
  const tagProfile = (): ReadonlyMap<string, number> => {
    if (!externalEnabled() || enrichment === null) return new Map();
    const excluded = new Set(deps.settings().excludedTags ?? []);
    const out = new Map<string, number>();
    for (const [tag, w] of enrichment.tagProfile()) if (!excluded.has(tag)) out.set(tag, w);
    return out;
  };

  const weightedGenres = (): WeightedGenre[] => {
    const out: WeightedGenre[] = [];
    for (const [tag, weight] of tagProfile()) out.push({ genre: tag, weight, source: 'tag' });
    for (const g of deps.settings().genres) out.push({ genre: g, weight: 1, source: 'chip' });
    for (const g of seeds?.genres ?? []) if (!out.some((w) => w.genre === g)) out.push({ genre: g, weight: 0.7, source: 'chip' });
    return out;
  };

  const ctx: ExpandContext = {
    api: deps.api,
    rng,
    currentYear: new Date(now()).getFullYear(),
    now,
    weightedGenres,
    taste,
    enrichment: null,
    history: deps.history,
    albumTotals: new Map(),
    searchTotals: new Map(),
  };

  const emit = () => {
    for (const l of listeners) l(items, status);
  };
  const setStatus = (patch: Partial<FeedStatus>) => {
    status = { ...status, ...patch };
  };

  const exploration = () => deps.history.exploration();
  const effective = () => effectiveDiscovery(deps.settings().discovery, exploration());
  const inCooldown = () => exploration().cooldownLeft > 0;

  /** 発見の候補として通せるか(既知・避ける・見た・重複を落とす) */
  const acceptable = (c: Candidate): boolean => {
    const t = c.track;
    if (usedIds.has(t.id) || deps.history.has(t.id, now())) return false;
    if (usedKeys.has(dedupeKey(t))) return false;
    const nowMs = now();
    if (t.artists.some((a) => deps.history.isAvoided(a.id, nowMs))) return false;
    if (!KNOWN_OK_REASONS.has(c.reason) && isKnownArtist(taste, t)) return false;
    return true;
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
        if ((a.hop ?? 0) < (cur.hop ?? 0)) {
          cur.hop = a.hop;
          cur.from = a.from;
        }
        if (cur.mbid === undefined && a.mbid !== undefined) cur.mbid = a.mbid;
      }
    }
    if (artists.length > C.maxArtists) {
      artists.sort((a, b) => b.weight - a.weight);
      artists = artists.slice(0, C.maxArtists);
    }
  };

  /** 種の集約が更新されるたびに呼ばれる(部分・最終・stale の再取得すべて同じ経路) */
  const applySeeds = (loaded: Seeds, final: boolean) => {
    seeds = loaded;
    absorbArtists(taste, loaded.artists);
    absorbKnownTracks(
      taste,
      loaded.known.map((c) => c.track),
    );
    mergeArtists(loaded.artists);
    addToPool(shuffle(rng, loaded.known));
    setStatus({ seedFailures: loaded.failures });
    if (externalEnabled()) {
      ctx.enrichment = enrichment;
      enrichment?.onSeeds(artists);
    }
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

  const hasSimilarSeeds = (hop: number): boolean => {
    if (!externalEnabled() || enrichment === null) return false;
    const withSimilar = new Set(enrichment.seedsWithSimilar());
    return artists.some((a) => (a.hop ?? 0) === hop && withSimilar.has(a.id));
  };

  const availability = (): Record<Strategy, boolean> => ({
    saved_random: (seeds?.savedTotal ?? 0) > 0,
    playlist_random: (seeds?.playlists.length ?? 0) > 0,
    deep_cut: artists.length > 0,
    appears_on: artists.length > 0,
    similar_artist: hasSimilarSeeds(0),
    bridge: hasSimilarSeeds(1) && effective() >= C.bridgeMinDiscovery && exploration().ema > 0,
    similar_track: externalEnabled() && enrichment !== null && enrichment.tracksWithSimilar().length > 0,
    genre_search: true,
    tag_new: true,
    tag_hipster: true,
  });

  const affinity = (artistId: string) => deps.history.affinity(artistId);
  const offsetPick = (max: number) => randomInt(rng, 0, max + 1);

  const runStrategy = async (s: Strategy): Promise<ExpandResult> => {
    switch (s) {
      case 'saved_random': {
        const cands = await savedRandomPage(deps.api, seeds?.savedTotal ?? 0, offsetPick);
        absorbKnownTracks(
          taste,
          cands.map((c) => c.track),
        );
        return { candidates: cands, newArtists: [] };
      }
      case 'playlist_random': {
        const pl = pickWeighted(rng, seeds?.playlists ?? [], (p) => Math.sqrt(p.total));
        if (pl === undefined) return { candidates: [], newArtists: [] };
        const cands = await playlistRandomPage(deps.api, pl, offsetPick);
        absorbKnownTracks(
          taste,
          cands.map((c) => c.track),
        );
        return { candidates: cands, newArtists: [] };
      }
      case 'deep_cut':
        return deepCut(ctx, artists, affinity);
      case 'appears_on':
        return appearsOn(ctx, artists, affinity);
      case 'similar_artist':
        return similarArtist(ctx, artists, 1);
      case 'bridge':
        return similarArtist(ctx, artists, 2);
      case 'similar_track':
        return similarTrack(ctx);
      case 'genre_search':
        return genreSearch(ctx);
      case 'tag_new':
        return tagNew(ctx);
      case 'tag_hipster':
        return tagHipster(ctx);
    }
  };

  const absorbResult = (r: ExpandResult) => {
    addToPool(r.candidates);
    mergeArtists(r.newArtists);
  };

  const candidateWeight = (c: Candidate, recent: readonly { track: FeedItem['track'] }[]): number => {
    const primary = c.track.artists[0]?.id ?? '';
    const tags = externalEnabled() ? enrichment?.tagsOfSpotifyArtist(primary) : undefined;
    return scoreCandidate({
      candidate: c,
      artistAffinity: affinity(primary),
      seedAffinity: c.seed === undefined ? 0 : deps.history.seedAffinity(c.seed.id),
      tagFit: tagFit(tags, tagProfile()),
      eraFit: eraFit(taste, c.track),
      sameAlbumRecently: sameAlbumRecently(c.track, recent, C.albumWindow),
    });
  };

  const toItem = (cand: Candidate, bucket: Bucket): FeedItem => ({
    id: cand.track.id,
    track: cand.track,
    reason: cand.reason,
    reasonDetail: cand.reasonDetail,
    bucket,
    strategy: cand.strategy,
    seed: cand.seed,
    hop: cand.hop,
  });

  /** プールから count 件を抽選して items に追加できる形にする。only を渡すとそのバケットだけから、filter を渡すとその候補だけから */
  const draw = (count: number, only?: Bucket, filter?: (c: Candidate) => boolean): FeedItem[] => {
    const weights = bucketWeights(effective());
    const out: FeedItem[] = [];
    const deferred: Candidate[] = [];
    let attempts = 0;
    let state = exploration();
    while (out.length < count && attempts < count * 20) {
      attempts++;
      const cooling = state.cooldownLeft > 0;
      const eligible = (b: Bucket) => (filter === undefined ? pools[b] : pools[b].filter(filter));
      const nonEmpty = BUCKETS.filter((b) => eligible(b).length > 0 && (only === undefined || b === only) && !(cooling && b === 'discover'));
      if (nonEmpty.length === 0) break;
      const bucket = pickWeighted(rng, nonEmpty, (b) => weights[b]) ?? pickOne(rng, nonEmpty);
      if (bucket === undefined) break;
      const pool = pools[bucket];
      const recent = [...items.slice(-C.albumWindow), ...out];
      const cand = pickWeighted(rng, eligible(bucket), (c) => candidateWeight(c, recent));
      if (cand === undefined) break;
      pool.splice(pool.indexOf(cand), 1);
      poolIds.delete(cand.track.id);
      if (!acceptable(cand)) continue;
      const last = out[out.length - 1] ?? items[items.length - 1];
      if (
        violatesArtistSpacing(cand.track, [...items.slice(-C.artistSpacing), ...out], C.artistSpacing) ||
        (last !== undefined && isWildcardReason(last.reason) && isWildcardReason(cand.reason))
      ) {
        deferred.push(cand);
        continue;
      }
      usedIds.add(cand.track.id);
      usedKeys.add(dedupeKey(cand.track));
      out.push(toItem(cand, bucket));
      state = consumeCooldown(state);
    }
    if (state !== exploration()) deps.history.setExploration(state);
    addToPool(deferred);
    return out;
  };

  const append = (drawn: readonly FeedItem[]) => {
    if (drawn.length === 0) return;
    items = items.concat(drawn);
    for (const it of drawn) {
      byId.set(it.id, it);
      if (it.strategy !== undefined) served.set(it.strategy, (served.get(it.strategy) ?? 0) + 1);
    }
    emit();
  };

  /** 抽選して items に追記し、増えたら通知する。増えた枚数を返す(ゼロコール) */
  const appendDrawn = (count: number): number => {
    const drawn = draw(count);
    append(drawn);
    return drawn.length;
  };

  /** 抽選 → 保存済み判定(1 コール)→ 追記。発見の曲で保存済みだったものは落とす。判定できなければそのまま出す */
  const appendChecked = async (count: number, only?: Bucket, filter?: (c: Candidate) => boolean): Promise<{ added: number; called: boolean }> => {
    const drawn = draw(count, only, filter);
    if (drawn.length === 0) return { added: 0, called: false };
    if (isRateLimited()) {
      append(drawn);
      return { added: drawn.length, called: false };
    }
    let flags: boolean[] | null = null;
    try {
      flags = await deps.api.libraryContains(drawn.map((it) => it.track.uri));
    } catch {
      flags = null;
    }
    if (flags === null) {
      append(drawn);
      return { added: drawn.length, called: true };
    }
    const kept: FeedItem[] = [];
    drawn.forEach((it, i) => {
      const saved = flags[i] === true;
      if (saved && it.bucket !== 'known') return;
      kept.push({ ...it, saved });
    });
    append(kept);
    return { added: kept.length, called: true };
  };

  const refill = (): Promise<void> => {
    if (refilling !== null) return refilling;
    refilling = (async () => {
      setStatus({ loading: true, error: null });
      emit();
      try {
        await bootstrap();
        topUpDone = false;
        let added = 0;
        let budget = C.budgetPerRefill;
        // 最初のカードを拡張の応答で待たせない: items が空なら、いまプールにある分から先に出す
        if (items.length === 0) added += appendDrawn(Math.min(C.initialDraw, C.maxItems));
        for (let round = 0; round < C.maxRoundsPerRefill; round++) {
          const room = C.maxItems - items.length;
          const need = Math.min(room, C.refillTarget - added);
          if (need <= 0) break;
          const rateLimited = isRateLimited();
          const reserve = rateLimited ? 0 : 1;
          const stats = deps.history.strategyStats();
          const plan = planRefill({
            discovery: effective(),
            budget: budget - reserve,
            rateLimited,
            poolSizes: poolSizes(),
            target: C.refillTarget,
            availability: availability(),
            recent: recentStrategies,
            rng,
            strategyWeight: (s) => thetaFor(rng, stats[s], PRIORS[s]),
            excludeBuckets: inCooldown() ? ['discover'] : [],
          });
          if (plan.length > 0) {
            budget -= plan.reduce((sum, s) => sum + STRATEGY_COST[s], 0);
            recentStrategies = plan;
            const results = await Promise.allSettled(plan.map(runStrategy));
            for (const r of results) if (r.status === 'fulfilled') absorbResult(r.value);
          }
          const { added: drawn, called } = await appendChecked(need);
          if (called) budget -= 1;
          added += drawn;
          if (plan.length === 0 && drawn === 0) break;
          if (budget <= 0) break;
        }
        setStatus({ exhausted: added === 0 && items.length < C.maxItems, full: items.length >= C.maxItems });
      } catch (e) {
        setStatus({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        setStatus({ loading: false });
        refilling = null;
        emit();
        if (topUpPending) void topUp();
      }
    })();
    return refilling;
  };

  /** 類似アーティストが届いたら、次の補充を待たずに 1 コールで数枚だけ先出しする(補充 1 回につき 1 度だけ) */
  const topUp = async (): Promise<void> => {
    topUpPending = false;
    if (C.topUpCards <= 0 || topUpDone || refilling !== null || isRateLimited() || items.length === 0) return;
    if (!availability().similar_artist || items.length >= C.maxItems) return;
    if (pools.discover.some((c) => c.reason === 'similar')) return;
    topUpDone = true;
    try {
      absorbResult(await similarArtist(ctx, artists, 1));
      await appendChecked(C.topUpCards, 'discover', (c) => c.reason === 'similar');
    } catch {
      // 先出しは任意。失敗しても次の補充で拾う
    }
  };

  const onEnrichmentUpdate = () => {
    if (refilling !== null) {
      topUpPending = true;
      return;
    }
    void topUp();
  };

  const poolSizes = (): Record<Bucket, number> => ({
    known: pools.known.length,
    adjacent: pools.adjacent.length,
    discover: pools.discover.length,
  });

  const feedback = (id: string, kind: FeedbackKind, reward: number, earlySkip = false) => {
    const item = byId.get(id);
    if (item === undefined) return;
    const nowMs = now();
    const artistIds = item.track.artists.map((a) => a.id);
    const primary = artistIds[0] ?? '';
    const tags = externalEnabled() ? enrichment?.tagsOfSpotifyArtist(primary) : undefined;
    deps.history.feedback({
      trackId: id,
      reward,
      artistIds,
      tags,
      seedId: item.seed?.id,
      strategy: item.strategy,
      bucket: item.bucket,
      liked: kind === 'like',
      unliked: kind === 'unlike',
      now: nowMs,
    });
    if (item.bucket !== 'known') {
      deps.history.setExploration(observeExploration(exploration(), item.bucket, reward, earlySkip));
    }
    if (kind === 'less') {
      for (const a of artistIds) deps.history.avoid(a, nowMs + C.avoidMs);
    }
    if (externalEnabled() && enrichment !== null) {
      if (kind === 'like') enrichment.onLiked(item.track);
      if (reward > 0.2 && item.hop === 1 && primary !== '') {
        const a = artists.find((x) => x.id === primary);
        enrichment.onPositive(a ?? { id: primary, name: item.track.artists[0]?.name ?? '', weight: 1, hop: 1, mbid: enrichment.mbidOfSpotifyArtist(primary) });
      }
    }
  };

  const clearItems = () => {
    items = [];
    byId.clear();
    usedIds.clear();
    usedKeys.clear();
    for (const b of BUCKETS) pools[b] = [];
    poolIds.clear();
    served.clear();
    setStatus({ exhausted: false, full: false, error: null });
  };

  if (enrichment !== null) enrichment.subscribe(onEnrichmentUpdate);

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

    markLeft(id, signal) {
      const reward = leaveReward(signal);
      if (reward === null) return;
      feedback(id, 'leave', reward, isEarlySkip(signal));
    },
    markReturned: (id) => feedback(id, 'return', actionReward('return')),
    markLiked: (id) => feedback(id, 'like', actionReward('like')),
    markUnliked: (id) => feedback(id, 'unlike', actionReward('unlike')),
    markAddedToPlaylist: (id) => feedback(id, 'playlist', actionReward('playlist')),
    markOpened: (id) => feedback(id, 'open', actionReward('open')),
    markMore: (id) => feedback(id, 'more', actionReward('more')),
    markLess: (id) => feedback(id, 'less', actionReward('less')),

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

    feedStats() {
      const stats = deps.history.strategyStats();
      const strategies = Object.fromEntries(
        (Object.keys(PRIORS) as Strategy[]).map((s) => {
          const st = stats[s] ?? PRIORS[s];
          return [s, { a: st.a, b: st.b, mean: meanOf(st) }];
        }),
      ) as Record<Strategy, StrategyStat>;
      const exploratory = deps.history.recent().filter((r) => r.bucket !== 'known');
      const hits = exploratory.filter((r) => r.reward > 0.2).length;
      const avg = exploratory.length === 0 ? 0 : exploratory.reduce((a, r) => a + r.reward, 0) / exploratory.length;
      return {
        effectiveDiscovery: effective(),
        exploration: exploration(),
        strategies,
        recent: { count: exploratory.length, hitRate: exploratory.length === 0 ? 0 : hits / exploratory.length, avgReward: avg },
        external: externalEnabled() && enrichment !== null ? enrichment.stats() : null,
        pools: poolSizes(),
        knownArtists: taste.knownArtistIds.size,
        topTags: [...tagProfile()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([tag, weight]) => ({ tag, weight })),
        served: Object.fromEntries(served) as Partial<Record<Strategy, number>>,
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
