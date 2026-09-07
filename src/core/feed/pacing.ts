/** 枠テンプレート(ペーシング)と、未知アーティストの試験・段階配信。純関数、React 非依存。
 *  - TikTok: familiar のブロックの後に数枚ごとに発見を挟む、同じものを続けない
 *  - X 2026: 表示の少ない著者を Thompson sampling で決まった枠(15〜16)に差し込む(cold start)
 *  - Instagram 2024: まず小さな母集団に見せ、成績が良ければ段階的に広げる(ここでは同一アーティスト 1 枚 → 2 → 4 → 無制限)
 *  枠は anchor(なじみ = known)/ exploit(期待値の高い adjacent・discover)/ trial(未知アーティストの試験)/ wildcard(new・hipster のくじ引き) */
import { sampleBeta } from './bandit';
import { shuffle, type Rng } from './rng';
import type { Bucket } from './types';
import { outcomesOf, type ActionCounts } from './valueModel';

export type SlotKind = 'anchor' | 'exploit' | 'trial' | 'wildcard';
export const SLOT_KINDS: readonly SlotKind[] = ['anchor', 'exploit', 'trial', 'wildcard'];

export interface Slot {
  kind: SlotKind;
  bucket: Bucket;
}

export const PACING = {
  /** この枚数ごとに試験枠 1 つ */
  batch: 8,
  trialPerBatch: 1,
  /** バッチごとにこの確率でくじ引き枠 1 つ */
  wildcardChance: 0.5,
  /** くじ引きを混ぜる実効発見度の下限 */
  wildcardMinDiscovery: 0.5,
} as const;

/** 枠の種類ごとの抽選温度(1 = 重み抽選そのまま、→0 で最大重みに寄る) */
export const SLOT_TEMPERATURE: Record<SlotKind, number> = { anchor: 0.4, exploit: 0.6, trial: 0.8, wildcard: 1.0 };

export interface SlotPlanInput {
  count: number;
  /** bucketWeights(実効発見度) */
  weights: Record<Bucket, number>;
  /** クールダウン中(discover を出さない) */
  cooling: boolean;
  /** 試験候補(未知アーティスト)がある */
  hasTrial: boolean;
  /** くじ引き(new / hipster)を混ぜてよい */
  wildcardOk: boolean;
  /** フィードの先頭(最初のカードは anchor で始める) */
  first: boolean;
  /** このバケットだけ(先出し用)。全枠 exploit になる */
  only?: Bucket;
}

const swap = (arr: Slot[], i: number, j: number) => {
  const a = arr[i];
  const b = arr[j];
  if (a === undefined || b === undefined) return;
  arr[i] = b;
  arr[j] = a;
};

export function buildSlots(rng: Rng, input: SlotPlanInput): Slot[] {
  const count = Math.max(0, Math.floor(input.count));
  if (count === 0) return [];
  const only = input.only;
  if (only !== undefined) return Array.from({ length: count }, () => ({ kind: 'exploit', bucket: only }));
  const w = input.weights;
  const total = w.known + w.adjacent + w.discover;
  const share = (v: number) => (total > 0 ? Math.round((count * v) / total) : 0);
  let nKnown = total > 0 ? share(w.known) : count;
  if (w.known > 0 && nKnown === 0) nKnown = 1;
  let nAdj = share(w.adjacent);
  let nDisc = count - nKnown - nAdj;
  if (nDisc < 0) {
    nAdj = Math.max(0, nAdj + nDisc);
    nDisc = count - nKnown - nAdj;
  }
  if (input.cooling && nDisc > 0) {
    nAdj += nDisc;
    nDisc = 0;
  }
  const batches = Math.ceil(count / PACING.batch);
  const trials = input.hasTrial && !input.cooling ? Math.min(nDisc, batches * PACING.trialPerBatch) : 0;
  let wildcards = 0;
  if (input.wildcardOk && !input.cooling) {
    for (let b = 0; b < batches; b++) if (rng() < PACING.wildcardChance) wildcards++;
    wildcards = Math.min(wildcards, nDisc - trials);
  }
  const kinds: Slot[] = [];
  for (let i = 0; i < nKnown; i++) kinds.push({ kind: 'anchor', bucket: 'known' });
  for (let i = 0; i < nAdj; i++) kinds.push({ kind: 'exploit', bucket: 'adjacent' });
  for (let i = 0; i < nDisc - trials - wildcards; i++) kinds.push({ kind: 'exploit', bucket: 'discover' });
  for (let i = 0; i < trials; i++) kinds.push({ kind: 'trial', bucket: 'discover' });
  for (let i = 0; i < wildcards; i++) kinds.push({ kind: 'wildcard', bucket: 'discover' });
  const slots = shuffle(rng, kinds);
  if (input.first) {
    const i = slots.findIndex((s) => s.kind === 'anchor');
    if (i > 0) swap(slots, 0, i);
  }
  if (slots[0]?.kind === 'trial' || slots[0]?.kind === 'wildcard') {
    const i = slots.findIndex((s) => s.kind === 'anchor' || s.kind === 'exploit');
    if (i > 0) swap(slots, 0, i);
  }
  return slots;
}

/** 試験(段階配信)の状態。stage が上がるほど、結果を待たずに同じアーティストを出せる枚数が増える */
export interface TrialState {
  stage: 0 | 1 | 2 | 3;
  /** 結果待ちの枚数(出したが、まだ離脱などの結果が来ていない) */
  shown: number;
  /** 最終更新 epoch ms */
  at: number;
  /** 負の結果で止めている期限 */
  blockedUntil?: number;
}

/** stage ごとの、結果を待たずに出せる枚数(Instagram の段階配信) */
export const TRIAL_CAPS: readonly number[] = [1, 2, 4, Number.POSITIVE_INFINITY];
/** 表示がこれ未満のアーティストを「未知」として試験枠の候補にする */
export const TRIAL_MAX_EXPOSURES = 3;
/** Thompson sampling の事前分布(X は Beta(0.75, 49.25)。ここは完走率の母集団なので楽観寄り) */
export const TRIAL_PRIOR = { a: 1.5, b: 3 } as const;
export const TRIAL_BLOCK_MS = 7 * 24 * 3_600_000;
/** 結果が来ないままこれだけ経ったら、もう 1 枚だけ再試験する */
export const TRIAL_STALE_MS = 60 * 60_000;

const capOf = (stage: number) => TRIAL_CAPS[stage] ?? Number.POSITIVE_INFINITY;

export function trialAllows(t: TrialState | undefined, now: number): boolean {
  if (t === undefined) return true;
  if (t.blockedUntil !== undefined && t.blockedUntil > now) return false;
  if (t.shown < capOf(t.stage)) return true;
  return now - t.at >= TRIAL_STALE_MS;
}

export function onTrialShown(t: TrialState | undefined, now: number): TrialState {
  const cur = t ?? { stage: 0 as const, shown: 0, at: now };
  const reopened = cur.shown >= capOf(cur.stage) && now - cur.at >= TRIAL_STALE_MS;
  return { stage: cur.stage, shown: reopened ? 1 : cur.shown + 1, at: now, ...(cur.blockedUntil !== undefined && cur.blockedUntil > now ? { blockedUntil: cur.blockedUntil } : {}) };
}

/** 結果を反映(出していた 1 枚が消化される): 正(> 0.2)なら次の段階へ、負(< −0.2)なら 7 日止める、中立は枚数だけ空く */
export function onTrialOutcome(t: TrialState | undefined, reward: number, now: number): TrialState {
  const cur = t ?? { stage: 0 as const, shown: 1, at: now };
  const shown = Math.max(0, cur.shown - 1);
  if (reward > 0.2) {
    const stage = Math.min(3, cur.stage + 1) as TrialState['stage'];
    return { stage, shown, at: now };
  }
  if (reward < -0.2) return { stage: cur.stage, shown, at: now, blockedUntil: now + TRIAL_BLOCK_MS };
  return { stage: cur.stage, shown, at: now };
}

/** 試験枠の Thompson 標本 θ ∈ (0, 1) */
export function trialSample(rng: Rng, counts: ActionCounts | undefined, now: number): number {
  const o = outcomesOf(counts, now);
  return sampleBeta(rng, TRIAL_PRIOR.a + o.positive, TRIAL_PRIOR.b + o.negative);
}
