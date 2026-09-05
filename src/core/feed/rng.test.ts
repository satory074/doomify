import { describe, expect, it } from 'vitest';
import { mulberry32, pickWeighted, randomInt, shuffle } from './rng';

describe('mulberry32', () => {
  it('同じシードなら同じ列、[0,1) に収まる', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('randomInt', () => {
  it('範囲内の整数', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 200; i++) {
      const v = randomInt(rng, 3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(7);
      expect(Number.isInteger(v)).toBe(true);
    }
    expect(randomInt(rng, 5, 5)).toBe(5);
  });
});

describe('pickWeighted', () => {
  it('重み 0 の要素は選ばれない、全て 0 なら undefined', () => {
    const rng = mulberry32(3);
    const items = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i++) {
      expect(pickWeighted(rng, items, (x) => (x === 'b' ? 0 : 1))).not.toBe('b');
    }
    expect(pickWeighted(rng, items, () => 0)).toBeUndefined();
  });
});

describe('shuffle', () => {
  it('要素を保ち、元配列を壊さない', () => {
    const src = [1, 2, 3, 4, 5];
    const out = shuffle(mulberry32(9), src);
    expect(out.slice().sort()).toEqual(src);
    expect(src).toEqual([1, 2, 3, 4, 5]);
  });
});
