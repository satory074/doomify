import { describe, expect, it } from 'vitest';
import {
  absorbArtists,
  absorbKnownTracks,
  createTasteProfile,
  eraFit,
  eraShare,
  hasEra,
  isKnownArtist,
  normalizeName,
  scoreCandidate,
  tagFit,
} from './taste';
import { fixtureTrack } from './testApi';

function withYear(n: number, year: number, artistId = `a${n}`) {
  const t = fixtureTrack(n, artistId);
  return { ...t, album: { ...t.album, release_date: `${year}-01-01` } };
}

describe('taste profile', () => {
  it('名前の正規化は全角・大小・記号を吸収する', () => {
    expect(normalizeName('ＹＯＡＳＯＢＩ')).toBe('yoasobi');
    expect(normalizeName('King Gnu')).toBe('kinggnu');
    expect(normalizeName('羊文学')).toBe('羊文学');
  });

  it('既知アーティストは ID でも正規化名でも判定できる', () => {
    const p = createTasteProfile();
    absorbArtists(p, [{ id: 'x1', name: 'King Gnu' }]);
    expect(isKnownArtist(p, { artists: [{ id: 'x1', name: '?', uri: '' }] })).toBe(true);
    expect(isKnownArtist(p, { artists: [{ id: 'other', name: 'KING GNU', uri: '' }] })).toBe(true);
    expect(isKnownArtist(p, { artists: [{ id: 'other', name: 'Vaundy', uri: '' }] })).toBe(false);
    expect(isKnownArtist(p, { artists: [] })).toBe(false);
  });

  it('年代の割合と適合', () => {
    const p = createTasteProfile();
    absorbKnownTracks(p, [withYear(1, 2021), withYear(2, 2022), withYear(3, 2023), withYear(4, 1985), withYear(5, 2020), fixtureTrack(6)]);
    expect(hasEra(p)).toBe(true);
    expect(eraShare(p, { from: 2020, to: 2023 })).toBeCloseTo(0.8);
    expect(eraFit(p, withYear(9, 2022))).toBeCloseTo(1);
    expect(eraFit(p, withYear(9, 1970))).toBeCloseTo(0.7);
    expect(eraFit(createTasteProfile(), withYear(9, 1970))).toBe(1);
  });

  it('タグ適合は最良一致を重視し、判定できないときは null', () => {
    const profile = new Map([
      ['j-pop', 1],
      ['city pop', 0.5],
    ]);
    expect(tagFit(['j-pop', 'anime'], profile)).toBeCloseTo(0.7 + 0.3 * 0.5);
    expect(tagFit(['metal'], profile)).toBe(0);
    expect(tagFit(undefined, profile)).toBeNull();
    expect(tagFit(['j-pop'], new Map())).toBeNull();
  });

  it('スコアは類似度・親和度・タグ適合で増え、同一アルバムで減る', () => {
    const base = { candidate: { track: fixtureTrack(1), reason: 'similar' as const }, artistAffinity: 0, seedAffinity: 0, tagFit: null, eraFit: 1, sameAlbumRecently: false };
    const s0 = scoreCandidate(base);
    expect(scoreCandidate({ ...base, candidate: { ...base.candidate, similarity: 1 } })).toBeGreaterThan(s0);
    expect(scoreCandidate({ ...base, artistAffinity: 2 })).toBeGreaterThan(s0);
    expect(scoreCandidate({ ...base, seedAffinity: -3 })).toBeLessThan(s0);
    expect(scoreCandidate({ ...base, tagFit: 1 })).toBeCloseTo(s0);
    expect(scoreCandidate({ ...base, tagFit: 0 })).toBeCloseTo(s0 * 0.5);
    expect(scoreCandidate({ ...base, sameAlbumRecently: true })).toBeCloseTo(s0 * 0.8);
    expect(scoreCandidate({ ...base, artistAffinity: 100 })).toBeLessThan(s0 * 20);
  });
});
