import { describe, expect, it } from 'vitest';
import { actionReward, EARLY_SKIP_MS, isEarlySkip, leaveOutcome, leaveReward, MID_SKIP_MS, REWARD, type LeaveSignal } from './reward';

const base: LeaveSignal = { playedMs: 0, durationMs: 200_000, cause: 'user', advanceAfterMs: 60_000 };

describe('leaveReward', () => {
  it('鳴る前に離れたら null。カードに居た時間があれば弱い負(not dwelled)', () => {
    expect(leaveReward({ ...base, playedMs: 0 })).toBeNull();
    expect(leaveReward({ ...base, playedMs: -5 })).toBeNull();
    expect(leaveReward({ ...base, playedMs: 0, dwellMs: 800 })).toBe(REWARD.notDwelled);
    expect(leaveOutcome({ ...base, playedMs: 0, dwellMs: 800 })?.notDwelled).toBe(true);
    expect(leaveReward({ ...base, playedMs: 0, dwellMs: 800, cause: 'auto_advance' })).toBeNull();
  });

  it('3 秒未満は −1 の崖、3〜15 秒は −0.4 から −0.1 へ連続', () => {
    expect(leaveReward({ ...base, playedMs: EARLY_SKIP_MS - 1 })).toBe(REWARD.earlySkip);
    expect(leaveOutcome({ ...base, playedMs: EARLY_SKIP_MS - 1 })?.earlySkip).toBe(true);
    expect(leaveReward({ ...base, playedMs: EARLY_SKIP_MS })).toBeCloseTo(REWARD.midSkip);
    expect(leaveReward({ ...base, playedMs: (EARLY_SKIP_MS + MID_SKIP_MS) / 2 })).toBeCloseTo(-0.25);
    expect(leaveReward({ ...base, playedMs: MID_SKIP_MS })).toBeCloseTo(REWARD.midSkipEnd);
    expect(leaveOutcome({ ...base, playedMs: MID_SKIP_MS })?.earlySkip).toBe(false);
  });

  it('15 秒以降は完了率で −0.1 → 0.4(80%)→ 0.6(100%)、自動送りは 0.6', () => {
    expect(leaveReward({ ...base, playedMs: 48_000 })).toBeCloseTo(REWARD.nearlyFull);
    expect(leaveReward({ ...base, playedMs: 60_000 })).toBeCloseTo(REWARD.completed);
    const half = leaveReward({ ...base, playedMs: 30_000 });
    expect(half).toBeGreaterThan(REWARD.midSkipEnd);
    expect(half).toBeLessThan(REWARD.nearlyFull);
    expect(leaveReward({ ...base, playedMs: 48_000, cause: 'auto_advance' })).toBe(REWARD.completed);
    expect(leaveOutcome({ ...base, playedMs: 48_000 })?.complete).toBe(true);
    expect(leaveOutcome({ ...base, playedMs: 30_000 })?.complete).toBe(false);
    expect(leaveOutcome({ ...base, playedMs: 1000, cause: 'auto_advance' })?.complete).toBe(true);
    // 自動送り無し: 曲の長さが「最後まで」
    expect(leaveReward({ ...base, playedMs: 170_000, advanceAfterMs: null })).toBeGreaterThanOrEqual(REWARD.nearlyFull);
    expect(leaveReward({ ...base, playedMs: 100_000, advanceAfterMs: null })).toBeCloseTo(0.193, 2);
  });

  it('positionMs があれば一時停止を含まない完了率、startMs で「最後まで」の長さが縮む', () => {
    // 60 秒設定で 90 秒居たが、再生位置は 20 秒しか進んでいない(一時停止していた)
    const paused = leaveOutcome({ ...base, playedMs: 90_000, positionMs: 20_000 });
    expect(paused?.completion).toBeCloseTo(20_000 / 60_000);
    expect(paused?.reward).toBeLessThan(REWARD.nearlyFull);
    // 200 秒の曲を 60 秒地点から、自動送り無し → 残り 140 秒が「最後まで」
    const hook = leaveOutcome({ ...base, playedMs: 140_000, positionMs: 200_000, startMs: 60_000, advanceAfterMs: null });
    expect(hook?.completion).toBeCloseTo(1);
    expect(hook?.reward).toBeCloseTo(REWARD.completed);
  });

  it('長さ不明・自動送り無しなら 60 秒を基準にする', () => {
    expect(leaveReward({ ...base, playedMs: 500_000, durationMs: 0, advanceAfterMs: null })).toBeCloseTo(REWARD.completed);
    expect(leaveReward({ ...base, playedMs: 30_000, durationMs: 0, advanceAfterMs: null })).toBeLessThan(REWARD.nearlyFull);
  });

  it('playedMs について単調非減少で、[-1, 0.6] に収まる', () => {
    let prev = Number.NEGATIVE_INFINITY;
    for (let ms = 1; ms <= 200_000; ms += 250) {
      const r = leaveReward({ ...base, playedMs: ms });
      if (r === null) throw new Error('unexpected null');
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(r).toBeGreaterThanOrEqual(-1);
      expect(r).toBeLessThanOrEqual(REWARD.completed);
      prev = r;
    }
    expect(prev).toBeCloseTo(REWARD.completed);
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
    expect(actionReward('share')).toBe(1);
    expect(actionReward('open')).toBeCloseTo(0.8);
  });
});
