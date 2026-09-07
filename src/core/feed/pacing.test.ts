import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng';
import { bucketWeights } from './scheduler';
import { buildSlots, onTrialOutcome, onTrialShown, TRIAL_BLOCK_MS, TRIAL_CAPS, TRIAL_STALE_MS, trialAllows, trialSample, type SlotKind } from './pacing';

const NOW = 1_700_000_000_000;
const countOf = (slots: { kind: SlotKind }[], kind: SlotKind) => slots.filter((s) => s.kind === kind).length;

describe('buildSlots', () => {
  it('枠数は count、比率は bucketWeights の丸め。発見度 0 は全部 anchor', () => {
    const rng = mulberry32(1);
    const all = buildSlots(rng, { count: 8, weights: bucketWeights(0), cooling: false, hasTrial: true, wildcardOk: false, first: false });
    expect(all).toHaveLength(8);
    expect(countOf(all, 'anchor')).toBe(8);

    const half = buildSlots(rng, { count: 8, weights: bucketWeights(0.5), cooling: false, hasTrial: true, wildcardOk: false, first: false });
    expect(half).toHaveLength(8);
    expect(countOf(half, 'anchor')).toBe(4);
    expect(countOf(half, 'trial')).toBe(1);
    expect(half.filter((s) => s.bucket === 'discover')).toHaveLength(2);

    const max = buildSlots(rng, { count: 8, weights: bucketWeights(1), cooling: false, hasTrial: false, wildcardOk: false, first: false });
    expect(countOf(max, 'anchor')).toBe(2);
    expect(countOf(max, 'trial')).toBe(0);
    expect(max.filter((s) => s.bucket === 'discover').length).toBeGreaterThanOrEqual(4);
  });

  it('先頭は anchor(フィードの最初)、trial と wildcard は先頭に来ない', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rng = mulberry32(seed);
      const first = buildSlots(rng, { count: 8, weights: bucketWeights(0.7), cooling: false, hasTrial: true, wildcardOk: true, first: true });
      expect(first[0]?.kind).toBe('anchor');
      const later = buildSlots(rng, { count: 8, weights: bucketWeights(1), cooling: false, hasTrial: true, wildcardOk: true, first: false });
      expect(later[0]?.kind === 'trial' || later[0]?.kind === 'wildcard').toBe(false);
      expect(countOf(later, 'wildcard')).toBeLessThanOrEqual(1);
      expect(countOf(later, 'trial')).toBe(1);
    }
  });

  it('20 枚なら試験枠は 3 つまで、クールダウン中は discover 枠なし、only は全枠そのバケット', () => {
    const rng = mulberry32(2);
    const big = buildSlots(rng, { count: 20, weights: bucketWeights(1), cooling: false, hasTrial: true, wildcardOk: false, first: false });
    expect(big).toHaveLength(20);
    expect(countOf(big, 'trial')).toBe(3);
    const cooling = buildSlots(rng, { count: 8, weights: bucketWeights(1), cooling: true, hasTrial: true, wildcardOk: true, first: false });
    expect(cooling.every((s) => s.bucket !== 'discover')).toBe(true);
    expect(cooling).toHaveLength(8);
    const only = buildSlots(rng, { count: 2, weights: bucketWeights(0.5), cooling: false, hasTrial: true, wildcardOk: true, first: false, only: 'discover' });
    expect(only).toEqual([
      { kind: 'exploit', bucket: 'discover' },
      { kind: 'exploit', bucket: 'discover' },
    ]);
    expect(buildSlots(rng, { count: 0, weights: bucketWeights(0.5), cooling: false, hasTrial: false, wildcardOk: false, first: false })).toEqual([]);
  });
});

describe('trial(段階配信)', () => {
  it('未知は結果待ち 1 枚まで、正の結果で 2 枚 → 4 枚 → 無制限', () => {
    expect(trialAllows(undefined, NOW)).toBe(true);
    let t = onTrialShown(undefined, NOW);
    expect(t).toEqual({ stage: 0, shown: 1, at: NOW });
    expect(trialAllows(t, NOW)).toBe(false);
    t = onTrialOutcome(t, 0.6, NOW + 1);
    expect(t).toEqual({ stage: 1, shown: 0, at: NOW + 1 });
    t = onTrialShown(t, NOW + 2);
    expect(trialAllows(t, NOW + 2)).toBe(true);
    t = onTrialShown(t, NOW + 3);
    expect(trialAllows(t, NOW + 3)).toBe(false);
    t = onTrialOutcome(t, 1, NOW + 4);
    expect(t.stage).toBe(2);
    expect(t.shown).toBe(1);
    for (let i = 0; i < TRIAL_CAPS[2]! - 1; i++) t = onTrialShown(t, NOW + 5 + i);
    expect(trialAllows(t, NOW + 10)).toBe(false);
    t = onTrialOutcome(t, 0.5, NOW + 11);
    expect(t.stage).toBe(3);
    for (let i = 0; i < 50; i++) t = onTrialShown(t, NOW + 12);
    expect(trialAllows(t, NOW + 12)).toBe(true);
    expect(onTrialOutcome(t, 1, NOW + 13).stage).toBe(3);
  });

  it('負の結果は 7 日止める、中立でも消化した分は空く、1 時間放置で 1 枚だけ再開', () => {
    let t = onTrialShown(undefined, NOW);
    const neutral = onTrialOutcome(t, 0, NOW + 1);
    expect(neutral).toEqual({ stage: 0, shown: 0, at: NOW + 1 });
    expect(trialAllows(neutral, NOW + 1)).toBe(true);
    const blocked = onTrialOutcome(t, -1, NOW);
    expect(trialAllows(blocked, NOW + 1)).toBe(false);
    expect(trialAllows(blocked, NOW + TRIAL_BLOCK_MS)).toBe(true);
    expect(trialAllows(t, NOW + TRIAL_STALE_MS - 1)).toBe(false);
    expect(trialAllows(t, NOW + TRIAL_STALE_MS)).toBe(true);
    t = onTrialShown(t, NOW + TRIAL_STALE_MS);
    expect(t.shown).toBe(1);
    expect(trialAllows(t, NOW + TRIAL_STALE_MS + 1)).toBe(false);
  });

  it('Thompson 標本は正の反応が多いほど大きい', () => {
    const rng = mulberry32(5);
    let good = 0;
    let bad = 0;
    for (let i = 0; i < 200; i++) {
      good += trialSample(rng, { n: 5, k: { complete: 5 }, at: NOW }, NOW);
      bad += trialSample(rng, { n: 5, k: { earlySkip: 5 }, at: NOW }, NOW);
    }
    expect(good / 200).toBeGreaterThan(0.6);
    expect(bad / 200).toBeLessThan(0.25);
    const theta = trialSample(rng, undefined, NOW);
    expect(theta).toBeGreaterThan(0);
    expect(theta).toBeLessThan(1);
  });
});
