import { describe, expect, it } from 'vitest';
import { clampIndex, indexFromScroll, isSettled, offsetForIndex, parseCardIndex } from './snap';

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

describe('parseCardIndex', () => {
  it('0 以上の整数文字列で count 未満のときだけ index を返す', () => {
    expect(parseCardIndex('3', 10)).toBe(3);
    expect(parseCardIndex('0', 10)).toBe(0);
    expect(parseCardIndex('9', 10)).toBe(9);
  });
  it('未定義・非数・小数・負数・範囲外・count 0 は null', () => {
    expect(parseCardIndex(undefined, 10)).toBeNull();
    expect(parseCardIndex('x', 10)).toBeNull();
    expect(parseCardIndex('1.5', 10)).toBeNull();
    expect(parseCardIndex('-1', 10)).toBeNull();
    expect(parseCardIndex('10', 10)).toBeNull();
    expect(parseCardIndex('0', 0)).toBeNull();
  });
});
