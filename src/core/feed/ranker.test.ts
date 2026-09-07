import { describe, expect, it } from 'vitest';
import { diversityMultiplier, RANK, sampleScored, scoreCandidates, type FilterReason, type RankContext, type Scored } from './ranker';
import { mulberry32 } from './rng';
import { createSession, observeCard, SESSION_CONFIDENCE_CARDS } from './session';
import type { Candidate } from './sources';
import { fixtureTrack } from './testApi';
import { ACTION_PRIORS, expectedValue, type Prediction } from './valueModel';

const NOW = 1_700_000_000_000;
const cand = (n: number, reason: Candidate['reason'] = 'similar', artistId = `a${n}`, tag = 'j-pop'): Candidate & { tag: string } => ({
  track: fixtureTrack(n, artistId),
  reason,
  reasonDetail: tag,
  tag,
});
const flat: Prediction = { p: ACTION_PRIORS, ev: expectedValue(ACTION_PRIORS), confidence: 0 };
const ctx = (over: Partial<RankContext> = {}): RankContext => ({
  now: NOW,
  recent: [],
  relevance: () => 1,
  predict: () => flat,
  categoriesOf: (c) => (c.reasonDetail === undefined ? [] : [c.reasonDetail]),
  filter: () => null,
  session: createSession(NOW),
  dayCount: () => 0,
  ...over,
});
const scoreOf = (s: Scored[], id: string) => s.find((x) => x.candidate.track.id === id)?.score ?? Number.NaN;

describe('diversityMultiplier', () => {
  it('X 2026 の式: 1, 0.625, 0.4375 → 下限 0.25', () => {
    expect(diversityMultiplier(0)).toBe(1);
    expect(diversityMultiplier(1)).toBeCloseTo(0.625);
    expect(diversityMultiplier(2)).toBeCloseTo(0.4375);
    expect(diversityMultiplier(30)).toBeCloseTo(RANK.diversityFloor);
  });
});

describe('scoreCandidates', () => {
  it('フィルタの理由が数えられ、落ちた候補は出ない', () => {
    const drops: FilterReason[] = [];
    const scored = scoreCandidates([cand(1), cand(2), cand(3)], ctx({ filter: (c) => (c.track.id === 't2' ? 'seen' : c.track.id === 't3' ? 'avoided' : null) }), {
      onDrop: (r) => drops.push(r),
    });
    expect(scored.map((s) => s.candidate.track.id)).toEqual(['t1']);
    expect(drops).toEqual(['seen', 'avoided']);
  });

  it('score = 関連度 × exp(β·EV) × 乗数。discover は ×0.75、同一アーティストの直近出現で減衰', () => {
    const scored = scoreCandidates([cand(1, 'deepcut', 'x1'), cand(2, 'similar', 'x2'), cand(3, 'deepcut', 'a1')], ctx({ recent: [cand(9, 'similar', 'a1')], relevance: () => 2 }));
    const base = 2 * Math.exp(RANK.evBeta * flat.ev);
    expect(scoreOf(scored, 't1')).toBeCloseTo(base);
    expect(scoreOf(scored, 't2')).toBeCloseTo(base * RANK.oonDiscount);
    expect(scoreOf(scored, 't3')).toBeCloseTo(base * diversityMultiplier(1));
    const s1 = scored[0];
    expect(s1?.ev).toBeCloseTo(flat.ev);
    expect(s1?.predictions.complete).toBeCloseTo(ACTION_PRIORS.complete);
    expect(s1?.multipliers.oon).toBe(1);
  });

  it('価値モデルの EV が高いほど score が高く、「違う」の予測は事実上除外', () => {
    const predict = (c: Candidate): Prediction => {
      if (c.track.id === 't1') return { p: { ...ACTION_PRIORS, complete: 0.9 }, ev: 0.6, confidence: 1 };
      if (c.track.id === 't2') return { p: { ...ACTION_PRIORS, less: 0.5 }, ev: -3.5, confidence: 1 };
      return flat;
    };
    const scored = scoreCandidates([cand(1), cand(2), cand(3)], ctx({ predict }));
    expect(scoreOf(scored, 't1')).toBeGreaterThan(scoreOf(scored, 't3'));
    expect(scoreOf(scored, 't2')).toBeLessThan(scoreOf(scored, 't3') * 0.01);
  });

  it('セッションで長く居たタグは boost、同日に見すぎたタグは減点、直近 4 枚同じ主タグなら ×0.5', () => {
    let session = createSession(NOW);
    for (let i = 0; i < SESSION_CONFIDENCE_CARDS; i++) session = observeCard(session, { artistId: 'zz', tags: ['city pop'], dwellMs: 30_000, now: NOW });
    const boosted = scoreCandidates([cand(1, 'similar', 'a1', 'city pop'), cand(2, 'similar', 'a2', 'j-pop')], ctx({ session }));
    expect(scoreOf(boosted, 't1')).toBeGreaterThan(scoreOf(boosted, 't2') * 3);
    expect(boosted[0]?.multipliers.session).toBeGreaterThan(3);

    const tired = scoreCandidates([cand(1, 'similar', 'a1', 'city pop'), cand(2, 'similar', 'a2', 'j-pop')], ctx({ dayCount: (t) => (t === 'city pop' ? 20 : 0) }));
    expect(scoreOf(tired, 't1')).toBeCloseTo(scoreOf(tired, 't2') * 0.4);

    const run = scoreCandidates([cand(1, 'similar', 'a1', 'city pop'), cand(2, 'similar', 'a2', 'j-pop')], ctx({ recent: [5, 6, 7, 8].map((n) => cand(n, 'similar', `b${n}`, 'city pop')) }));
    expect(scoreOf(run, 't1')).toBeCloseTo(scoreOf(run, 't2') * RANK.sameTagRunPenalty);
  });

  it('試験枠は Thompson 標本 × 関連度で、標本が無い候補は出ない', () => {
    const scored = scoreCandidates([cand(1), cand(2)], ctx({ relevance: () => 2, trialSample: (c) => (c.track.id === 't1' ? 0.3 : null) }), { trial: true });
    expect(scored.map((s) => s.candidate.track.id)).toEqual(['t1']);
    expect(scoreOf(scored, 't1')).toBeCloseTo(2 * 0.3 * RANK.oonDiscount);
  });
});

describe('sampleScored', () => {
  const scored = (scores: number[]): Scored[] =>
    scores.map((score, i) => ({ candidate: cand(i), relevance: 1, ev: 0, predictions: ACTION_PRIORS, multipliers: { value: 1, diversity: 1, oon: 1, session: 1, day: 1, tagRun: 1 }, score }));
  const shareOfTop = (temperature: number, seed = 3) => {
    const rng = mulberry32(seed);
    const list = scored([3, 1, 1, 1, 1]);
    let top = 0;
    for (let i = 0; i < 2000; i++) if (sampleScored(rng, list, temperature)?.candidate.track.id === 't0') top++;
    return top / 2000;
  };
  it('温度 1 は重みそのまま、低い温度ほど最大重みに寄るが argmax ではない', () => {
    expect(shareOfTop(1)).toBeCloseTo(3 / 7, 1);
    expect(shareOfTop(0.4)).toBeGreaterThan(0.7);
    expect(shareOfTop(0.4)).toBeLessThan(0.95);
    expect(shareOfTop(0.4)).toBeGreaterThan(shareOfTop(1));
  });
  it('空なら undefined、全部 0 でも 1 つ選ぶ', () => {
    const rng = mulberry32(1);
    expect(sampleScored(rng, [], 1)).toBeUndefined();
    expect(sampleScored(rng, scored([0, 0]), 1)).toBeDefined();
  });
});
