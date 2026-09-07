/** 暗黙・明示のフィードバックを報酬 r ∈ [-1, 1] に変換する純関数。
 *  - 離脱は連続値(TikTok の playtime / Instagram の「最後まで見た」/ X の dwell に相当):
 *    3 秒未満の早期スキップは −1 の崖、3〜15 秒は −0.4 → −0.1、それ以降は完了率(聴いた長さ / 「最後まで」の長さ)で −0.1 → 0.4(80%)→ 0.6(100%)。
 *    「最後まで」= min(自動送りまでの時間, 開始位置から曲末まで)。自動送り(一定時間 or 曲終了)は完走 0.6
 *  - 鳴る前に離れた(playedMs ≤ 0)は、カードに居た時間があれば弱い負(X の not dwelled)、無ければ判定しない(null = 読み込み待ち)
 *  - いいね / プレイリスト / 共有 / もっと は最強、「違う」は −1 */

export type LeaveCause = 'user' | 'auto_advance';

export interface LeaveSignal {
  /** 実際に鳴っていた時間 ms(壁時計。一時停止を含む) */
  playedMs: number;
  durationMs: number;
  cause: LeaveCause;
  /** 自動送りまでの ms。null は曲の終わりまで */
  advanceAfterMs: number | null;
  /** カードに居た時間 ms(意図 → 次の意図)。鳴る前の離脱でも > 0 */
  dwellMs?: number;
  /** 離脱時の再生位置 ms(分かれば。一時停止を含まない完了率に使う) */
  positionMs?: number;
  /** 再生開始位置 ms(サビ開始。既定 0) */
  startMs?: number;
}

export type FeedbackKind = 'leave' | 'return' | 'like' | 'unlike' | 'playlist' | 'open' | 'share' | 'more' | 'less';

export const EARLY_SKIP_MS = 3000;
export const MID_SKIP_MS = 15_000;
/** 完了率がこれ以上なら「ほぼ最後まで」 */
export const NEARLY_FULL_RATIO = 0.8;
/** 長さも自動送りも分からないときに完了率を測る基準 ms */
export const UNBOUNDED_REFERENCE_MS = 60_000;

export const REWARD = {
  earlySkip: -1,
  /** 3 秒時点。ここから 15 秒に向けて midSkipEnd へ連続に上がる */
  midSkip: -0.4,
  /** 15 秒時点 */
  midSkipEnd: -0.1,
  /** 完了率 80% */
  nearlyFull: 0.4,
  /** 完了率 100% / 自動送り */
  completed: 0.6,
  /** 鳴る前に離れたが、カードには居た */
  notDwelled: -0.1,
  return: 0.5,
  like: 1,
  unlike: -0.5,
  playlist: 1,
  open: 0.8,
  share: 1,
  more: 1,
  less: -1,
} as const;

export interface LeaveOutcome {
  reward: number;
  /** 聴いた長さ / 「最後まで」の長さ(0..1) */
  completion: number;
  earlySkip: boolean;
  /** ほぼ最後まで(完了率 ≥ 80%)または自動送り */
  complete: boolean;
  /** 鳴る前に離れた */
  notDwelled: boolean;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp01(t);

/** 離脱の結果。鳴る前に離れて滞在も無ければ null */
export function leaveOutcome(s: LeaveSignal): LeaveOutcome | null {
  if (!(s.playedMs > 0)) {
    if (s.cause === 'user' && (s.dwellMs ?? 0) > 0) return { reward: REWARD.notDwelled, completion: 0, earlySkip: false, complete: false, notDwelled: true };
    return null;
  }
  const start = Math.max(0, s.startMs ?? 0);
  const playable = s.durationMs > 0 ? Math.max(1, s.durationMs - start) : Number.POSITIVE_INFINITY;
  const limit = Math.min(s.advanceAfterMs ?? Number.POSITIVE_INFINITY, playable);
  const reference = Number.isFinite(limit) ? limit : UNBOUNDED_REFERENCE_MS;
  const heard = s.positionMs !== undefined && s.positionMs > start ? s.positionMs - start : s.playedMs;
  const completion = clamp01(heard / reference);
  const base = { earlySkip: false, complete: false, notDwelled: false };
  if (s.cause === 'auto_advance') return { ...base, reward: REWARD.completed, completion: 1, complete: true };
  if (s.playedMs < EARLY_SKIP_MS) return { ...base, reward: REWARD.earlySkip, completion, earlySkip: true };
  if (s.playedMs < MID_SKIP_MS) {
    return { ...base, reward: lerp(REWARD.midSkip, REWARD.midSkipEnd, (s.playedMs - EARLY_SKIP_MS) / (MID_SKIP_MS - EARLY_SKIP_MS)), completion };
  }
  // 15 秒時点の完了率から 80% までを −0.1 → 0.4 に、80% から 100% を 0.4 → 0.6 に写す
  const c15 = Math.min(NEARLY_FULL_RATIO - 0.01, MID_SKIP_MS / reference);
  if (completion < NEARLY_FULL_RATIO) {
    return { ...base, reward: lerp(REWARD.midSkipEnd, REWARD.nearlyFull, (completion - c15) / (NEARLY_FULL_RATIO - c15)), completion };
  }
  return { ...base, reward: lerp(REWARD.nearlyFull, REWARD.completed, (completion - NEARLY_FULL_RATIO) / (1 - NEARLY_FULL_RATIO)), completion, complete: true };
}

/** 離脱の報酬。鳴る前に離れて滞在も無ければ null */
export function leaveReward(s: LeaveSignal): number | null {
  return leaveOutcome(s)?.reward ?? null;
}

export function isEarlySkip(s: LeaveSignal): boolean {
  return s.playedMs > 0 && s.cause === 'user' && s.playedMs < EARLY_SKIP_MS;
}

export function actionReward(kind: Exclude<FeedbackKind, 'leave'>): number {
  return REWARD[kind];
}
