import { describe, expect, it, vi } from 'vitest';
import { getEntry, MemoryStore } from '../spotify/cache';
import { createFeedEngine, FEED_CONSTANTS, type FeedEngine, type FeedSettings } from './feedEngine';
import { createHistory, type History } from './history';
import { mulberry32 } from './rng';
import { dedupeKey } from './scheduler';
import { loadSeeds, SEED_SOURCE_COUNT, seedCacheKey } from './sources';
import { createFakeApi } from './testApi';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function setup(
  opts: { discovery?: number; rateLimited?: boolean; seed?: number; maxItems?: number; history?: History; delay?: (call: string) => number } = {},
) {
  const { api, calls } = createFakeApi({}, { delay: opts.delay });
  const store = new MemoryStore();
  const history = opts.history ?? createHistory(new MemoryStore());
  const settings: FeedSettings = { discovery: opts.discovery ?? 0.5, genres: ['j-pop'] };
  const engine = createFeedEngine({
    api,
    store,
    history,
    settings: () => settings,
    rng: mulberry32(opts.seed ?? 1),
    now: () => NOW,
    isRateLimited: () => opts.rateLimited ?? false,
    constants: opts.maxItems !== undefined ? { maxItems: opts.maxItems } : undefined,
  });
  return { engine, calls, history, store, api };
}

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
  it('markSkipped で親和度が下がり、markLiked で上がる。reset で消える', async () => {
    const { engine, history } = setup({ discovery: 0 });
    await engine.ensureAhead(0);
    const first = engine.items()[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const artistId = first.track.artists[0]?.id ?? '';
    engine.markSkipped(first.id);
    expect(history.affinity(artistId)).toBeCloseTo(-1);
    engine.markLiked(first.id);
    expect(history.affinity(artistId)).toBeCloseTo(1);
    expect(history.actionOf(first.id)).toBe('liked');
    await engine.reset();
    expect(history.size()).toBe(0);
    expect(engine.items().length).toBeGreaterThan(0);
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
