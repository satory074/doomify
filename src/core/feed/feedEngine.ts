/** フィードエンジン。種(ユーザーのデータ) → 候補プール(3 バケット) → 枠テンプレート → 名前付きフィルタ → 多目的期待値 → 再ランク乗数 → 温度付き抽選 → items(追記専用)。
 *  TikTok / Instagram Reels / X の For You と同じ骨格を、Spotify API の予算(補充 1 回 ≤6 コール)の中で再現する。
 *  - 種は届いた順に合流し(startSeeds)、曲を含む最初の 1 本で bootstrap が解決する。残りは裏で合流
 *  - items が空のときは拡張(API)の応答を待たずにプールから先に出す(最初のカードを最初の 1 レスポンスで)
 *  - ensureAhead(i) で残りが少なければ補充する。1 回の補充で使う Spotify API 呼び出しは予算内(保存済み判定も含む)。抽選(draw)はゼロコール
 *  - レート制限中は API を呼ばず、既知プールだけで供給してスクロールを止めない
 *  - 発見(adjacent / discover)は既知アーティスト・避けるアーティスト・保存済みの曲を出さない
 *  - 枠(pacing): anchor(なじみ)/ exploit(期待値)/ trial(未知アーティストの試験 → 段階配信)/ wildcard(くじ引き)。フィードの先頭は anchor
 *  - スコア(ranker): 関連度 × exp(β·EV)(価値モデル: 行動ごとの確率の重み付き和)× 著者減衰 × OON 割引 × セッション興味 × 同日減点 × 同タグ連続
 *  - フィードバック(滞在・完走・いいね・共有・もっと/違う)→ 報酬 → アーティスト・タグ・種・戦略(バンディット)・探索量・行動計数・セッション興味を学習。
 *    同じ訪問の離脱は 1 回だけ数える(exposures)。「違う」はプールを即時パージし、未表示のキュー(active+3 より先)をゼロコールで引き直す(追記専用の唯一の例外)
 *  - 重複(ID と正規化タイトル)・30 日以内に見た曲・同一アーティストの連続・くじ引き系の連続を避ける */
import type { KeyValueStore } from '../spotify/cache';
import type { SpotifyApi } from '../spotify/endpoints';
import type { Track } from '../spotify/types';
import { meanOf, PRIORS, thetaFor } from './bandit';
import type { Enrichment, EnrichmentStats } from './enrichment';
import { appearsOn, deepCut, genreSearch, similarArtist, similarTrack, tagHipster, tagNew, type ExpandContext, type ExpandResult } from './expanders';
import { consumeCooldown, effectiveDiscovery, observeExploration, type ExplorationState } from './exploration';
import type { WeightedGenre } from './genres';
import type { History } from './history';
import { buildSlots, onTrialOutcome, onTrialShown, PACING, SLOT_TEMPERATURE, TRIAL_MAX_EXPOSURES, trialAllows, trialSample, type SlotKind } from './pacing';
import { RANK, sampleScored, scoreCandidates, type Categorizable, type FilterReason, type RankContext } from './ranker';
import { actionReward, isEarlySkip, leaveOutcome, type FeedbackKind, type LeaveOutcome, type LeaveSignal } from './reward';
import { mathRandom, pickOne, pickWeighted, randomInt, shuffle, type Rng } from './rng';
import { bucketWeights, dedupeKey, planRefill, sameAlbumRecently, STRATEGY_COST, violatesArtistSpacing, type Strategy } from './scheduler';
import { confidenceOf, createSession, observeCard, sessionBoost, topInterests, touchSession, type SessionState } from './session';
import { playlistRandomPage, savedRandomPage, startSeeds, type Candidate, type SeedArtist, type Seeds } from './sources';
import { absorbArtists, absorbKnownTracks, createTasteProfile, eraFit, isKnownArtist, scoreCandidate, tagFit, type TasteProfile } from './taste';
import { BUCKET_OF, isWildcardReason, type Bucket, type FeedItem } from './types';
import { ACTIONS, decayed, EV_BETA, predict, type ActionName, type Prediction, type StatsLookup } from './valueModel';

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
  /** 「これは違う」のとき、active からこの枚数までは残し、その先の未表示カードを引き直す(Infinity で無効) */
  pruneAheadKeep: number;
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
  pruneAheadKeep: 3,
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

export interface SessionStats {
  cards: number;
  minutes: number;
  /** 0..1 */
  confidence: number;
  topInterests: { key: string; share: number }[];
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
  session: SessionStats;
  /** items に出した枠ごとの枚数 */
  slots: Partial<Record<SlotKind, number>>;
  /** 評価で落とした回数(理由ごと) */
  filters: Partial<Record<FilterReason, number>>;
  /** 未知アーティストの試験(段階配信)の状況 */
  trials: { active: number; graduated: number; blocked: number };
  /** 価値モデルが学習した反応率(減衰後のグローバル)と表示回数 */
  valueModel: { rates: Record<ActionName, number>; exposures: number };
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
  /** カードを離れた(次へ/前へ/自動送り)。同じ訪問では 1 回だけ学習する */
  markLeft(id: string, signal: LeaveSignal): void;
  /** 前のカードに戻ってきた */
  markReturned(id: string): void;
  markLiked(id: string): void;
  markUnliked(id: string): void;
  markAddedToPlaylist(id: string): void;
  markOpened(id: string): void;
  /** 共有した(共有シート / リンクのコピー) */
  markShared(id: string): void;
  /** 「こういうのをもっと」 */
  markMore(id: string): void;
  /** 「これは違う」: アーティストをしばらく避け、未表示のキューを引き直す */
  markLess(id: string): void;
  /** 履歴を消してフィードを作り直す */
  reset(): Promise<void>;
  /** items だけ捨てて作り直す(履歴は残す。上限到達時) */
  restart(): Promise<void>;
  /** 学習の書き込みを待たずに永続化する(画面が隠れるときなど) */
  flush(): Promise<void>;
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
/** 評価で落ちたら候補プールからも捨ててよい理由(間隔・くじ引き連続・試験上限は一時的なので残す) */
const PERMANENT_DROPS = new Set<FilterReason>(['seen', 'duplicate', 'avoided', 'known_artist', 'excluded_tag']);
/** 明示操作 → 価値モデルの行動名 */
const ACTION_OF_KIND: Record<Exclude<FeedbackKind, 'leave'>, ActionName> = {
  return: 'return',
  like: 'like',
  unlike: 'like',
  playlist: 'playlist',
  open: 'open',
  share: 'share',
  more: 'more',
  less: 'less',
};

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
  const slotsServed = new Map<SlotKind, number>();
  const filterCounts = new Map<FilterReason, number>();
  /** カードごとの離脱・戻りの回数(同じ訪問の離脱を 2 回数えない) */
  const exposures = new Map<string, { leaves: number; returns: number }>();
  let session: SessionState = createSession(now());
  let sessionRestored = false;
  /** 最後に知らされたアクティブ index(「違う」の引き直しで触らない範囲の基準) */
  let lastActive = 0;
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

  /** タグ集合への好み: このセッションの興味 × 価値モデルのタグ階層の期待値(候補を取りに行く段階の個人化) */
  const tagBoost = (tags: readonly string[]): number => {
    if (tags.length === 0) return 1;
    const nowMs = now();
    return sessionBoost(currentSession(), '', tags) * Math.exp(EV_BETA * predict(lookup, { artistId: '', tags, now: nowMs }).ev);
  };

  const weightedGenres = (): WeightedGenre[] => {
    const out: WeightedGenre[] = [];
    for (const [tag, weight] of tagProfile()) out.push({ genre: tag, weight: weight * tagBoost([tag]), source: 'tag' });
    for (const g of deps.settings().genres) out.push({ genre: g, weight: tagBoost([g]), source: 'chip' });
    for (const g of seeds?.genres ?? []) if (!out.some((w) => w.genre === g)) out.push({ genre: g, weight: 0.7 * tagBoost([g]), source: 'chip' });
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
    tagBoost,
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

  /** いまのセッション。履歴のロード後に一度だけ復元し、30 分空いていれば新しくする */
  const currentSession = (): SessionState => {
    const nowMs = now();
    if (!sessionRestored) {
      sessionRestored = true;
      const saved = deps.history.session();
      if (saved.lastAt > 0) {
        session = { startedAt: saved.startedAt, lastAt: saved.lastAt, cards: saved.cards, totalDwellMs: saved.totalDwellMs, dwellByArtist: saved.dwellByArtist, dwellByTag: saved.dwellByTag };
      }
    }
    const touched = touchSession(session, nowMs);
    if (touched !== session) {
      session = touched;
      deps.history.setSession(session);
    }
    deps.history.touchDay(nowMs);
    return session;
  };

  const lookup: StatsLookup = {
    global: () => deps.history.actionCounts('global'),
    strategy: (s) => deps.history.actionCounts('strategy', s),
    tag: (t) => deps.history.actionCounts('tag', t),
    artist: (id) => deps.history.actionCounts('artist', id),
  };

  /** カテゴリ(主タグが先頭): 外部タグ 2 つ → 種 → 残りの外部タグ → ジャンル検索の語 → くじ引きの種別。外部データが無くても空にはなりにくい */
  const categoriesOf = (c: Categorizable & { seed?: FeedItem['seed'] }): string[] => {
    const primary = c.track.artists[0]?.id ?? '';
    const ext = externalEnabled() && enrichment !== null && primary !== '' ? [...(enrichment.tagsOfSpotifyArtist(primary) ?? [])] : [];
    const out: string[] = ext.slice(0, 2);
    if (c.seed !== undefined) out.push(`seed:${c.seed.id}`);
    for (const t of ext.slice(2)) out.push(t);
    if ((c.reason === 'genre' || c.reason === 'tag') && c.reasonDetail !== undefined && !out.includes(c.reasonDetail)) out.push(c.reasonDetail);
    if (isWildcardReason(c.reason)) out.push(`#${c.reason}`);
    return out;
  };

  const predictOf = (c: Candidate, nowMs: number): Prediction =>
    predict(lookup, { artistId: c.track.artists[0]?.id ?? '', tags: categoriesOf(c), strategy: c.strategy, now: nowMs });

  /** 表示の少ない(未知の)アーティストか */
  const isCold = (c: Candidate, nowMs: number): boolean => {
    const id = c.track.artists[0]?.id ?? '';
    return id !== '' && decayed(deps.history.actionCounts('artist', id), nowMs).n < TRIAL_MAX_EXPOSURES;
  };

  /** 通せない理由(null なら通す)。recent を渡すと間隔・くじ引き連続も見る */
  const rejectReason = (c: Candidate, recent?: readonly Categorizable[]): FilterReason | null => {
    const t = c.track;
    const nowMs = now();
    if (usedIds.has(t.id) || deps.history.has(t.id, nowMs)) return 'seen';
    if (usedKeys.has(dedupeKey(t))) return 'duplicate';
    if (t.artists.some((a) => deps.history.isAvoided(a.id, nowMs))) return 'avoided';
    if (!KNOWN_OK_REASONS.has(c.reason) && isKnownArtist(taste, t)) return 'known_artist';
    const excluded = deps.settings().excludedTags ?? [];
    if (excluded.length > 0 && (c.reason === 'genre' || c.reason === 'tag') && c.reasonDetail !== undefined && excluded.includes(c.reasonDetail)) return 'excluded_tag';
    const primary = t.artists[0]?.id ?? '';
    if (BUCKET_OF[c.reason] === 'discover' && primary !== '' && !trialAllows(deps.history.trialOf(primary), nowMs)) return 'trial_cap';
    if (recent !== undefined) {
      if (violatesArtistSpacing(t, recent, C.artistSpacing)) return 'artist_spacing';
      const last = recent[recent.length - 1];
      if (last !== undefined && isWildcardReason(last.reason) && isWildcardReason(c.reason)) return 'wildcard_adjacent';
    }
    return null;
  };

  /** プールに入れてよいか(既知・避ける・見た・重複を落とす)。試験上限は抽選のたびに見るので、ここでは落とさない */
  const acceptable = (c: Candidate): boolean => {
    const r = rejectReason(c);
    return r === null || r === 'trial_cap';
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

  /** 関連度の事前分布(類似順位 × タグ適合 × 年代 × 親和度 × 種親和度 × 同一アルバム減点) */
  const relevanceOf = (c: Candidate, recent: readonly { track: Track }[], profile: ReadonlyMap<string, number>): number => {
    const primary = c.track.artists[0]?.id ?? '';
    const tags = externalEnabled() ? enrichment?.tagsOfSpotifyArtist(primary) : undefined;
    return scoreCandidate({
      candidate: c,
      artistAffinity: affinity(primary),
      seedAffinity: c.seed === undefined ? 0 : deps.history.seedAffinity(c.seed.id),
      tagFit: tagFit(tags, profile),
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

  const toCandidate = (it: FeedItem): Candidate => ({ track: it.track, reason: it.reason, reasonDetail: it.reasonDetail, strategy: it.strategy, seed: it.seed, hop: it.hop });

  const countDrop = (reason: FilterReason) => filterCounts.set(reason, (filterCounts.get(reason) ?? 0) + 1);

  const removeFromPools = (cands: readonly Candidate[]) => {
    for (const c of cands) {
      const pool = pools[BUCKET_OF[c.reason]];
      const at = pool.indexOf(c);
      if (at !== -1) pool.splice(at, 1);
      poolIds.delete(c.track.id);
    }
  };

  /** 該当アーティストの候補をプールから落とす */
  const purgeArtists = (ids: ReadonlySet<string>) => {
    for (const b of BUCKETS) {
      const kept: Candidate[] = [];
      for (const c of pools[b]) {
        if (c.track.artists.some((a) => ids.has(a.id))) poolIds.delete(c.track.id);
        else kept.push(c);
      }
      pools[b] = kept;
    }
  };

  /** いま出せる候補の数(補充計画用。試験上限などで当面出せないものは数えない) */
  const drawablePoolSizes = (): Record<Bucket, number> => ({
    known: pools.known.filter((c) => rejectReason(c) === null).length,
    adjacent: pools.adjacent.filter((c) => rejectReason(c) === null).length,
    discover: pools.discover.filter((c) => rejectReason(c) === null).length,
  });

  /** プールから count 件を抽選して items に追加できる形にする(ゼロコール)。
   *  枠テンプレートに従い、枠ごとに 名前付きフィルタ → スコア → 温度付き抽選。枠のバケットが空ならバケット重みでフォールバック。
   *  only を渡すとそのバケットだけから、filter を渡すとその候補だけから */
  const draw = (count: number, only?: Bucket, filter?: (c: Candidate) => boolean): FeedItem[] => {
    const out: FeedItem[] = [];
    if (count <= 0) return out;
    const weights = bucketWeights(effective());
    const nowMs = now();
    const sess = currentSession();
    const profile = tagProfile();
    const dayTags = deps.history.session().dayTags;
    const eligible = (b: Bucket): Candidate[] => (filter === undefined ? pools[b] : pools[b].filter(filter));
    let state = exploration();
    let cooling = state.cooldownLeft > 0;
    const plan = (n: number, first: boolean) =>
      buildSlots(rng, {
        count: n,
        weights,
        cooling,
        hasTrial: only === undefined && eligible('discover').some((c) => isCold(c, nowMs)),
        wildcardOk: only === undefined && effective() >= PACING.wildcardMinDiscovery && eligible('discover').some((c) => isWildcardReason(c.reason)),
        first,
        only,
      });
    let slots = plan(count, items.length === 0);
    /** この抽選で候補が尽きた枠(kind:bucket)。カードが増えるたびに(間隔の条件が変わるので)クリア */
    const exhausted = new Set<string>();
    const key = (k: SlotKind, b: Bucket) => `${k}:${b}`;
    const candidatesFor = (kind: SlotKind, bucket: Bucket): Candidate[] => {
      if (only !== undefined) return eligible(only);
      switch (kind) {
        case 'anchor':
          return eligible('known');
        case 'trial':
          return eligible('discover').filter((c) => isCold(c, nowMs));
        case 'wildcard':
          return eligible('discover').filter((c) => isWildcardReason(c.reason));
        case 'exploit':
          // discover 枠は in-network(adjacent)とも競わせる(OON 割引 ×0.75 が効く)。逆は無し
          return bucket === 'discover' && !cooling ? [...eligible('adjacent'), ...eligible('discover')] : eligible(bucket);
      }
    };
    let attempts = 0;
    while (out.length < count && attempts < count * 4) {
      attempts++;
      if (cooling && state.cooldownLeft <= 0) {
        cooling = false;
        slots = [...slots.slice(0, out.length), ...plan(count - out.length, false)];
      }
      const nonEmpty = BUCKETS.filter((b) => eligible(b).length > 0 && (only === undefined || b === only) && !(cooling && b === 'discover'));
      if (nonEmpty.length === 0) break;
      const slot = slots[out.length];
      let kind: SlotKind = slot?.kind ?? 'exploit';
      let bucket: Bucket = slot?.bucket ?? 'known';
      if (slot === undefined || !nonEmpty.includes(bucket) || exhausted.has(key(kind, bucket))) {
        const open = nonEmpty.filter((b) => !exhausted.has(key(b === 'known' ? 'anchor' : 'exploit', b)));
        if (open.length === 0) break;
        const picked = pickWeighted(rng, open, (b) => weights[b]) ?? pickOne(rng, open);
        if (picked === undefined) break;
        bucket = picked;
        kind = bucket === 'known' ? 'anchor' : 'exploit';
      }
      const recent: Categorizable[] = [...items.slice(-RANK.diversityWindow), ...out];
      const rankCtx: RankContext = {
        now: nowMs,
        recent,
        relevance: (c) => relevanceOf(c, recent, profile),
        predict: (c) => predictOf(c, nowMs),
        categoriesOf,
        filter: (c) => rejectReason(c, recent),
        session: sess,
        dayCount: (t) => dayTags[t] ?? 0,
        trialSample: (c) => {
          const id = c.track.artists[0]?.id ?? '';
          return id !== '' && isCold(c, nowMs) ? trialSample(rng, deps.history.actionCounts('artist', id), nowMs) : null;
        },
      };
      const dropped: Candidate[] = [];
      const scored = scoreCandidates(candidatesFor(kind, bucket), rankCtx, {
        trial: kind === 'trial',
        onDrop: (reason, c) => {
          countDrop(reason);
          if (PERMANENT_DROPS.has(reason)) dropped.push(c);
        },
      });
      removeFromPools(dropped);
      const pick = sampleScored(rng, scored, SLOT_TEMPERATURE[kind]);
      if (pick === undefined) {
        exhausted.add(key(kind, bucket));
        continue;
      }
      const cand = pick.candidate;
      const candBucket = BUCKET_OF[cand.reason];
      const pool = pools[candBucket];
      const at = pool.indexOf(cand);
      if (at !== -1) pool.splice(at, 1);
      poolIds.delete(cand.track.id);
      usedIds.add(cand.track.id);
      usedKeys.add(dedupeKey(cand.track));
      const primary = cand.track.artists[0]?.id ?? '';
      if (candBucket === 'discover' && primary !== '' && isCold(cand, nowMs)) {
        deps.history.setTrial(primary, onTrialShown(deps.history.trialOf(primary), nowMs));
      }
      out.push({ ...toItem(cand, candBucket), slot: kind, score: pick.score, ev: pick.ev, predictions: pick.predictions });
      slotsServed.set(kind, (slotsServed.get(kind) ?? 0) + 1);
      exhausted.clear();
      state = consumeCooldown(state);
    }
    if (state !== exploration()) deps.history.setExploration(state);
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
            poolSizes: drawablePoolSizes(),
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
    if (pools.discover.some((c) => c.reason === 'similar' && rejectReason(c) === null)) return;
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

  /** 「これは違う」: プールから該当アーティストを落とし、未表示のキュー(lastActive + pruneAheadKeep より先)を引き直す(ゼロコール) */
  const reflowAfterAvoid = (artistIds: readonly string[], keepId: string) => {
    const ids = new Set(artistIds);
    const hit = (t: Track) => t.artists.some((a) => ids.has(a.id));
    purgeArtists(ids);
    if (!Number.isFinite(C.pruneAheadKeep)) return;
    const from = lastActive + C.pruneAheadKeep + 1;
    if (from >= items.length) return;
    const tail = items.slice(from);
    if (!tail.some((it) => it.id !== keepId && hit(it.track))) return;
    items = items.slice(0, from);
    const nowMs = now();
    for (const it of tail) {
      byId.delete(it.id);
      usedIds.delete(it.id);
      usedKeys.delete(dedupeKey(it.track));
      exposures.delete(it.id);
      // 出していた試験の枠を空ける(結果は来ないので中立扱い)
      const primary = it.track.artists[0]?.id ?? '';
      const trial = primary === '' ? undefined : deps.history.trialOf(primary);
      if (it.bucket === 'discover' && trial !== undefined) deps.history.setTrial(primary, onTrialOutcome(trial, 0, nowMs));
      if (it.strategy !== undefined) served.set(it.strategy, Math.max(0, (served.get(it.strategy) ?? 0) - 1));
      if (it.slot !== undefined) slotsServed.set(it.slot, Math.max(0, (slotsServed.get(it.slot) ?? 0) - 1));
    }
    // 該当しないカードは候補に戻して引き直す(いまの学習で並び直る)
    addToPool(tail.filter((it) => !hit(it.track)).map(toCandidate));
    append(draw(tail.length));
    emit();
  };

  const feedback = (id: string, kind: FeedbackKind, reward: number, extra: { earlySkip?: boolean; outcome?: LeaveOutcome; dwellMs?: number } = {}) => {
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
    // 価値モデルの計数とセッション興味(主アーティスト・カテゴリ・戦略)
    const categories = categoriesOf(item);
    const level = { artistIds: [primary], tags: categories, strategy: item.strategy, now: nowMs };
    let sess = currentSession();
    if (kind === 'leave') {
      deps.history.exposure(level);
      sess = observeCard(sess, { artistId: primary, tags: categories, dwellMs: extra.dwellMs ?? 0, now: nowMs });
      session = sess;
      deps.history.setSession(sess);
      if (extra.outcome?.complete === true) deps.history.observe({ ...level, action: 'complete' });
      if (extra.outcome?.earlySkip === true) deps.history.observe({ ...level, action: 'earlySkip' });
    } else {
      deps.history.observe({ ...level, action: ACTION_OF_KIND[kind], delta: kind === 'unlike' ? -1 : 1 });
    }
    // 未知アーティストの試験(段階配信): 結果で次の段階へ / 止める。止めたらプールの候補も落とす
    if (item.bucket === 'discover' && primary !== '' && (kind === 'leave' || kind === 'less' || reward > 0.2)) {
      const next = onTrialOutcome(deps.history.trialOf(primary), reward, nowMs);
      deps.history.setTrial(primary, next);
      if (next.blockedUntil !== undefined && next.blockedUntil > nowMs) purgeArtists(new Set([primary]));
    }
    if (item.bucket !== 'known') {
      deps.history.setExploration(observeExploration(exploration(), item.bucket, reward, extra.earlySkip === true));
    }
    if (kind === 'less') {
      for (const a of artistIds) deps.history.avoid(a, nowMs + C.avoidMs);
      reflowAfterAvoid(artistIds, id);
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
    slotsServed.clear();
    exposures.clear();
    lastActive = 0;
    setStatus({ exhausted: false, full: false, error: null });
  };

  if (enrichment !== null) enrichment.subscribe(onEnrichmentUpdate);

  const exposureOf = (id: string) => {
    const cur = exposures.get(id);
    if (cur !== undefined) return cur;
    const fresh = { leaves: 0, returns: 0 };
    exposures.set(id, fresh);
    return fresh;
  };

  return {
    items: () => items,
    itemById: (id) => byId.get(id),
    status: () => status,
    bootstrap,
    seedsSettled,

    async ensureAhead(activeIndex) {
      lastActive = Math.max(0, Math.floor(Number.isFinite(activeIndex) ? activeIndex : 0));
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
      const ex = exposureOf(id);
      // この訪問の離脱はもう数えた(画面が隠れたときの記録と、実際の離脱の二重計上を防ぐ)
      if (ex.leaves > ex.returns) return;
      const outcome = leaveOutcome(signal);
      if (outcome === null) return;
      ex.leaves++;
      feedback(id, 'leave', outcome.reward, { earlySkip: isEarlySkip(signal), outcome, dwellMs: signal.dwellMs ?? signal.playedMs });
    },
    markReturned(id) {
      exposureOf(id).returns++;
      feedback(id, 'return', actionReward('return'));
    },
    markLiked: (id) => feedback(id, 'like', actionReward('like')),
    markUnliked: (id) => feedback(id, 'unlike', actionReward('unlike')),
    markAddedToPlaylist: (id) => feedback(id, 'playlist', actionReward('playlist')),
    markOpened: (id) => feedback(id, 'open', actionReward('open')),
    markShared: (id) => feedback(id, 'share', actionReward('share')),
    markMore: (id) => feedback(id, 'more', actionReward('more')),
    markLess: (id) => feedback(id, 'less', actionReward('less')),

    async reset() {
      await deps.history.reset();
      clearItems();
      filterCounts.clear();
      session = createSession(now());
      sessionRestored = true;
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

    flush: () => deps.history.flush(),

    feedStats() {
      const nowMs = now();
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
      const sess = currentSession();
      const trials = { active: 0, graduated: 0, blocked: 0 };
      for (const t of Object.values(deps.history.trials())) {
        if (t.blockedUntil !== undefined && t.blockedUntil > nowMs) trials.blocked++;
        else if (t.stage >= 3) trials.graduated++;
        else trials.active++;
      }
      const g = decayed(deps.history.actionCounts('global'), nowMs);
      const rates = {} as Record<ActionName, number>;
      for (const a of ACTIONS) rates[a] = g.n > 0 ? Math.min(1, (g.k[a] ?? 0) / g.n) : 0;
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
        session: { cards: sess.cards, minutes: Math.max(0, nowMs - sess.startedAt) / 60_000, confidence: confidenceOf(sess), topInterests: topInterests(sess) },
        slots: Object.fromEntries(slotsServed) as Partial<Record<SlotKind, number>>,
        filters: Object.fromEntries(filterCounts) as Partial<Record<FilterReason, number>>,
        trials,
        valueModel: { rates, exposures: g.n },
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
