import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../spotify/cache';
import { createEnrichment } from './enrichment';
import { createFakeExternal, fixtureTrack } from './testApi';

const seeds = [
  { id: 'a1', name: 'Artist a1', weight: 3 },
  { id: 'a2', name: 'Artist a2', weight: 2 },
  { id: 'a3', name: 'Nobody a3', weight: 1 },
];

describe('enrichment', () => {
  it('種を重み順に解決し、類似アーティストとタグを集める。未解決の種は飛ばす', async () => {
    const ext = createFakeExternal();
    let updates = 0;
    const e = createEnrichment({ ...ext, store: new MemoryStore(), now: () => 1, enabled: () => true, onUpdate: () => updates++ });
    e.onSeeds(seeds);
    await e.idle();
    expect([...e.seedsWithSimilar()].sort()).toEqual(['a1', 'a2']);
    expect(e.similarOf('a1').map((s) => s.name)).toEqual(['Sim artista1 1', 'Sim artista1 2', 'Sim artista1 3', 'Sim artista1 4', 'Sim artista1 5']);
    expect(e.similarOf('a1')[0]?.rank).toBe(0);
    expect(ext.calls.filter((c) => c.startsWith('lb:similar'))).toHaveLength(1);
    expect(e.tagProfile().get('j-pop')).toBe(1);
    expect(e.tagProfile().get('anime')).toBeCloseTo(2 / 5);
    expect(e.tagsOfMbid('mb:sim-artista1-2')).toEqual(['city pop']);
    expect(e.tagsOfSpotifyArtist('a1')).toEqual(['j-pop', 'anime']);
    expect(e.mbidOfSpotifyArtist('a1')).toBe('mb:artista1');
    expect(updates).toBeGreaterThan(0);
    const s = e.stats();
    expect(s.resolvedArtists).toBe(2);
    expect(s.unresolvedArtists).toBe(1);
    expect(s.similarEntries).toBe(10);
  });

  it('使った類似は出さない。同じ種は二度処理しない。上限を超える種は捨てる', async () => {
    const ext = createFakeExternal();
    const e = createEnrichment({ ...ext, store: new MemoryStore(), now: () => 1, enabled: () => true, maxSeeds: 1 });
    e.onSeeds(seeds);
    e.onSeeds(seeds);
    await e.idle();
    expect(e.seedsWithSimilar()).toEqual(['a1']);
    e.markUsed('a1', 'mb:sim-artista1-1');
    expect(e.similarOf('a1')[0]?.name).toBe('Sim artista1 2');
    for (const x of e.similarOf('a1')) e.markUsed('a1', x.mbid);
    expect(e.seedsWithSimilar()).toEqual([]);
    expect(ext.calls.filter((c) => c.startsWith('mb:search'))).toEqual(['mb:search:Artist a1']);
  });

  it('2 回目はキャッシュから(外部ゼロコール)', async () => {
    const store = new MemoryStore();
    const first = createFakeExternal();
    const e1 = createEnrichment({ ...first, store, now: () => 1, enabled: () => true });
    e1.onSeeds(seeds.slice(0, 1));
    await e1.idle();
    const second = createFakeExternal();
    const e2 = createEnrichment({ ...second, store, now: () => 2, enabled: () => true });
    e2.onSeeds(seeds.slice(0, 1));
    await e2.idle();
    expect(second.calls).toEqual([]);
    expect(e2.similarOf('a1')).toHaveLength(5);
    expect(e2.stats().cacheHits).toBeGreaterThan(0);
  });

  it('無効なら何もしない', async () => {
    const ext = createFakeExternal();
    const e = createEnrichment({ ...ext, store: new MemoryStore(), now: () => 1, enabled: () => false });
    e.onSeeds(seeds);
    e.onLiked(fixtureTrack(1));
    await e.idle();
    expect(ext.calls).toEqual([]);
    expect(e.seedsWithSimilar()).toEqual([]);
  });

  it('いいね → ISRC → 類似録音。hop 1 の好評アーティストは先の類似を用意する', async () => {
    const ext = createFakeExternal();
    const e = createEnrichment({ ...ext, store: new MemoryStore(), now: () => 1, enabled: () => true });
    e.onLiked(fixtureTrack(7));
    e.onLiked(fixtureTrack(7));
    await e.idle();
    expect(e.tracksWithSimilar()).toEqual(['t7']);
    expect(e.similarTracksOf('t7').map((r) => r.name)).toEqual(['Like ISRC7 1', 'Like ISRC7 2', 'Like ISRC7 3']);
    e.markTrackUsed('t7', 'rec:ISRC7:sim1');
    expect(e.similarTracksOf('t7')).toHaveLength(2);
    expect(ext.calls.filter((c) => c.startsWith('lb:simrec'))).toHaveLength(1);

    e.onPositive({ id: 'sim-artista1-1', name: 'Sim artista1 1', weight: 1, hop: 1, mbid: 'mb:sim-artista1-1' });
    await e.idle();
    expect(e.similarOf('sim-artista1-1')).toHaveLength(5);
    expect(e.similarOf('sim-artista1-1')[0]?.name).toBe('Sim sim-artista1-1 1');
  });
});
