import { describe, expect, it, vi } from 'vitest';
import { getEntry, MemoryStore, setWithTtl, type KeyValueStore } from '../spotify/cache';
import { loadSeeds, POOL_TTL, SEED_SOURCE_COUNT, seedCacheKey, startSeeds, type Seeds } from './sources';
import { createFakeApi, fixtureTrack, paging } from './testApi';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
/** 偽 API の種: top 3×20 + saved 50 + recent 10 */
const FAKE_KNOWN = 3 * 20 + 50 + 10;

const staleSavedPage = () => paging(Array.from({ length: 50 }, (_, i) => ({ added_at: '2026-01-01', track: fixtureTrack(9000 + i) })), 500);

describe('loadSeeds(全確定)', () => {
  it('9 ソースを 1 コールずつ集約する(曲・重み順のアーティスト・ジャンル・所有プレイリスト)', async () => {
    const { api, calls } = createFakeApi();
    const seeds = await loadSeeds({ api, store: new MemoryStore(), now: () => NOW });
    expect(calls).toHaveLength(SEED_SOURCE_COUNT);
    expect(seeds.known).toHaveLength(FAKE_KNOWN);
    expect(seeds.savedTotal).toBe(500);
    expect(seeds.playlists.map((p) => p.id)).toEqual(['pl1']);
    expect(seeds.userId).toBe('me');
    expect(seeds.failures).toBe(0);
    expect(seeds.genres).toEqual(expect.arrayContaining(['shoegaze', 'city pop']));
    for (let i = 1; i < seeds.artists.length; i++) {
      expect(seeds.artists[i - 1]?.weight ?? 0).toBeGreaterThanOrEqual(seeds.artists[i]?.weight ?? 0);
    }
  });

  it('ネットワーク要求は固定順(曲が直接手に入る 3 本が先頭)', async () => {
    const { api, calls } = createFakeApi();
    await loadSeeds({ api, store: new MemoryStore(), now: () => NOW });
    expect(calls).toEqual([
      'topTracks:short_term',
      'savedTracks:0',
      'recentlyPlayed',
      'topArtists',
      'topTracks:medium_term',
      'followedArtists',
      'topTracks:long_term',
      'myPlaylists',
      'me',
    ]);
  });

  it('失敗したソースは failures に数え、依存する所有プレイリストは空になる', async () => {
    const { api } = createFakeApi({
      me: async () => {
        throw new Error('boom');
      },
    });
    const seeds = await loadSeeds({ api, store: new MemoryStore(), now: () => NOW });
    expect(seeds.failures).toBe(1);
    expect(seeds.userId).toBeNull();
    expect(seeds.playlists).toEqual([]);
    expect(seeds.known).toHaveLength(FAKE_KNOWN);
  });

  it('キャッシュの読み書きに失敗しても取得した値は使う', async () => {
    const inner = new MemoryStore();
    const store: KeyValueStore = {
      get: async () => {
        throw new Error('read');
      },
      set: async () => {
        throw new Error('quota');
      },
      del: (k) => inner.del(k),
      keys: () => inner.keys(),
    };
    const { api, calls } = createFakeApi();
    const seeds = await loadSeeds({ api, store, now: () => NOW });
    expect(calls).toHaveLength(SEED_SOURCE_COUNT);
    expect(seeds.failures).toBe(0);
    expect(seeds.known).toHaveLength(FAKE_KNOWN);
  });

  it('全部 fresh なら onUpdate は final の 1 回だけで、コールはゼロ', async () => {
    const store = new MemoryStore();
    await loadSeeds({ api: createFakeApi().api, store, now: () => NOW });
    const { api, calls } = createFakeApi();
    const finals: boolean[] = [];
    const seeds = await startSeeds({ api, store, now: () => NOW }, { onUpdate: (_s, final) => finals.push(final) }).done;
    expect(calls).toHaveLength(0);
    expect(finals).toEqual([true]);
    expect(seeds.known).toHaveLength(FAKE_KNOWN);
  });
});

describe('startSeeds(逐次合流)', () => {
  it('first は曲を含む最初のソースで解決し、done は全確定まで待つ', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = createFakeApi({}, { delay: (c) => (c === 'topTracks:short_term' ? 10 : 100) });
      const updates: { known: number; final: boolean }[] = [];
      const got = { first: null as Seeds | null, done: null as Seeds | null };
      const load = startSeeds(
        { api, store: new MemoryStore(), now: () => NOW },
        { onUpdate: (s, final) => updates.push({ known: s.known.length, final }) },
      );
      void load.first.then((s) => {
        got.first = s;
      });
      void load.done.then((s) => {
        got.done = s;
      });
      await vi.advanceTimersByTimeAsync(15);
      expect(calls).toHaveLength(SEED_SOURCE_COUNT);
      expect(got.first?.known).toHaveLength(20);
      expect(got.done).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(got.done?.known).toHaveLength(FAKE_KNOWN);
      expect(updates.filter((u) => u.final)).toHaveLength(1);
      expect(updates.at(-1)?.final).toBe(true);
      expect(updates.at(-1)?.known).toBe(FAKE_KNOWN);
    } finally {
      vi.useRealTimers();
    }
  });

  it('曲の無いソースだけ先に届いても first は解決しない', async () => {
    vi.useFakeTimers();
    try {
      const noTrack = new Set(['me', 'topArtists', 'followedArtists', 'myPlaylists']);
      const { api } = createFakeApi({}, { delay: (c) => (noTrack.has(c) ? 10 : 100) });
      const got = { first: null as Seeds | null };
      const load = startSeeds({ api, store: new MemoryStore(), now: () => NOW });
      void load.first.then((s) => {
        got.first = s;
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(got.first).toBeNull();
      await vi.advanceTimersByTimeAsync(100);
      expect(got.first?.known.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('期限切れでも 24h 以内のキャッシュは即使い(ゼロコールで first)、裏で再取得して置き換える', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      await setWithTtl(store, seedCacheKey('saved:0'), staleSavedPage(), POOL_TTL.saved, NOW - 3 * HOUR);
      const { api, calls } = createFakeApi({}, { delay: () => 100 });
      const got = { first: null as Seeds | null, done: null as Seeds | null };
      const load = startSeeds({ api, store, now: () => NOW });
      void load.first.then((s) => {
        got.first = s;
      });
      void load.done.then((s) => {
        got.done = s;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(got.first?.known.map((c) => c.track.id)).toContain('t9000');
      expect(got.first?.known).toHaveLength(50);
      expect(got.first?.savedTotal).toBe(500);
      expect(calls).toContain('savedTracks:0');
      expect(got.done).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(got.done?.failures).toBe(0);
      const ids = got.done?.known.map((c) => c.track.id) ?? [];
      expect(ids).toContain('t2000');
      expect(ids).not.toContain('t9000');
      expect((await getEntry(store, seedCacheKey('saved:0'), NOW))?.fresh).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stale の再取得に失敗しても値は残り、失敗に数えない', async () => {
    const store = new MemoryStore();
    await setWithTtl(store, seedCacheKey('saved:0'), staleSavedPage(), POOL_TTL.saved, NOW - 3 * HOUR);
    const { api } = createFakeApi({
      savedTracks: async () => {
        throw new Error('boom');
      },
    });
    const seeds = await loadSeeds({ api, store, now: () => NOW });
    expect(seeds.failures).toBe(0);
    expect(seeds.known.map((c) => c.track.id)).toContain('t9000');
    expect(seeds.savedTotal).toBe(500);
  });

  it('24h より古いキャッシュは使わず、取得を待つ', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      await setWithTtl(store, seedCacheKey('top:tracks:short'), paging([fixtureTrack(9100)]), POOL_TTL.top, NOW - 25 * HOUR);
      const { api } = createFakeApi({}, { delay: () => 100 });
      const got = { first: null as Seeds | null };
      const load = startSeeds({ api, store, now: () => NOW });
      void load.first.then((s) => {
        got.first = s;
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(got.first).toBeNull();
      await vi.advanceTimersByTimeAsync(100);
      expect(got.first?.known.map((c) => c.track.id)).not.toContain('t9100');
    } finally {
      vi.useRealTimers();
    }
  });
});
