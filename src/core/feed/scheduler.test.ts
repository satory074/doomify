import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng';
import {
  ALL_STRATEGIES,
  bucketWeights,
  dedupeKey,
  normalizeTitle,
  planRefill,
  sameAlbumRecently,
  STRATEGY_BUCKET,
  STRATEGY_COST,
  violatesArtistSpacing,
  type PlanInput,
  type Strategy,
} from './scheduler';

const allAvailable = Object.fromEntries(ALL_STRATEGIES.map((s) => [s, true])) as Record<Strategy, boolean>;

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    discovery: 0.5,
    budget: 6,
    rateLimited: false,
    poolSizes: { known: 0, adjacent: 0, discover: 0 },
    target: 20,
    availability: allAvailable,
    recent: [],
    rng: mulberry32(11),
    ...over,
  };
}

describe('bucketWeights', () => {
  it('合計 1、known は max(0.2, 1-d)', () => {
    for (const d of [0, 0.25, 0.5, 0.8, 1]) {
      const w = bucketWeights(d);
      expect(w.known + w.adjacent + w.discover).toBeCloseTo(1);
      expect(w.known).toBeCloseTo(Math.max(0.2, 1 - d));
    }
    expect(bucketWeights(0).adjacent).toBe(0);
    expect(bucketWeights(1).discover).toBeGreaterThan(bucketWeights(1).adjacent);
  });
});

describe('planRefill', () => {
  it('予算を超えない・同じ戦略を繰り返さない', () => {
    for (let seed = 0; seed < 30; seed++) {
      const plan = planRefill(input({ rng: mulberry32(seed) }));
      const cost = plan.reduce((a, s) => a + STRATEGY_COST[s], 0);
      expect(cost).toBeLessThanOrEqual(6);
      const dupes = plan.filter((s, i) => plan.indexOf(s) !== i);
      expect(dupes.every((s) => s === 'genre_search' || s === 'similar_artist')).toBe(true);
      expect(plan.length).toBeGreaterThan(0);
    }
  });
  it('レート制限中・予算 0 は空(ゼロコール)', () => {
    expect(planRefill(input({ rateLimited: true }))).toEqual([]);
    expect(planRefill(input({ budget: 0 }))).toEqual([]);
  });
  it('発見度 0 なら known の戦略だけ', () => {
    for (let seed = 0; seed < 10; seed++) {
      const plan = planRefill(input({ discovery: 0, rng: mulberry32(seed) }));
      expect(plan.every((s) => s === 'saved_random' || s === 'playlist_random')).toBe(true);
    }
  });
  it('利用不可の戦略は選ばない、プールが十分なバケットは補充しない', () => {
    const plan = planRefill(
      input({
        discovery: 0,
        availability: { ...allAvailable, saved_random: false },
      }),
    );
    expect(plan).toEqual(['playlist_random']);
    expect(planRefill(input({ discovery: 0, poolSizes: { known: 100, adjacent: 0, discover: 0 } }))).toEqual([]);
  });
  it('excludeBuckets のバケットは補充せず、strategyWeight が 0 に近い戦略は選ばれにくい', () => {
    for (let seed = 0; seed < 20; seed++) {
      const plan = planRefill(input({ discovery: 1, excludeBuckets: ['discover'], rng: mulberry32(seed) }));
      expect(plan.every((s) => STRATEGY_BUCKET[s] !== 'discover')).toBe(true);
    }
    let similar = 0;
    for (let seed = 0; seed < 40; seed++) {
      const plan = planRefill(
        input({ discovery: 1, rng: mulberry32(seed), strategyWeight: (s) => (s === 'similar_artist' ? 1 : 0.001) }),
      );
      if (plan.includes('similar_artist')) similar++;
    }
    expect(similar).toBeGreaterThan(35);
  });
});

describe('normalizeTitle / dedupeKey', () => {
  it('feat・Remaster・別版の飾りを落とす', () => {
    expect(normalizeTitle('Song Title (feat. Someone)')).toBe('song title');
    expect(normalizeTitle('Song Title - Remastered 2011')).toBe('song title');
    expect(normalizeTitle('Song Title - Live at Budokan')).toBe('song title');
    expect(normalizeTitle('Song Title [Deluxe Edition]')).toBe('song title');
    expect(normalizeTitle('夜に駆ける')).toBe('夜に駆ける');
  });
  it('主アーティストが違えば別の曲', () => {
    const a = dedupeKey({ name: 'Cover Me', artists: [{ id: 'a1', name: 'A', uri: '' }] });
    const b = dedupeKey({ name: 'Cover Me - Remastered', artists: [{ id: 'a1', name: 'A', uri: '' }] });
    const c = dedupeKey({ name: 'Cover Me', artists: [{ id: 'a2', name: 'B', uri: '' }] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('violatesArtistSpacing', () => {
  it('直近 spacing 枚だけを見る', () => {
    const item = (id: string) => ({ track: { artists: [{ id, name: id, uri: '' }] } });
    const recent = [item('x'), item('a'), item('y'), item('z')];
    const t = { artists: [{ id: 'a', name: 'a', uri: '' }] };
    expect(violatesArtistSpacing(t, recent, 5)).toBe(true);
    expect(violatesArtistSpacing(t, recent, 2)).toBe(false);
    expect(violatesArtistSpacing(t, recent, 0)).toBe(false);
  });
});

describe('sameAlbumRecently', () => {
  it('直近 n 枚だけを見る', () => {
    const item = (id: string) => ({ track: { album: { id } } });
    const recent = [item('x'), item('a'), item('y')];
    expect(sameAlbumRecently({ album: { id: 'a' } }, recent, 3)).toBe(true);
    expect(sameAlbumRecently({ album: { id: 'a' } }, recent, 1)).toBe(false);
    expect(sameAlbumRecently({ album: { id: 'a' } }, recent, 0)).toBe(false);
  });
});
