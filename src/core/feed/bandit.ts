/** 戦略ごとの Thompson sampling(Beta 分布)。どの発見源がこの人に効くかを学習する。
 *  - 成功(r > 0.2)で a、失敗(r < -0.2)で b を +1。更新のたびに古い観測を減衰させて嗜好の変化に追従
 *  - 乱数は注入(テストの決定性) */
import type { Rng } from './rng';
import type { Strategy } from './scheduler';

export interface BetaStats {
  a: number;
  b: number;
}

export const DECAY = 0.98;
export const SUCCESS_ABOVE = 0.2;
export const FAILURE_BELOW = -0.2;

/** 事前分布。類似アーティストは効く前提、ランダム性の強い tag 系は控えめに */
export const PRIORS: Record<Strategy, BetaStats> = {
  saved_random: { a: 2, b: 2 },
  playlist_random: { a: 2, b: 2 },
  deep_cut: { a: 2, b: 2 },
  appears_on: { a: 2, b: 2 },
  similar_artist: { a: 3, b: 2 },
  bridge: { a: 2, b: 3 },
  similar_track: { a: 3, b: 2 },
  genre_search: { a: 2, b: 2 },
  tag_new: { a: 1, b: 2 },
  tag_hipster: { a: 1, b: 3 },
};

/** 標準正規乱数(Box–Muller) */
function normal(rng: Rng): number {
  const u = 1 - rng();
  const v = 1 - rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1)(Marsaglia–Tsang) */
export function sampleGamma(rng: Rng, shape: number): number {
  if (shape < 1) {
    const u = 1 - rng();
    return sampleGamma(rng, shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 100; i++) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = 1 - rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d;
}

export function sampleBeta(rng: Rng, a: number, b: number): number {
  const x = sampleGamma(rng, Math.max(1e-3, a));
  const y = sampleGamma(rng, Math.max(1e-3, b));
  return x + y <= 0 ? 0.5 : x / (x + y);
}

export function meanOf(stats: BetaStats): number {
  return stats.a / (stats.a + stats.b);
}

/** 報酬で更新した新しい統計を返す(中立の報酬では変えない) */
export function updateStats(stats: BetaStats, reward: number, decay = DECAY): BetaStats {
  if (reward <= SUCCESS_ABOVE && reward >= FAILURE_BELOW) return stats;
  const a = 1 + (stats.a - 1) * decay;
  const b = 1 + (stats.b - 1) * decay;
  return reward > SUCCESS_ABOVE ? { a: a + 1, b } : { a, b: b + 1 };
}

/** 戦略の重み θ をサンプルする */
export function thetaFor(rng: Rng, stats: BetaStats | undefined, prior: BetaStats): number {
  const s = stats ?? prior;
  return sampleBeta(rng, s.a, s.b);
}
