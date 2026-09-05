import { describe, expect, it } from 'vitest';
import { appearsOn, deepCut, genreSearch, tagNew, type ExpandContext } from './expanders';
import { mulberry32 } from './rng';
import { createFakeApi } from './testApi';

function ctx(): { ctx: ExpandContext; calls: string[] } {
  const { api, calls } = createFakeApi();
  return {
    ctx: { api, rng: mulberry32(2), currentYear: 2026, preferredGenres: ['shoegaze'], albumTotals: new Map(), searchTotals: new Map() },
    calls,
  };
}
const artists = [{ id: 'a1', name: 'Artist a1', weight: 3 }];
const noAffinity = () => 0;

describe('expanders', () => {
  it('deepCut は 2 コールで同じアーティストの曲を最大 4 件返し、total を学習する', async () => {
    const { ctx: c, calls } = ctx();
    const r = await deepCut(c, artists, noAffinity);
    expect(calls).toHaveLength(2);
    expect(r.candidates.length).toBeLessThanOrEqual(4);
    expect(r.candidates.every((x) => x.reason === 'deepcut' && x.reasonDetail === 'Artist a1')).toBe(true);
    expect(r.candidates.every((x) => x.track.artists[0]?.id === 'a1')).toBe(true);
    expect(r.candidates.every((x) => x.track.album.images !== undefined)).toBe(true);
    expect(c.albumTotals.get('a1:own')).toBe(25);
  });

  it('appearsOn は種以外のアーティストの曲と新アーティストを返す', async () => {
    const { ctx: c, calls } = ctx();
    const r = await appearsOn(c, artists, noAffinity);
    expect(calls).toHaveLength(2);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.every((x) => !x.track.artists.some((a) => a.id === 'a1'))).toBe(true);
    expect(r.newArtists.length).toBeGreaterThan(0);
    expect(r.newArtists.every((a) => a.id !== 'a1')).toBe(true);
  });

  it('genreSearch は 1 コールで 10 件、クエリは genre: を含む', async () => {
    const { ctx: c, calls } = ctx();
    const r = await genreSearch(c);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^search:genre:"/);
    expect(r.candidates).toHaveLength(10);
    expect(r.candidates[0]?.reason).toBe('genre');
  });

  it('tagNew は 2 コールで最大 3 件', async () => {
    const { ctx: c, calls } = ctx();
    const r = await tagNew(c);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^search:tag:new:album/);
    expect(r.candidates.length).toBeLessThanOrEqual(3);
    expect(r.candidates[0]?.reason).toBe('new');
  });
});
