/** 多目的の価値モデル(X の Heavy Ranker / Phoenix の「行動確率の重み付き和」、Instagram Reels の 4 予測、TikTok Algo 101 の写し)。
 *  候補ごとに「この曲でこの行動をする確率」P(a) を、グローバル → 戦略 → タグ → アーティストの階層で平滑化した計数から推定し、
 *  期待値 EV = Σ w_a × P(a) を返す。重みは確率に掛ける(生の回数には掛けない)。
 *  計数は半減期 14 日で減衰する(比率は保ち、確信だけが縮む = X の feedback-based fatigue)。React 非依存の純 TS */

export const ACTIONS = ['complete', 'like', 'playlist', 'open', 'share', 'return', 'more', 'earlySkip', 'less'] as const;
export type ActionName = (typeof ACTIONS)[number];

export interface ActionCounts {
  /** 表示回数(離脱が来た回数) */
  n: number;
  k: Partial<Record<ActionName, number>>;
  /** 最終更新 epoch ms(減衰の基準) */
  at: number;
}

/** 行動の重み。X の実値(favorite 0.5 / retweet 1.0 / click 0.4 / share 2.0 / not interested −43.2)と
 *  Instagram(sends ≫ likes、watch-through)・TikTok(完走・再視聴・スキップ)を音楽向けに読み替えたもの:
 *  complete ← TikTok 完走 / IG watch-through、like(保存)← X retweet 1.0 / IG save、playlist ← 同、open ← X click 0.4、
 *  share ← X share 2.0 / IG sends、return ← TikTok rewatch、more ← X follow author 4.0 を縮尺、
 *  earlySkip ← TikTok skip / IG skip rate、less ← X not interested(favorite の 86 倍)を小標本向けに 8 倍に */
export const ACTION_WEIGHTS: Record<ActionName, number> = {
  complete: 1.0,
  like: 1.0,
  playlist: 1.0,
  open: 0.4,
  share: 2.0,
  return: 0.6,
  more: 1.5,
  earlySkip: -1.0,
  less: -8.0,
};

/** 観測が無いときの事前確率(グローバル計数の親) */
export const ACTION_PRIORS: Record<ActionName, number> = {
  complete: 0.35,
  like: 0.04,
  playlist: 0.02,
  open: 0.02,
  share: 0.01,
  return: 0.03,
  more: 0.02,
  earlySkip: 0.25,
  less: 0.02,
};

/** 各階層を親へ引き寄せる擬似計数 */
export const SMOOTHING_M = 5;
/** 計数の半減期 */
export const HALF_LIFE_MS = 14 * 24 * 3_600_000;
/** score = relevance × exp(EV_BETA × EV) */
export const EV_BETA = 1.5;

export interface DecayedCounts {
  n: number;
  k: Partial<Record<ActionName, number>>;
}

export interface StatsLookup {
  global(): ActionCounts | undefined;
  strategy(strategy: string): ActionCounts | undefined;
  tag(tag: string): ActionCounts | undefined;
  artist(artistId: string): ActionCounts | undefined;
}

export interface Prediction {
  p: Record<ActionName, number>;
  ev: number;
  /** アーティスト階層の観測の多さ 0..1 */
  confidence: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

/** 最終更新からの経過で減衰させた計数 */
export function decayed(c: ActionCounts | undefined, now: number): DecayedCounts {
  if (c === undefined) return { n: 0, k: {} };
  const age = Math.max(0, now - c.at);
  const scale = age === 0 ? 1 : Math.pow(0.5, age / HALF_LIFE_MS);
  const k: Partial<Record<ActionName, number>> = {};
  for (const a of ACTIONS) {
    const v = c.k[a];
    if (v !== undefined && v > 0) k[a] = v * scale;
  }
  return { n: Math.max(0, c.n) * scale, k };
}

/** 経験ベイズの縮約: (k + m·parent) / (n + m) */
export function smoothed(k: number, n: number, parent: number, m = SMOOTHING_M): number {
  return (k + m * parent) / (Math.max(0, n) + m);
}

export function expectedValue(p: Record<ActionName, number>, weights: Record<ActionName, number> = ACTION_WEIGHTS): number {
  let ev = 0;
  for (const a of ACTIONS) ev += weights[a] * p[a];
  return ev;
}

/** 候補の行動確率と期待値。階層: グローバル → 戦略 → タグ平均 → アーティスト */
export function predict(lookup: StatsLookup, q: { artistId: string; tags: readonly string[]; strategy?: string; now: number }): Prediction {
  const g = decayed(lookup.global(), q.now);
  const s = q.strategy === undefined ? null : decayed(lookup.strategy(q.strategy), q.now);
  const tags = q.tags.map((t) => decayed(lookup.tag(t), q.now));
  const art = decayed(q.artistId === '' ? undefined : lookup.artist(q.artistId), q.now);
  const p = {} as Record<ActionName, number>;
  for (const a of ACTIONS) {
    const pg = smoothed(g.k[a] ?? 0, g.n, ACTION_PRIORS[a]);
    const ps = s === null ? pg : smoothed(s.k[a] ?? 0, s.n, pg);
    const pt = tags.length === 0 ? ps : tags.reduce((sum, t) => sum + smoothed(t.k[a] ?? 0, t.n, ps), 0) / tags.length;
    p[a] = clamp01(smoothed(art.k[a] ?? 0, art.n, pt));
  }
  return { p, ev: expectedValue(p), confidence: art.n / (art.n + SMOOTHING_M) };
}

/** 計数を更新した新しい値を返す。減衰は更新のたびに経過分だけ確定させる */
export function bump(c: ActionCounts | undefined, now: number, patch: { exposure?: boolean; action?: ActionName; delta?: 1 | -1 }): ActionCounts {
  const d = decayed(c, now);
  const k: Partial<Record<ActionName, number>> = { ...d.k };
  if (patch.action !== undefined) {
    const next = (k[patch.action] ?? 0) + (patch.delta ?? 1);
    if (next > 0) k[patch.action] = next;
    else delete k[patch.action];
  }
  return { n: d.n + (patch.exposure === true ? 1 : 0), k, at: now };
}

/** 試験枠(cold start)用: 正の反応と負の反応の数 */
export function outcomesOf(c: ActionCounts | undefined, now: number): { positive: number; negative: number } {
  const d = decayed(c, now);
  const k = d.k;
  return {
    positive: (k.complete ?? 0) + (k.like ?? 0) + (k.playlist ?? 0) + (k.share ?? 0) + (k.more ?? 0),
    negative: (k.earlySkip ?? 0) + (k.less ?? 0),
  };
}
