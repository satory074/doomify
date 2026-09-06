import { describe, expect, it } from 'vitest';
import {
  COOLDOWN_AFTER,
  COOLDOWN_CARDS,
  consumeCooldown,
  effectiveDiscovery,
  INITIAL_EXPLORATION,
  MAX_SHIFT,
  observeExploration,
} from './exploration';

describe('exploration', () => {
  it('known のカードは EMA に影響しない', () => {
    expect(observeExploration(INITIAL_EXPLORATION, 'known', -1, true)).toBe(INITIAL_EXPLORATION);
  });

  it('報酬の EMA が動き、実効発見度はスライダー ±0.15 に収まる', () => {
    let s = INITIAL_EXPLORATION;
    for (let i = 0; i < 20; i++) s = observeExploration(s, 'discover', 1, false);
    expect(s.ema).toBeGreaterThan(0.9);
    expect(effectiveDiscovery(0.5, s)).toBeCloseTo(0.5 + MAX_SHIFT);
    for (let i = 0; i < 40; i++) s = observeExploration(s, 'adjacent', -1, false);
    expect(effectiveDiscovery(0.5, s)).toBeCloseTo(0.5 - MAX_SHIFT);
    expect(effectiveDiscovery(0, s)).toBe(0);
    expect(effectiveDiscovery(0.1, s)).toBeGreaterThanOrEqual(0.05);
    expect(effectiveDiscovery(1, { ema: 1, earlySkipStreak: 0, cooldownLeft: 0 })).toBe(1);
  });

  it('早期スキップが 4 連続でクールダウンに入り、カードを出すと消費される', () => {
    let s = INITIAL_EXPLORATION;
    for (let i = 0; i < COOLDOWN_AFTER - 1; i++) s = observeExploration(s, 'discover', -1, true);
    expect(s.cooldownLeft).toBe(0);
    s = observeExploration(s, 'discover', 0, false);
    expect(s.earlySkipStreak).toBe(0);
    for (let i = 0; i < COOLDOWN_AFTER; i++) s = observeExploration(s, 'discover', -1, true);
    expect(s.cooldownLeft).toBe(COOLDOWN_CARDS);
    expect(s.earlySkipStreak).toBe(0);
    s = consumeCooldown(s, 2);
    expect(s.cooldownLeft).toBe(COOLDOWN_CARDS - 2);
    s = consumeCooldown(s, 100);
    expect(s.cooldownLeft).toBe(0);
  });
});
