import { describe, expect, it, vi } from 'vitest';
import { getEntry, MemoryStore } from '../spotify/cache';
import type { SpotifyApi } from '../spotify/endpoints';
import { createEnrichment, type Enrichment } from './enrichment';
import { COOLDOWN_CARDS } from './exploration';
import { createFeedEngine, FEED_CONSTANTS, type FeedConstants, type FeedEngine, type FeedSettings } from './feedEngine';
import { createHistory, type History } from './history';
import type { LeaveSignal } from './reward';
import { mulberry32 } from './rng';
import { dedupeKey } from './scheduler';
import { loadSeeds, SEED_SOURCE_COUNT, seedCacheKey } from './sources';
import { createFakeApi, createFakeExternal } from './testApi';
import { reasonLabel } from './types';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
/** 偽 API の種に出てくる既知アーティスト(top/saved/recent の a0..a6、トップアーティスト、フォロー) */
const KNOWN_ARTIST_IDS = new Set(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'f1', 'f2']);

function setup(
  opts: {
    discovery?: number;
    rateLimited?: boolean;
    seed?: number;
    maxItems?: number;
    history?: History;
    delay?: (call: string) => number;
    external?: boolean;
    externalSources?: boolean;
    constants?: Partial<FeedConstants>;
    api?: Partial<SpotifyApi>;
  } = {},
) {
  const { api, calls } = createFakeApi(opts.api ?? {}, { delay: opts.delay });
  const store = new MemoryStore();
  const history = opts.history ?? createHistory(new MemoryStore());
  const settings: FeedSettings = { discovery: opts.discovery ?? 0.5, genres: ['j-pop'], externalSources: opts.externalSources ?? true, excludedTags: [] };
  const ext = createFakeExternal();
  const enrichment: Enrichment | null =
    opts.external === true ? createEnrichment({ ...ext, store, now: () => NOW, enabled: () => settings.externalSources !== false }) : null;
  const engine = createFeedEngine({
    api,
    store,
    history,
    settings: () => settings,
    enrichment,
    rng: mulberry32(opts.seed ?? 1),
    now: () => NOW,
    isRateLimited: () => opts.rateLimited ?? false,
    constants: { ...(opts.maxItems !== undefined ? { maxItems: opts.maxItems } : {}), ...opts.constants },
  });
  return { engine, calls, history, store, api, enrichment, externalCalls: ext.calls, settings };
}

const leave = (over: Partial<LeaveSignal> = {}): LeaveSignal => ({ playedMs: 20_000, durationMs: 200_000, cause: 'user', advanceAfterMs: 60_000, ...over });
const earlySkip = (): LeaveSignal => leave({ playedMs: 1000 });
const completed = (): LeaveSignal => leave({ playedMs: 60_000, cause: 'auto_advance' });

function assertWellFormed(engine: FeedEngine) {
  const items = engine.items();
  const ids = new Set(items.map((i) => i.id));
  expect(ids.size).toBe(items.length);
  const keys = new Set(items.map((i) => dedupeKey(i.track)));
  expect(keys.size).toBe(items.length);
  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    if (cur === undefined) continue;
    const window = items.slice(Math.max(0, i - FEED_CONSTANTS.artistSpacing), i);
    const curArtists = new Set(cur.track.artists.map((a) => a.id));
    for (const prev of window) {
      expect(prev.track.artists.some((a) => curArtists.has(a.id))).toBe(false);
    }
  }
}

describe('bootstrap', () => {
  it('種の取得は 9 コール以内、2 回目はキャッシュで 0 コール', async () => {
    const { engine, calls, store } = setup();
    await engine.bootstrap();
    await engine.seedsSettled();
    expect(calls.length).toBeLessThanOrEqual(SEED_SOURCE_COUNT);
    expect(engine.status().seedsLoaded).toBe(true);

    const { api: api2, calls: calls2 } = createFakeApi();
    const engine2 = createFeedEngine({
      api: api2,
      store,
      history: createHistory(new MemoryStore()),
      settings: () => ({ discovery: 0.5, genres: [] }),
      now: () => NOW,
    });
    await engine2.seedsSettled();
    expect(calls2).toHaveLength(0);
    expect(engine2.status().seedsLoaded).toBe(true);
  });

  it('bootstrap は曲を含む最初の種で解決し、残りは裏で合流する', async () => {
    vi.useFakeTimers();
    try {
      const { engine, calls } = setup({ discovery: 0, delay: (c) => (c === 'topTracks:short_term' ? 10 : 200) });
      const got = { booted: false };
      void engine.bootstrap().then(() => {
        got.booted = true;
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(got.booted).toBe(true);
      expect(engine.status().seedsLoaded).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      expect(engine.status().seedsLoaded).toBe(true);
      expect(calls).toHaveLength(SEED_SOURCE_COUNT);

      const p = engine.ensureAhead(0);
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      const reasons = new Set(engine.items().map((i) => i.reason));
      expect(reasons.has('saved') || reasons.has('recent')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('期限切れの種でも最初のカードはゼロコールで出て、裏で再取得する', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      // 3 時間前の取得: top / following / me は fresh、saved / playlists / recent は期限切れ(24h 以内の stale)
      await loadSeeds({ api: createFakeApi().api, store, now: () => NOW - 3 * HOUR });
      const { api, calls } = createFakeApi({}, { delay: () => 500 });
      const engine = createFeedEngine({
        api,
        store,
        history: createHistory(new MemoryStore()),
        settings: () => ({ discovery: 0.5, genres: [] }),
        rng: mulberry32(3),
        now: () => NOW,
      });
      const p = engine.ensureAhead(0);
      await vi.advanceTimersByTimeAsync(5);
      expect(engine.items().length).toBeGreaterThanOrEqual(1);
      expect(calls).toContain('savedTracks:0');
      expect(calls).toContain('myPlaylists');
      expect(calls).toContain('recentlyPlayed');
      expect(calls.some((c) => c.startsWith('topTracks') || c === 'topArtists' || c === 'followedArtists' || c === 'me')).toBe(false);

      await vi.advanceTimersByTimeAsync(3000);
      await p;
      await engine.seedsSettled();
      expect(engine.status().seedsLoaded).toBe(true);
      expect(calls.length - 3).toBeLessThanOrEqual(FEED_CONSTANTS.budgetPerRefill);
      expect((await getEntry(store, seedCacheKey('recent'), NOW))?.fresh).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ensureAhead', () => {
  it('20 件以上を追加し、補充の API 呼び出しは予算(6)以内。重複・連続アーティスト無し', async () => {
    const { engine, calls } = setup();
    await engine.ensureAhead(0);
    expect(engine.items().length).toBeGreaterThanOrEqual(FEED_CONSTANTS.refillTarget);
    expect(calls.length - SEED_SOURCE_COUNT).toBeLessThanOrEqual(FEED_CONSTANTS.budgetPerRefill);
    assertWellFormed(engine);
    expect(engine.items().every((i) => i.reason !== undefined && i.bucket !== undefined)).toBe(true);
  });

  it('最初の補充は拡張の応答を待たずに数枚出し、その後 20 枚まで埋める', async () => {
    vi.useFakeTimers();
    try {
      const { engine, calls } = setup({ delay: (c) => (/^(artistAlbums|album|search)/.test(c) ? 500 : 0) });
      const p = engine.ensureAhead(0);
      await vi.advanceTimersByTimeAsync(5);
      const early = engine.items();
      expect(early.length).toBeGreaterThanOrEqual(1);
      expect(early.length).toBeLessThanOrEqual(FEED_CONSTANTS.initialDraw);
      expect(early.every((i) => i.bucket === 'known')).toBe(true);
      expect(engine.status().loading).toBe(true);

      await vi.advanceTimersByTimeAsync(3000);
      await p;
      expect(engine.status().loading).toBe(false);
      expect(engine.items().length).toBeGreaterThanOrEqual(FEED_CONSTANTS.refillTarget);
      expect(calls.length - SEED_SOURCE_COUNT).toBeLessThanOrEqual(FEED_CONSTANTS.budgetPerRefill);
      assertWellFormed(engine);
    } finally {
      vi.useRealTimers();
    }
  });

  it('残りが十分なら補充しない', async () => {
    const { engine, calls } = setup();
    await engine.ensureAhead(0);
    const before = calls.length;
    const count = engine.items().length;
    await engine.ensureAhead(0);
    expect(calls.length).toBe(before);
    expect(engine.items().length).toBe(count);
    await engine.ensureAhead(count - FEED_CONSTANTS.aheadMin);
    expect(engine.items().length).toBeGreaterThan(count);
  });

  it('発見度 0 は既知だけ、発見度 1 は既知以外が多数', async () => {
    const known = setup({ discovery: 0 });
    await known.engine.ensureAhead(0);
    expect(known.engine.items().every((i) => i.bucket === 'known')).toBe(true);

    const discover = setup({ discovery: 1, seed: 5 });
    await discover.engine.ensureAhead(0);
    // 未知アーティストは反応が来るまで 1 枚ずつ(段階配信)なので、最初のバッチを聴き通してから次を見る
    for (const it of discover.engine.items()) discover.engine.markLeft(it.id, completed());
    await discover.engine.ensureAhead(discover.engine.items().length - 1);
    const items = discover.engine.items();
    const nonKnown = items.filter((i) => i.bucket !== 'known').length;
    expect(nonKnown / items.length).toBeGreaterThan(0.6);
    assertWellFormed(discover.engine);
  });

  it('レート制限中は API を呼ばず、種の既知プールから供給する', async () => {
    const { engine, calls } = setup({ rateLimited: true });
    await engine.bootstrap();
    await engine.seedsSettled();
    const before = calls.length;
    await engine.ensureAhead(0);
    expect(calls.length).toBe(before);
    expect(engine.items().length).toBeGreaterThanOrEqual(FEED_CONSTANTS.refillTarget);
  });

  it('履歴にある曲は出さない', async () => {
    const history = createHistory(new MemoryStore());
    for (let i = 0; i < 20; i++) history.record(`t${1000 + i}`, 'played', [], NOW);
    const { engine } = setup({ history, discovery: 0 });
    await engine.ensureAhead(0);
    expect(engine.items().some((i) => i.id.startsWith('t100') || i.id.startsWith('t101'))).toBe(false);
  });

  it('上限に達したら full になり、restart で作り直せる', async () => {
    const { engine } = setup({ maxItems: 25 });
    await engine.ensureAhead(0);
    await engine.ensureAhead(engine.items().length - 1);
    expect(engine.items().length).toBeLessThanOrEqual(25);
    await engine.ensureAhead(engine.items().length - 1);
    expect(engine.status().full).toBe(true);
    await engine.restart();
    expect(engine.status().full).toBe(false);
    expect(engine.items().length).toBeGreaterThan(0);
  });
});

describe('履歴連携', () => {
  it('早期スキップで親和度が下がり、いいねで上がる。reset で消える', async () => {
    const { engine, history } = setup({ discovery: 0 });
    await engine.ensureAhead(0);
    const first = engine.items()[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const artistId = first.track.artists[0]?.id ?? '';
    engine.markLeft(first.id, earlySkip());
    expect(history.affinity(artistId)).toBeLessThan(0);
    expect(history.actionOf(first.id)).toBe('skipped');
    engine.markLiked(first.id);
    expect(history.affinity(artistId)).toBeGreaterThanOrEqual(0);
    expect(history.actionOf(first.id)).toBe('liked');
    engine.markLeft(first.id, leave({ playedMs: 0 }));
    expect(history.actionOf(first.id)).toBe('liked');
    await engine.reset();
    expect(history.size()).toBe(0);
    expect(engine.items().length).toBeGreaterThan(0);
  });

  it('「これは違う」でアーティストを避け、作り直しても出ない', async () => {
    const { engine, history } = setup({ discovery: 0 });
    await engine.ensureAhead(0);
    const first = engine.items()[0];
    if (first === undefined) throw new Error('no items');
    const artistId = first.track.artists[0]?.id ?? '';
    engine.markLess(first.id);
    expect(history.isAvoided(artistId, NOW)).toBe(true);
    await engine.restart();
    expect(engine.items().length).toBeGreaterThan(0);
    expect(engine.items().some((i) => i.track.artists.some((a) => a.id === artistId))).toBe(false);
  });

  it('発見カードの早期スキップが続くとクールダウンに入り、次の補充は発見を控える', async () => {
    const { engine } = setup({ discovery: 1, seed: 7 });
    await engine.ensureAhead(0);
    const discover = engine.items().filter((i) => i.bucket === 'discover');
    expect(discover.length).toBeGreaterThanOrEqual(4);
    for (const it of discover.slice(0, 4)) engine.markLeft(it.id, earlySkip());
    expect(engine.feedStats().exploration.cooldownLeft).toBe(COOLDOWN_CARDS);
    const before = engine.items().length;
    await engine.ensureAhead(before - 1);
    const fresh = engine.items().slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.slice(0, COOLDOWN_CARDS).every((i) => i.bucket !== 'discover')).toBe(true);
    expect(engine.feedStats().exploration.cooldownLeft).toBeLessThan(COOLDOWN_CARDS);
    expect(engine.feedStats().effectiveDiscovery).toBeLessThan(1);
  });

  it('feedStats は戦略ごとの統計と直近の手応えを返す', async () => {
    const { engine } = setup({ discovery: 0.8 });
    await engine.ensureAhead(0);
    const exploratory = engine.items().filter((i) => i.bucket !== 'known');
    expect(exploratory.length).toBeGreaterThan(0);
    for (const it of exploratory.slice(0, 5)) engine.markLeft(it.id, completed());
    const s = engine.feedStats();
    expect(Object.keys(s.strategies)).toContain('similar_artist');
    expect(s.recent.count).toBeGreaterThan(0);
    expect(s.recent.hitRate).toBeGreaterThan(0);
    expect(s.external).toBeNull();
    expect(Object.values(s.served).reduce((a, b) => a + (b ?? 0), 0)).toBe(engine.items().filter((i) => i.strategy !== undefined).length);
  });

  it('subscribe は追加のたびに通知される', async () => {
    const { engine } = setup();
    let notified = 0;
    const unsub = engine.subscribe(() => notified++);
    await engine.ensureAhead(0);
    expect(notified).toBeGreaterThan(0);
    unsub();
  });
});

describe('発見(未知性・保存済み判定)', () => {
  it('adjacent / discover のカードは既知アーティストの曲ではない(アルバム深掘りを除く)', async () => {
    const { engine } = setup({ discovery: 1, seed: 5 });
    await engine.ensureAhead(0);
    await engine.ensureAhead(engine.items().length - 1);
    const exploratory = engine.items().filter((i) => i.bucket !== 'known' && i.reason !== 'deepcut');
    expect(exploratory.length).toBeGreaterThan(0);
    expect(exploratory.every((i) => !KNOWN_ARTIST_IDS.has(i.track.artists[0]?.id ?? ''))).toBe(true);
  });

  it('保存済み判定は補充ごとに 1 コール(予算内)。発見の曲で保存済みなら落とし、他は saved を付ける', async () => {
    let containsCalls = 0;
    const { engine, calls } = setup({
      discovery: 0.6,
      api: {
        libraryContains: async (uris) => {
          containsCalls++;
          return uris.map(() => true);
        },
      },
    });
    await engine.ensureAhead(0);
    expect(containsCalls).toBeGreaterThan(0);
    expect(calls.length + containsCalls - SEED_SOURCE_COUNT).toBeLessThanOrEqual(FEED_CONSTANTS.budgetPerRefill);
    const items = engine.items();
    expect(items.every((i) => i.bucket === 'known')).toBe(true);
    expect(items.slice(FEED_CONSTANTS.initialDraw).every((i) => i.saved === true)).toBe(true);
    const flagged = setup({ discovery: 0.6 });
    await flagged.engine.ensureAhead(0);
    expect(flagged.calls.filter((c) => c === 'libraryContains').length).toBeGreaterThan(0);
    expect(flagged.calls.length - SEED_SOURCE_COUNT).toBeLessThanOrEqual(FEED_CONSTANTS.budgetPerRefill);
    expect(flagged.engine.items().slice(FEED_CONSTANTS.initialDraw).every((i) => i.saved === false)).toBe(true);
    expect(flagged.engine.items().some((i) => i.bucket !== 'known')).toBe(true);
  });
});

describe('外部データ(類似アーティスト)', () => {
  it('強化後に「〇〇 が好きなら」のカードが出て、種と hop が付く', async () => {
    const { engine, enrichment, externalCalls } = setup({ discovery: 0.8, external: true, seed: 3, constants: { topUpCards: 0 } });
    await engine.ensureAhead(0);
    await engine.seedsSettled();
    if (enrichment === null) throw new Error('no enrichment');
    await enrichment.idle();
    expect(externalCalls.some((c) => c.startsWith('lb:similar'))).toBe(true);
    await engine.ensureAhead(engine.items().length - 1);
    await engine.ensureAhead(engine.items().length - 1);
    await engine.ensureAhead(engine.items().length - 1);
    const similar = engine.items().filter((i) => i.reason === 'similar');
    expect(similar.length).toBeGreaterThan(0);
    const first = similar[0];
    if (first === undefined) throw new Error('unreachable');
    expect(first.reasonDetail).toMatch(/^Artist /);
    expect(reasonLabel(first)).toMatch(/が好きなら$/);
    expect(similar.every((i) => i.seed !== undefined && i.hop === 1 && i.strategy === 'similar_artist' && i.bucket === 'discover')).toBe(true);
    expect(similar.every((i) => !KNOWN_ARTIST_IDS.has(i.track.artists[0]?.id ?? ''))).toBe(true);
    expect(engine.feedStats().external?.similarSeeds).toBeGreaterThan(0);
    expect(engine.feedStats().topTags.map((t) => t.tag)).toContain('j-pop');
  });

  it('類似が届いたら次の補充を待たずに数枚だけ先出しする(1 コール + 判定 1 コール)', async () => {
    const { engine, enrichment, calls } = setup({ discovery: 0.8, external: true, seed: 3 });
    await engine.ensureAhead(0);
    await engine.seedsSettled();
    const before = calls.length;
    const count = engine.items().length;
    if (enrichment === null) throw new Error('no enrichment');
    await enrichment.idle();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const fresh = engine.items().slice(count);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.length).toBeLessThanOrEqual(FEED_CONSTANTS.topUpCards);
    expect(fresh.every((i) => i.reason === 'similar')).toBe(true);
    expect(calls.length - before).toBeLessThanOrEqual(2);
  });

  it('設定で外部を切ると外部は 0 コールで、類似カードも出ない', async () => {
    const { engine, externalCalls } = setup({ discovery: 1, external: true, externalSources: false });
    await engine.ensureAhead(0);
    await engine.seedsSettled();
    await engine.ensureAhead(engine.items().length - 1);
    expect(externalCalls).toEqual([]);
    expect(engine.items().some((i) => i.reason === 'similar')).toBe(false);
    expect(engine.feedStats().external).toBeNull();
  });

  it('いいね → 類似録音 → 「『曲』に似た曲」。hop 1 の好評 → 橋渡し(bridge)の種になる', async () => {
    const { engine, enrichment } = setup({ discovery: 1, external: true, seed: 9, constants: { topUpCards: 0 } });
    await engine.ensureAhead(0);
    await engine.seedsSettled();
    if (enrichment === null) throw new Error('no enrichment');
    await enrichment.idle();
    const liked = engine.items()[0];
    if (liked === undefined) throw new Error('no items');
    engine.markLiked(liked.id);
    await enrichment.idle();
    expect(enrichment.tracksWithSimilar()).toEqual([liked.id]);
    let similarTrack = engine.items().find((i) => i.reason === 'similar_track');
    for (let round = 0; round < 6 && similarTrack === undefined; round++) {
      await engine.ensureAhead(engine.items().length - 1);
      similarTrack = engine.items().find((i) => i.reason === 'similar_track');
    }
    expect(similarTrack?.reasonDetail).toBe(liked.track.name);
    expect(reasonLabel(similarTrack ?? liked)).toContain('に似た曲');

    const similar = engine.items().find((i) => i.reason === 'similar');
    if (similar === undefined) throw new Error('no similar');
    for (let i = 0; i < 3; i++) engine.markLeft(similar.id, completed());
    await enrichment.idle();
    expect(enrichment.similarOf(similar.track.artists[0]?.id ?? '').length).toBeGreaterThan(0);
    let bridge = engine.items().find((i) => i.reason === 'bridge');
    for (let round = 0; round < 8 && bridge === undefined; round++) {
      await engine.ensureAhead(engine.items().length - 1);
      bridge = engine.items().find((i) => i.reason === 'bridge');
    }
    expect(bridge?.hop).toBe(2);
    expect(bridge?.reasonDetail).toContain(' → ');
  });

  it('シミュレーション: 類似アーティストの曲を聴き通し、他の発見を飛ばす人には、類似の戦略が学習される', async () => {
    const { engine, enrichment } = setup({ discovery: 0.7, external: true, seed: 11, constants: { topUpCards: 0 } });
    await engine.ensureAhead(0);
    await engine.seedsSettled();
    if (enrichment === null) throw new Error('no enrichment');
    await enrichment.idle();
    let seen = 0;
    for (let round = 0; round < 8; round++) {
      await engine.ensureAhead(engine.items().length - 1);
      const fresh = engine.items().slice(seen);
      seen = engine.items().length;
      for (const it of fresh) {
        if (it.reason === 'similar' || it.reason === 'bridge' || it.reason === 'similar_track') engine.markLeft(it.id, completed());
        else if (it.bucket === 'discover') engine.markLeft(it.id, earlySkip());
        else engine.markLeft(it.id, leave());
      }
    }
    const s = engine.feedStats();
    expect(s.strategies.similar_artist.mean).toBeGreaterThan(s.strategies.tag_hipster.mean);
    expect(s.strategies.similar_artist.mean).toBeGreaterThan(s.strategies.genre_search.mean);
    expect((s.served.similar_artist ?? 0) > 0).toBe(true);
  });
});

const primaryOf = (it: { track: { artists: { id: string }[] } }) => it.track.artists[0]?.id ?? '';

describe('For You(価値モデル・セッション・段階配信)', () => {
  it('items に枠・期待値・予測が付き、feedStats にセッション・枠・フィルタ・試験・反応率が出る', async () => {
    const { engine } = setup({ discovery: 0.7, seed: 3 });
    await engine.ensureAhead(0);
    const items = engine.items();
    expect(items[0]?.slot).toBe('anchor');
    expect(items.every((i) => i.slot !== undefined && typeof i.score === 'number' && typeof i.ev === 'number' && i.predictions !== undefined)).toBe(true);
    for (const it of items.slice(0, 5)) engine.markLeft(it.id, completed());
    const s = engine.feedStats();
    expect(s.session.cards).toBe(5);
    expect(s.session.confidence).toBeGreaterThan(0);
    expect(Object.values(s.slots).reduce((a, b) => a + (b ?? 0), 0)).toBe(items.length);
    expect(s.valueModel.exposures).toBeCloseTo(5);
    expect(s.valueModel.rates.complete).toBeCloseTo(1);
    expect(s.trials.active + s.trials.graduated + s.trials.blocked).toBeGreaterThanOrEqual(0);
    expect(Object.keys(s.filters).length).toBeGreaterThan(0);
  });

  it('同じ訪問の離脱は 1 回だけ学習し、戻ってきた後はもう 1 回学習する', async () => {
    const { engine, history } = setup({ discovery: 0 });
    await engine.ensureAhead(0);
    const first = engine.items()[0];
    if (first === undefined) throw new Error('no items');
    engine.markLeft(first.id, completed());
    engine.markLeft(first.id, completed());
    expect(history.actionCounts('global').n).toBeCloseTo(1);
    expect(history.recent()).toHaveLength(1);
    engine.markReturned(first.id);
    engine.markLeft(first.id, completed());
    expect(history.actionCounts('global').n).toBeCloseTo(2);
    expect(history.actionCounts('global').k.return).toBeCloseTo(1);
  });

  it('共有は主アーティストとタグの計数に入り、そのアーティストの期待値が上がる', async () => {
    const { engine, history } = setup({ discovery: 0 });
    await engine.ensureAhead(0);
    const first = engine.items()[0];
    if (first === undefined) throw new Error('no items');
    engine.markShared(first.id);
    expect(history.actionCounts('artist', primaryOf(first))?.k.share).toBeCloseTo(1);
    expect(history.recent()[0]?.reward).toBe(1);
    expect(history.affinity(primaryOf(first))).toBeGreaterThan(0);
  });

  it('「これは違う」でプールと未表示のキュー(active+3 より先)から同アーティストが消え、同数がゼロコールで引き直される', async () => {
    const { engine, calls } = setup({ discovery: 0 });
    await engine.ensureAhead(0);
    const active = 2;
    await engine.ensureAhead(active);
    const before = engine.items();
    const target = before[active];
    if (target === undefined) throw new Error('no items');
    const artistId = primaryOf(target);
    expect(before.slice(active + 4).some((i) => primaryOf(i) === artistId)).toBe(true);
    const callsBefore = calls.length;
    engine.markLess(target.id);
    const after = engine.items();
    expect(calls.length).toBe(callsBefore);
    expect(after.slice(0, active + 4).map((i) => i.id)).toEqual(before.slice(0, active + 4).map((i) => i.id));
    expect(after.length).toBe(before.length);
    expect(after.slice(active + 4).some((i) => i.track.artists.some((a) => a.id === artistId))).toBe(false);
    expect(engine.feedStats().pools.known).toBeGreaterThan(0);
    assertWellFormed(engine);

    const fixed = setup({ discovery: 0, constants: { pruneAheadKeep: Number.POSITIVE_INFINITY } });
    await fixed.engine.ensureAhead(0);
    const ids = fixed.engine.items().map((i) => i.id);
    const t = fixed.engine.items()[0];
    if (t === undefined) throw new Error('no items');
    fixed.engine.markLess(t.id);
    expect(fixed.engine.items().map((i) => i.id)).toEqual(ids);
  });

  it('未知アーティストは結果待ち 1 枚から始まり、聴き通すと次の補充で 2 枚目以降が出る', async () => {
    const { engine, enrichment, history } = setup({ discovery: 1, external: true, seed: 3, constants: { topUpCards: 0 } });
    await engine.ensureAhead(0);
    await engine.seedsSettled();
    if (enrichment === null) throw new Error('no enrichment');
    await enrichment.idle();
    let similar = engine.items().filter((i) => i.reason === 'similar');
    for (let round = 0; round < 4 && similar.length === 0; round++) {
      await engine.ensureAhead(engine.items().length - 1);
      similar = engine.items().filter((i) => i.reason === 'similar');
    }
    const first = similar[0];
    if (first === undefined) throw new Error('no similar');
    const artistId = primaryOf(first);
    const countOf = () => engine.items().filter((i) => primaryOf(i) === artistId).length;
    expect(countOf()).toBe(1);
    expect(history.trialOf(artistId)).toEqual({ stage: 0, shown: 1, at: NOW });
    // 反応が無いうちは同じアーティストを増やさない
    await engine.ensureAhead(engine.items().length - 1);
    expect(countOf()).toBe(1);
    engine.markLeft(first.id, completed());
    expect(history.trialOf(artistId)?.stage).toBe(1);
    await engine.ensureAhead(engine.items().length - 1);
    await engine.ensureAhead(engine.items().length - 1);
    expect(countOf()).toBeGreaterThanOrEqual(2);
    expect(countOf()).toBeLessThanOrEqual(3);
    assertWellFormed(engine);
  });

  it('シミュレーション(ラビットホール): city pop に長く居て j-pop 系を早めに離れると、以後の発見が city pop に寄る', async () => {
    const { engine, enrichment } = setup({ discovery: 1, external: true, seed: 11, constants: { topUpCards: 0 } });
    await engine.ensureAhead(0);
    await engine.seedsSettled();
    if (enrichment === null) throw new Error('no enrichment');
    await enrichment.idle();
    const tagsOf = (it: { track: { artists: { id: string }[] } }) => enrichment.tagsOfSpotifyArtist(primaryOf(it)) ?? [];
    const isCity = (it: { track: { artists: { id: string }[] } }) => tagsOf(it).includes('city pop');
    // WSJ の実験と同じ: 興味のあるもの(city pop)だけ最後まで聴き、それ以外は素早くスワイプ
    let seen = 0;
    let earlyCity = 0;
    let earlyAll = 0;
    let lateCity = 0;
    let lateAll = 0;
    for (let round = 0; round < 10; round++) {
      await engine.ensureAhead(engine.items().length - 1);
      await enrichment.idle();
      const fresh = engine.items().slice(seen);
      seen = engine.items().length;
      const similar = fresh.filter((i) => (i.reason === 'similar' || i.reason === 'bridge') && tagsOf(i).length > 0);
      const city = similar.filter(isCity).length;
      if (round < 3) {
        earlyCity += city;
        earlyAll += similar.length;
      } else if (round >= 6) {
        lateCity += city;
        lateAll += similar.length;
      }
      for (const it of fresh) {
        if (isCity(it)) engine.markLeft(it.id, leave({ playedMs: 60_000, cause: 'auto_advance', dwellMs: 60_000 }));
        else engine.markLeft(it.id, leave({ playedMs: 5_000, dwellMs: 5_000 }));
      }
    }
    expect(earlyAll).toBeGreaterThan(0);
    expect(lateAll).toBeGreaterThanOrEqual(4);
    expect(lateCity / lateAll).toBeGreaterThan(earlyCity / earlyAll);
    expect(lateCity / lateAll).toBeGreaterThan(0.6);
    expect(engine.feedStats().session.topInterests[0]?.key).toBe('city pop');
  });
});
