/** 探索量の適応。設定スライダーを錨に、直近の探索カード(adjacent/discover)の手応え EMA で ±MAX_SHIFT だけ動かす。
 *  早期スキップが続いたら一時的に発見バケットを止める(クールダウン)。純関数 */
import type { Bucket } from './types';

export interface ExplorationState {
  /** 探索カードの報酬の指数移動平均 */
  ema: number;
  /** 発見カードの早期スキップ連続回数 */
  earlySkipStreak: number;
  /** 残りクールダウン枚数(> 0 の間は discover を出さない) */
  cooldownLeft: number;
}

export const INITIAL_EXPLORATION: ExplorationState = { ema: 0, earlySkipStreak: 0, cooldownLeft: 0 };
export const EMA_ALPHA = 0.2;
export const DRIFT = 0.3;
export const MAX_SHIFT = 0.15;
export const MIN_DISCOVERY = 0.05;
export const COOLDOWN_AFTER = 4;
export const COOLDOWN_CARDS = 6;

export function isExploratory(bucket: Bucket): boolean {
  return bucket !== 'known';
}

/** 探索カードへのフィードバックを取り込む。known のカードは無視 */
export function observeExploration(state: ExplorationState, bucket: Bucket, reward: number, earlySkip: boolean): ExplorationState {
  if (!isExploratory(bucket)) return state;
  const ema = state.ema + EMA_ALPHA * (reward - state.ema);
  let streak = earlySkip ? state.earlySkipStreak + 1 : 0;
  let cooldownLeft = state.cooldownLeft;
  if (streak >= COOLDOWN_AFTER) {
    cooldownLeft = COOLDOWN_CARDS;
    streak = 0;
  }
  return { ema, earlySkipStreak: streak, cooldownLeft };
}

/** カードを 1 枚出すたびに呼ぶ(クールダウンの消費) */
export function consumeCooldown(state: ExplorationState, cards = 1): ExplorationState {
  if (state.cooldownLeft <= 0) return state;
  return { ...state, cooldownLeft: Math.max(0, state.cooldownLeft - cards) };
}

export function effectiveDiscovery(slider: number, state: ExplorationState): number {
  const s = Math.min(1, Math.max(0, Number.isFinite(slider) ? slider : 0));
  if (s <= 0) return 0;
  const shifted = s + DRIFT * state.ema;
  const clamped = Math.min(s + MAX_SHIFT, Math.max(s - MAX_SHIFT, shifted));
  return Math.min(1, Math.max(MIN_DISCOVERY, clamped));
}
