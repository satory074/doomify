import { describe, expect, it } from 'vitest';
import { genreQuery, pickGenre, pickWeightedGenre, pickYearRange } from './genres';
import { mulberry32 } from './rng';

describe('genreQuery', () => {
  it('引用符で囲み、年代を付ける', () => {
    expect(genreQuery('city pop', null)).toBe('genre:"city pop"');
    expect(genreQuery('j-pop', { from: 2020, to: 2026 })).toBe('genre:"j-pop" year:2020-2026');
    expect(genreQuery('j-pop', { from: 2026, to: 2026 })).toBe('genre:"j-pop" year:2026');
    expect(genreQuery('we"ird', null)).toBe('genre:"weird"');
  });
});

describe('pickGenre / pickYearRange', () => {
  it('好みがあれば大半はそこから選ぶ', () => {
    const rng = mulberry32(7);
    let preferredHits = 0;
    for (let i = 0; i < 200; i++) if (pickGenre(rng, ['shoegaze']) === 'shoegaze') preferredHits++;
    expect(preferredHits).toBeGreaterThan(120);
    expect(pickGenre(mulberry32(1), [])).toBeDefined();
  });
  it('年代は from ≤ to', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 50; i++) {
      const r = pickYearRange(rng, 2026);
      if (r !== null) expect(r.from).toBeLessThanOrEqual(r.to);
    }
  });
});

describe('pickYearRange(年代の個人化) / pickWeightedGenre', () => {
  it('eraShare が高いレンジが選ばれやすい', () => {
    const rng = mulberry32(11);
    let eighties = 0;
    for (let i = 0; i < 300; i++) {
      const r = pickYearRange(rng, 2026, (range) => (range.from === 1980 ? 1 : 0));
      if (r?.from === 1980) eighties++;
    }
    expect(eighties).toBeGreaterThan(60);
  });
  it('重み付きジャンルは大半が個人化、無ければ語彙から', () => {
    const rng = mulberry32(4);
    let personalized = 0;
    for (let i = 0; i < 200; i++) if (pickWeightedGenre(rng, [{ genre: 'shoegaze', weight: 1 }])?.personalized) personalized++;
    expect(personalized).toBeGreaterThan(120);
    expect(pickWeightedGenre(mulberry32(2), [])?.personalized).toBe(false);
  });
});
