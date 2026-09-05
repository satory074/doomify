import { describe, expect, it } from 'vitest';
import { clampIndex, indexFromScroll, isSettled, offsetForIndex } from './snap';

describe('indexFromScroll', () => {
  it('四捨五入で最寄りのカードを返す', () => {
    expect(indexFromScroll(0, 800, 10)).toBe(0);
    expect(indexFromScroll(399, 800, 10)).toBe(0);
    expect(indexFromScroll(400, 800, 10)).toBe(1);
    expect(indexFromScroll(1600, 800, 10)).toBe(2);
    expect(indexFromScroll(1600 + 320, 800, 10)).toBe(2);
  });
  it('範囲外はクランプ、高さ 0 は 0', () => {
    expect(indexFromScroll(99_999, 800, 10)).toBe(9);
    expect(indexFromScroll(-50, 800, 10)).toBe(0);
    expect(indexFromScroll(500, 0, 10)).toBe(0);
    expect(indexFromScroll(500, 800, 0)).toBe(0);
  });
});

describe('offsetForIndex / clampIndex', () => {
  it('index × 高さ', () => {
    expect(offsetForIndex(3, 800)).toBe(2400);
    expect(offsetForIndex(-1, 800)).toBe(0);
  });
  it('clamp', () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(1, 0)).toBe(0);
  });
});

describe('isSettled', () => {
  it('スナップ点の 2% 以内なら true', () => {
    expect(isSettled(800, 800)).toBe(true);
    expect(isSettled(812, 800)).toBe(true);
    expect(isSettled(830, 800)).toBe(false);
  });
});
