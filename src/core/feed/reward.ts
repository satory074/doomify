/** 暗黙・明示のフィードバックを報酬 r ∈ [-1, 1] に変換する純関数。
 *  - 早期スキップ(3 秒未満で次へ)は強い負、自動送り・曲終了まで聴いたら正、いいね/プレイリスト追加は最強
 *  - playedMs が 0(鳴る前に離れた)は判定しない(null) */

export type LeaveCause = 'user' | 'auto_advance';

export interface LeaveSignal {
  /** 実際に鳴っていた時間 ms */
  playedMs: number;
  durationMs: number;
  cause: LeaveCause;
  /** 自動送りまでの ms。null は曲の終わりまで */
  advanceAfterMs: number | null;
}

export type FeedbackKind = 'leave' | 'return' | 'like' | 'unlike' | 'playlist' | 'open' | 'more' | 'less';

export const EARLY_SKIP_MS = 3000;
export const MID_SKIP_MS = 15_000;

export const REWARD = {
  earlySkip: -1,
  midSkip: -0.4,
  neutral: 0,
  nearlyFull: 0.4,
  completed: 0.6,
  return: 0.5,
  like: 1,
  unlike: -0.5,
  playlist: 1,
  open: 0.8,
  more: 1,
  less: -1,
} as const;

/** 離脱の報酬。鳴る前に離れた(playedMs ≤ 0)なら null */
export function leaveReward(s: LeaveSignal): number | null {
  if (!(s.playedMs > 0)) return null;
  if (s.cause === 'auto_advance') return REWARD.completed;
  if (s.playedMs < EARLY_SKIP_MS) return REWARD.earlySkip;
  if (s.playedMs < MID_SKIP_MS) return REWARD.midSkip;
  const limit = Math.min(s.advanceAfterMs ?? Number.POSITIVE_INFINITY, s.durationMs > 0 ? s.durationMs : Number.POSITIVE_INFINITY);
  if (Number.isFinite(limit) && s.playedMs >= limit * 0.8) return REWARD.nearlyFull;
  return REWARD.neutral;
}

export function isEarlySkip(s: LeaveSignal): boolean {
  return s.playedMs > 0 && s.cause === 'user' && s.playedMs < EARLY_SKIP_MS;
}

export function actionReward(kind: Exclude<FeedbackKind, 'leave'>): number {
  return REWARD[kind];
}
