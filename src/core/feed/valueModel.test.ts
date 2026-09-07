import { describe, expect, it } from 'vitest';
import { ACTION_PRIORS, ACTION_WEIGHTS, ACTIONS, bump, decayed, expectedValue, HALF_LIFE_MS, outcomesOf, predict, smoothed, type ActionCounts, type StatsLookup } from './valueModel';

const NOW = 1_700_000_000_000;
const counts = (n: number, k: ActionCounts['k'], at = NOW): ActionCounts => ({ n, k, at });
const lookup = (over: Partial<StatsLookup> = {}): StatsLookup => ({
  global: () => undefined,
  strategy: () => undefined,
  tag: () => undefined,
  artist: () => undefined,
  ...over,
});

describe('predict', () => {
  it('観測ゼロなら事前確率、EV は小さな正', () => {
    const pred = predict(lookup(), { artistId: 'a1', tags: ['j-pop'], strategy: 'similar_artist', now: NOW });
    for (const a of ACTIONS) expect(pred.p[a]).toBeCloseTo(ACTION_PRIORS[a]);
    expect(pred.ev).toBeCloseTo(expectedValue(ACTION_PRIORS));
    expect(pred.ev).toBeCloseTo(0.076, 2);
    expect(pred.confidence).toBe(0);
  });

  it('階層の縮約: アーティストの観測が少なければタグ・戦略へ、タグが無ければ戦略へ寄る', () => {
    const strategyOnly = predict(lookup({ strategy: () => counts(10, { complete: 8 }) }), { artistId: 'a1', tags: [], strategy: 's', now: NOW });
    expect(strategyOnly.p.complete).toBeCloseTo((8 + 5 * 0.35) / 15);
    const withArtist = predict(lookup({ strategy: () => counts(10, { complete: 8 }), artist: () => counts(1, { complete: 1 }) }), {
      artistId: 'a1',
      tags: [],
      strategy: 's',
      now: NOW,
    });
    expect(withArtist.p.complete).toBeCloseTo((1 + 5 * strategyOnly.p.complete) / 6);
    expect(withArtist.confidence).toBeCloseTo(1 / 6);
    const tagged = predict(lookup({ tag: (t) => (t === 'city pop' ? counts(4, { complete: 4 }) : undefined) }), { artistId: 'a1', tags: ['city pop', 'pop'], now: NOW });
    const pg = ACTION_PRIORS.complete;
    expect(tagged.p.complete).toBeCloseTo((smoothed(4, 4, pg) + smoothed(0, 0, pg)) / 2);
  });

  it('完走 3/3 のアーティストは EV が大きく、「違う」1/2 は負に振れる', () => {
    const good = predict(lookup({ artist: () => counts(3, { complete: 3 }) }), { artistId: 'a1', tags: [], now: NOW });
    expect(good.p.complete).toBeCloseTo((3 + 5 * 0.35) / 8);
    expect(good.ev).toBeGreaterThan(0.3);
    const bad = predict(lookup({ artist: () => counts(2, { less: 1 }) }), { artistId: 'a1', tags: [], now: NOW });
    expect(bad.p.less).toBeCloseTo((1 + 5 * 0.02) / 7);
    expect(bad.ev).toBeLessThan(-1);
  });

  it('重み表: 共有が最重、「違う」は −8、早期スキップは負', () => {
    expect(ACTION_WEIGHTS.share).toBeGreaterThan(ACTION_WEIGHTS.like);
    expect(ACTION_WEIGHTS.less).toBeLessThanOrEqual(-8);
    expect(ACTION_WEIGHTS.earlySkip).toBeLessThan(0);
    expect(expectedValue({ ...ACTION_PRIORS, share: 1 })).toBeGreaterThan(expectedValue(ACTION_PRIORS) + 1.9);
  });
});

describe('decayed / bump', () => {
  it('半減期で n も k も半分になり、比率は変わらない', () => {
    const c = counts(10, { complete: 5, earlySkip: 2 }, NOW);
    const d = decayed(c, NOW + HALF_LIFE_MS);
    expect(d.n).toBeCloseTo(5);
    expect(d.k.complete).toBeCloseTo(2.5);
    expect(d.k.earlySkip).toBeCloseTo(1);
    expect((d.k.complete ?? 0) / d.n).toBeCloseTo(0.5);
    expect(decayed(undefined, NOW)).toEqual({ n: 0, k: {} });
  });

  it('bump は表示と行動を数え、減衰を確定させ、負の delta は 0 で止まる', () => {
    let c = bump(undefined, NOW, { exposure: true });
    expect(c).toEqual({ n: 1, k: {}, at: NOW });
    c = bump(c, NOW, { action: 'like' });
    expect(c.k.like).toBe(1);
    c = bump(c, NOW, { action: 'like', delta: -1 });
    c = bump(c, NOW, { action: 'like', delta: -1 });
    expect(c.k.like).toBeUndefined();
    c = bump(c, NOW + HALF_LIFE_MS, { exposure: true, action: 'complete' });
    expect(c.n).toBeCloseTo(1.5);
    expect(c.k.complete).toBe(1);
    expect(c.at).toBe(NOW + HALF_LIFE_MS);
  });

  it('outcomesOf は正負の反応をまとめる', () => {
    const o = outcomesOf(counts(5, { complete: 2, like: 1, earlySkip: 1, less: 1 }), NOW);
    expect(o.positive).toBe(3);
    expect(o.negative).toBe(2);
    expect(outcomesOf(undefined, NOW)).toEqual({ positive: 0, negative: 0 });
  });
});
