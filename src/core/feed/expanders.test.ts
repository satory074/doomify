import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../spotify/cache';
import { createEnrichment, type Enrichment } from './enrichment';
import { appearsOn, deepCut, escapeQuery, genreSearch, similarArtist, similarTrack, tagNew, type ExpandContext } from './expanders';
import { createHistory, type History } from './history';
import { mulberry32 } from './rng';
import { absorbArtists, createTasteProfile, type TasteProfile } from './taste';
import { createFakeApi, createFakeExternal, fixtureTrack } from './testApi';

const NOW = 1_700_000_000_000;

function ctx(
  over: { enrichment?: Enrichment | null; history?: History; taste?: TasteProfile; genres?: { genre: string; weight: number; source?: 'tag' | 'chip' }[] } = {},
): { ctx: ExpandContext; calls: string[]; history: History } {
  const { api, calls } = createFakeApi();
  const history = over.history ?? createHistory(new MemoryStore());
  return {
    ctx: {
      api,
      rng: mulberry32(2),
      currentYear: 2026,
      now: () => NOW,
      weightedGenres: () => over.genres ?? [{ genre: 'shoegaze', weight: 1, source: 'chip' }],
      taste: over.taste ?? createTasteProfile(),
      enrichment: over.enrichment ?? null,
      history,
      albumTotals: new Map(),
      searchTotals: new Map(),
    },
    calls,
    history,
  };
}
const artists = [{ id: 'a1', name: 'Artist a1', weight: 3 }];
const noAffinity = () => 0;

async function enriched(seeds = artists): Promise<Enrichment> {
  const ext = createFakeExternal();
  const e = createEnrichment({ ...ext, store: new MemoryStore(), now: () => NOW, enabled: () => true });
  e.onSeeds(seeds);
  await e.idle();
  return e;
}

describe('expanders', () => {
  it('deepCut は 2 コールで同じアーティストの曲を最大 4 件返し、total を学習する', async () => {
    const { ctx: c, calls } = ctx();
    const r = await deepCut(c, artists, noAffinity);
    expect(calls).toHaveLength(2);
    expect(r.candidates.length).toBeLessThanOrEqual(4);
    expect(r.candidates.every((x) => x.reason === 'deepcut' && x.reasonDetail === 'Artist a1' && x.strategy === 'deep_cut')).toBe(true);
    expect(r.candidates.every((x) => x.track.artists[0]?.id === 'a1')).toBe(true);
    expect(r.candidates.every((x) => x.track.album.images !== undefined)).toBe(true);
    expect(c.albumTotals.get('a1:own')).toBe(25);
  });

  it('appearsOn は種以外のアーティストの曲と hop 1 の新アーティストを返し、既知・避けるアーティストは落とす', async () => {
    const { ctx: c, calls } = ctx();
    const r = await appearsOn(c, artists, noAffinity);
    expect(calls).toHaveLength(2);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.every((x) => !x.track.artists.some((a) => a.id === 'a1'))).toBe(true);
    expect(r.candidates.every((x) => x.seed?.id === 'a1' && x.hop === 1)).toBe(true);
    expect(r.newArtists.length).toBeGreaterThan(0);
    expect(r.newArtists.every((a) => a.id !== 'a1' && a.hop === 1 && a.from?.id === 'a1')).toBe(true);

    const taste = createTasteProfile();
    absorbArtists(taste, r.candidates.map((x) => x.track.artists[0]).filter((a): a is NonNullable<typeof a> => a !== undefined));
    const { ctx: c2 } = ctx({ taste });
    const r2 = await appearsOn(c2, artists, noAffinity);
    expect(r2.candidates.every((x) => !taste.knownArtistIds.has(x.track.artists[0]?.id ?? ''))).toBe(true);
  });

  it('genreSearch は 1 コールで、タグ由来なら reason=tag、チップ由来なら genre。空振りしたジャンルは避ける', async () => {
    const { ctx: c, calls } = ctx({ genres: [{ genre: 'shoegaze', weight: 1, source: 'tag' }] });
    const r = await genreSearch(c);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^search:genre:"/);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0]?.reason === 'tag' || r.candidates[0]?.reason === 'genre').toBe(true);
    expect(r.candidates[0]?.strategy).toBe('genre_search');

    const { ctx: c2, history } = ctx({ genres: [{ genre: 'nothing', weight: 1, source: 'tag' }] });
    let dead = false;
    for (let i = 0; i < 20 && !dead; i++) {
      await genreSearch(c2);
      dead = history.isDeadTag('nothing', NOW);
    }
    expect(dead).toBe(true);
  });

  it('tagNew は 2 コールで最大 3 件', async () => {
    const { ctx: c, calls } = ctx();
    const r = await tagNew(c);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^search:tag:new:album/);
    expect(r.candidates.length).toBeLessThanOrEqual(3);
    expect(r.candidates[0]?.reason).toBe('new');
    expect(r.candidates[0]?.strategy).toBe('tag_new');
  });

  it('similarArtist は 1 コールで類似アーティスト本人の曲を最大 4 件(1 アルバム 2 曲まで)返し、hop 1 のアーティストを追加する', async () => {
    const e = await enriched();
    const { ctx: c, calls } = ctx({ enrichment: e });
    const r = await similarArtist(c, artists, 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^search:artist:"Sim artista1 \d"/);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.length).toBeLessThanOrEqual(4);
    const names = new Set(r.candidates.map((x) => x.track.artists[0]?.name));
    expect(names.size).toBe(1);
    expect(r.candidates.every((x) => x.reason === 'similar' && x.reasonDetail === 'Artist a1' && x.seed?.id === 'a1' && x.hop === 1 && x.strategy === 'similar_artist')).toBe(true);
    expect(r.candidates.every((x) => (x.similarity ?? 0) > 0)).toBe(true);
    const perAlbum = new Map<string, number>();
    for (const x of r.candidates) perAlbum.set(x.track.album.id, (perAlbum.get(x.track.album.id) ?? 0) + 1);
    expect([...perAlbum.values()].every((n) => n <= 2)).toBe(true);
    expect(r.newArtists).toHaveLength(1);
    expect(r.newArtists[0]?.hop).toBe(1);
    expect(r.newArtists[0]?.from?.id).toBe('a1');
    expect(r.newArtists[0]?.mbid).toMatch(/^mb:sim-artista1-/);
    expect(e.similarOf('a1')).toHaveLength(4);
  });

  it('similarArtist は既知の名前を飛ばし、種が無ければゼロコール', async () => {
    const e = await enriched();
    const taste = createTasteProfile();
    for (let i = 1; i <= 5; i++) absorbArtists(taste, [{ id: `k${i}`, name: `Sim artista1 ${i}` }]);
    const { ctx: c, calls } = ctx({ enrichment: e, taste });
    expect(await similarArtist(c, artists, 1)).toEqual({ candidates: [], newArtists: [] });
    expect(calls).toHaveLength(0);
    const { ctx: c2 } = ctx({ enrichment: null });
    expect(await similarArtist(c2, artists, 1)).toEqual({ candidates: [], newArtists: [] });
  });

  it('bridge(hop 2)は hop 1 のアーティストを種にし、ラベルに経路を入れる', async () => {
    const e = await enriched();
    const hop1 = { id: 'sim-artista1-1', name: 'Sim artista1 1', weight: 1, hop: 1, mbid: 'mb:sim-artista1-1', from: { id: 'a1', name: 'Artist a1' } };
    e.onPositive(hop1);
    await e.idle();
    const { ctx: c, calls } = ctx({ enrichment: e });
    const r = await similarArtist(c, [...artists, hop1], 2);
    expect(calls).toHaveLength(1);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0]?.reason).toBe('bridge');
    expect(r.candidates[0]?.reasonDetail).toBe('Artist a1 → Sim artista1 1');
    expect(r.candidates[0]?.hop).toBe(2);
    expect(r.newArtists[0]?.hop).toBe(2);
  });

  it('similarTrack はいいねした曲の類似録音を本人確認して最大 2 曲(2 コール)', async () => {
    const ext = createFakeExternal();
    const e = createEnrichment({ ...ext, store: new MemoryStore(), now: () => NOW, enabled: () => true });
    e.onLiked(fixtureTrack(7));
    await e.idle();
    const { ctx: c, calls } = ctx({ enrichment: e });
    const r = await similarTrack(c);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^search:track:"Like ISRC7 1" artist:"Rec Artist 1"/);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]?.reason).toBe('similar_track');
    expect(r.candidates[0]?.reasonDetail).toBe('Track 7');
    expect(r.candidates[0]?.track.name).toBe('Like ISRC7 1');
    expect(r.newArtists).toHaveLength(2);
    expect(e.similarTracksOf('t7')).toHaveLength(1);
  });

  it('escapeQuery は引用符を落とす', () => {
    expect(escapeQuery('a "b" \\c  d')).toBe('a b c d');
  });
});
