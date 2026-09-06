import { describe, expect, it } from 'vitest';
import { meanOf, PRIORS, sampleBeta, thetaFor, updateStats } from './bandit';
import { mulberry32 } from './rng';
import { ALL_STRATEGIES } from './scheduler';

describe('bandit', () => {
  it('全戦略に事前分布がある', () => {
    for (const s of ALL_STRATEGIES) expect(PRIORS[s].a).toBeGreaterThan(0);
  });

  it('sampleBeta は (0,1) で、平均が a/(a+b) に近い', () => {
    const rng = mulberry32(5);
    let sum = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const x = sampleBeta(rng, 8, 2);
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(sum / n).toBeCloseTo(0.8, 1);
  });

  it('成功で a、失敗で b が増え、中立では変わらない。減衰で古い観測が薄れる', () => {
    let s = { a: 2, b: 2 };
    s = updateStats(s, 1);
    expect(s).toEqual({ a: 1 + 1 * 0.98 + 1, b: 1 + 1 * 0.98 });
    const before = s;
    expect(updateStats(s, 0)).toBe(before);
    s = updateStats(s, -1);
    expect(s.b).toBeGreaterThan(before.b);
    expect(meanOf({ a: 3, b: 1 })).toBeCloseTo(0.75);
  });

  it('成功を重ねた戦略は θ が高くなる', () => {
    let good = PRIORS.tag_hipster;
    let bad = PRIORS.similar_artist;
    for (let i = 0; i < 30; i++) {
      good = updateStats(good, 1);
      bad = updateStats(bad, -1);
    }
    const rng = mulberry32(9);
    let wins = 0;
    for (let i = 0; i < 200; i++) if (thetaFor(rng, good, PRIORS.tag_hipster) > thetaFor(rng, bad, PRIORS.similar_artist)) wins++;
    expect(wins).toBeGreaterThan(190);
    expect(thetaFor(mulberry32(1), undefined, PRIORS.genre_search)).toBeGreaterThan(0);
  });
});
