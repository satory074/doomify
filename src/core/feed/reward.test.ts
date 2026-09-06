import { describe, expect, it } from 'vitest';
import { actionReward, EARLY_SKIP_MS, isEarlySkip, leaveReward, MID_SKIP_MS, REWARD, type LeaveSignal } from './reward';

const base: LeaveSignal = { playedMs: 0, durationMs: 200_000, cause: 'user', advanceAfterMs: 60_000 };

describe('leaveReward', () => {
  it('鳴る前に離れたら null', () => {
    expect(leaveReward({ ...base, playedMs: 0 })).toBeNull();
    expect(leaveReward({ ...base, playedMs: -5 })).toBeNull();
  });
  it('早期スキップは -1、途中スキップは -0.4、それ以降は 0', () => {
    expect(leaveReward({ ...base, playedMs: EARLY_SKIP_MS - 1 })).toBe(REWARD.earlySkip);
    expect(leaveReward({ ...base, playedMs: MID_SKIP_MS - 1 })).toBe(REWARD.midSkip);
    expect(leaveReward({ ...base, playedMs: 20_000 })).toBe(REWARD.neutral);
  });
  it('自動送りまでの 8 割以上聴いたら +0.4、自動送り・曲終了は +0.6', () => {
    expect(leaveReward({ ...base, playedMs: 48_000 })).toBe(REWARD.nearlyFull);
    expect(leaveReward({ ...base, playedMs: 48_000, cause: 'auto_advance' })).toBe(REWARD.completed);
    expect(leaveReward({ ...base, playedMs: 170_000, advanceAfterMs: null })).toBe(REWARD.nearlyFull);
    expect(leaveReward({ ...base, playedMs: 100_000, advanceAfterMs: null })).toBe(REWARD.neutral);
  });
  it('長さ不明・自動送り無しなら 15 秒以降は 0', () => {
    expect(leaveReward({ ...base, playedMs: 500_000, durationMs: 0, advanceAfterMs: null })).toBe(REWARD.neutral);
  });
});

describe('isEarlySkip / actionReward', () => {
  it('ユーザー操作で 3 秒未満だけ早期スキップ', () => {
    expect(isEarlySkip({ ...base, playedMs: 1000 })).toBe(true);
    expect(isEarlySkip({ ...base, playedMs: 1000, cause: 'auto_advance' })).toBe(false);
    expect(isEarlySkip({ ...base, playedMs: 0 })).toBe(false);
  });
  it('明示操作の報酬', () => {
    expect(actionReward('like')).toBe(1);
    expect(actionReward('less')).toBe(-1);
    expect(actionReward('open')).toBeCloseTo(0.8);
  });
});
