/** ランキング(X home-mixer の Filters → Scorer → RankingScorer → 選択 の写し)。純関数、React 非依存。
 *  score = 関連度(既存 scoreCandidate)× exp(β·EV)(価値モデル)× 著者減衰 × OON 割引 × セッション興味 × 同日減点 × 同タグ連続の減点
 *  - 著者減衰: X 2026 の (1 − floor) × decay^n + floor(decay 0.5 / floor 0.25、n = 直近での同一アーティストの出現数)
 *  - OON 割引: discover バケット(未フォロー相当)は ×0.75(X の OonWeightFactor)
 *  - 同タグ連続: 直近 4 枚が同じ主タグなら ×0.5(TikTok の「繰り返しを断つ」)
 *  - 硬い制約(既視・重複・避ける・既知・除外タグ・試験上限・アーティスト間隔・くじ引き連続)は名前付きフィルタとして先に落とす
 *  - 選択は温度付きの重み抽選(可変報酬。argmax にはしない) */
import type { Track } from '../spotify/types';
import { pickWeighted, type Rng } from './rng';
import { dayPenalty, sessionBoost, type SessionState } from './session';
import type { Candidate } from './sources';
import { BUCKET_OF, type FeedReason } from './types';
import { EV_BETA, type ActionName, type Prediction } from './valueModel';

export type FilterReason = 'seen' | 'duplicate' | 'avoided' | 'known_artist' | 'excluded_tag' | 'trial_cap' | 'artist_spacing' | 'wildcard_adjacent';
export const FILTER_REASONS: readonly FilterReason[] = ['seen', 'duplicate', 'avoided', 'known_artist', 'excluded_tag', 'trial_cap', 'artist_spacing', 'wildcard_adjacent'];

export const RANK = {
  evBeta: EV_BETA,
  diversityDecay: 0.5,
  diversityFloor: 0.25,
  /** 著者減衰・同タグ連続を見る直近の枚数 */
  diversityWindow: 20,
  oonDiscount: 0.75,
  sameTagRun: 4,
  sameTagRunPenalty: 0.5,
  /** 同日減点に使うタグ数 */
  dayTags: 3,
} as const;

/** 候補と items に共通する、カテゴリ判定に必要な形 */
export type Categorizable = Pick<Candidate, 'track' | 'reason' | 'reasonDetail'>;

export interface RankContext {
  now: number;
  /** 直近の items(+ このバッチで選んだ分)。多様性と同タグ連続の判定に使う */
  recent: readonly Categorizable[];
  relevance(c: Candidate): number;
  predict(c: Candidate): Prediction;
  /** タグ・ジャンル・くじ引き種別など(主タグが先頭) */
  categoriesOf(c: Categorizable): readonly string[];
  /** 通せない理由(null なら通す) */
  filter(c: Candidate): FilterReason | null;
  session: SessionState;
  dayCount(tag: string): number;
  /** 試験枠のときの Thompson 標本。null はその候補が試験対象外 */
  trialSample?: (c: Candidate) => number | null;
}

export interface Scored {
  candidate: Candidate;
  relevance: number;
  ev: number;
  predictions: Record<ActionName, number>;
  multipliers: { value: number; diversity: number; oon: number; session: number; day: number; tagRun: number };
  score: number;
}

/** (1 − floor) × decay^n + floor */
export function diversityMultiplier(n: number, decay: number = RANK.diversityDecay, floor: number = RANK.diversityFloor): number {
  return (1 - floor) * Math.pow(decay, Math.max(0, n)) + floor;
}

export function isOutOfNetwork(reason: FeedReason): boolean {
  return BUCKET_OF[reason] === 'discover';
}

export function scoreCandidates(cands: readonly Candidate[], ctx: RankContext, opts: { trial?: boolean; onDrop?: (reason: FilterReason, candidate: Candidate) => void } = {}): Scored[] {
  const window = ctx.recent.slice(-RANK.diversityWindow);
  const artistCounts = new Map<string, number>();
  for (const r of window) {
    const id = r.track.artists[0]?.id;
    if (id !== undefined) artistCounts.set(id, (artistCounts.get(id) ?? 0) + 1);
  }
  const lastTags = ctx.recent.slice(-RANK.sameTagRun).map((r) => ctx.categoriesOf(r)[0]);
  const head = lastTags[0];
  const runTag = head !== undefined && lastTags.length >= RANK.sameTagRun && lastTags.every((t) => t === head) ? head : undefined;
  const out: Scored[] = [];
  for (const c of cands) {
    const reason = ctx.filter(c);
    if (reason !== null) {
      opts.onDrop?.(reason, c);
      continue;
    }
    let value: number;
    const pred = ctx.predict(c);
    if (opts.trial === true) {
      const theta = ctx.trialSample?.(c) ?? null;
      if (theta === null) continue;
      value = theta;
    } else {
      value = Math.exp(RANK.evBeta * pred.ev);
    }
    const primary = c.track.artists[0]?.id ?? '';
    const categories = ctx.categoriesOf(c);
    const relevance = Math.max(0, ctx.relevance(c));
    const diversity = diversityMultiplier(artistCounts.get(primary) ?? 0);
    const oon = isOutOfNetwork(c.reason) ? RANK.oonDiscount : 1;
    const session = sessionBoost(ctx.session, primary, categories);
    const top = categories.slice(0, RANK.dayTags);
    const day = top.length === 0 ? 1 : top.reduce((s, t) => s + dayPenalty(ctx.dayCount(t)), 0) / top.length;
    const tagRun = runTag !== undefined && categories[0] === runTag ? RANK.sameTagRunPenalty : 1;
    out.push({
      candidate: c,
      relevance,
      ev: pred.ev,
      predictions: pred.p,
      multipliers: { value, diversity, oon, session, day, tagRun },
      score: relevance * value * diversity * oon * session * day * tagRun,
    });
  }
  return out;
}

/** 温度付きの重み抽選。temperature 1 で重みそのまま、小さいほど最大重みに寄る */
export function sampleScored(rng: Rng, scored: readonly Scored[], temperature: number): Scored | undefined {
  const t = Math.max(0.05, Number.isFinite(temperature) ? temperature : 1);
  let max = 0;
  for (const s of scored) max = Math.max(max, s.score);
  if (max <= 0) return pickWeighted(rng, scored, () => 1);
  // 最大値で正規化してから累乗(オーバーフロー・アンダーフローを避ける)
  return pickWeighted(rng, scored, (s) => Math.pow(Math.max(s.score / max, 1e-9), 1 / t));
}

export type { Track };
