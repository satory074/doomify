/** 種から候補を広げる戦略。各関数のコール数は STRATEGY_COST と一致させる */
import type { SpotifyApi } from '../spotify/endpoints';
import type { Album, AlbumRef, SimplifiedTrack, Track } from '../spotify/types';
import { genreQuery, pickGenre, pickYearRange } from './genres';
import { pickOne, pickWeighted, randomInt, shuffle, type Rng } from './rng';
import { isPlayableTrack, type Candidate, type SeedArtist } from './sources';

export interface ExpandContext {
  api: SpotifyApi;
  rng: Rng;
  currentYear: number;
  /** ユーザーが選んだジャンル + 種から得たジャンル */
  preferredGenres: readonly string[];
  /** アーティストごとの albums total(2 回目以降のランダム offset に使う) */
  albumTotals: Map<string, number>;
  /** 検索クエリごとの total */
  searchTotals: Map<string, number>;
}

export interface ExpandResult {
  candidates: Candidate[];
  /** 新たに見つかった隣接アーティスト */
  newArtists: SeedArtist[];
}

const NO_RESULT: ExpandResult = { candidates: [], newArtists: [] };

export function toTrack(t: SimplifiedTrack, album: AlbumRef): Track {
  const { id, name, uri, images, artists, album_type, release_date, release_date_precision, total_tracks } = album;
  return { ...t, album: { id, name, uri, images, artists, album_type, release_date, release_date_precision, total_tracks } };
}

function albumTracks(album: Album): Track[] {
  return album.tracks.items.map((t) => toTrack(t, album)).filter(isPlayableTrack);
}

function pickArtist(rng: Rng, artists: readonly SeedArtist[], affinity: (id: string) => number): SeedArtist | undefined {
  return pickWeighted(rng, artists, (a) => Math.max(0.05, a.weight * (1 + Math.max(-0.8, affinity(a.id) / 5))));
}

/** アーティストのアルバム/シングルから深掘り(2 コール) */
export async function deepCut(ctx: ExpandContext, artists: readonly SeedArtist[], affinity: (id: string) => number): Promise<ExpandResult> {
  const artist = pickArtist(ctx.rng, artists, affinity);
  if (artist === undefined) return NO_RESULT;
  const known = ctx.albumTotals.get(`${artist.id}:own`);
  const offset = known === undefined ? 0 : randomInt(ctx.rng, 0, Math.max(1, known - 10 + 1));
  const page = await ctx.api.artistAlbums(artist.id, ['album', 'single'], 10, Math.max(0, offset));
  ctx.albumTotals.set(`${artist.id}:own`, page.total);
  const pick = pickWeighted(ctx.rng, page.items, (a) => (a.album_type === 'album' ? 3 : 1));
  if (pick === undefined) return NO_RESULT;
  const album = await ctx.api.album(pick.id);
  const tracks = shuffle(ctx.rng, albumTracks(album)).slice(0, 4);
  return {
    candidates: tracks.map((track) => ({ track, reason: 'deepcut' as const, reasonDetail: artist.name })),
    newArtists: [],
  };
}

/** 参加作品・コンピレーション経由で隣のアーティストへ(2 コール)。related-artists の代替 */
export async function appearsOn(ctx: ExpandContext, artists: readonly SeedArtist[], affinity: (id: string) => number): Promise<ExpandResult> {
  const artist = pickArtist(ctx.rng, artists, affinity);
  if (artist === undefined) return NO_RESULT;
  const known = ctx.albumTotals.get(`${artist.id}:appears`);
  const offset = known === undefined ? 0 : randomInt(ctx.rng, 0, Math.max(1, known - 10 + 1));
  const page = await ctx.api.artistAlbums(artist.id, ['appears_on', 'compilation'], 10, Math.max(0, offset));
  ctx.albumTotals.set(`${artist.id}:appears`, page.total);
  const pick = pickOne(ctx.rng, page.items);
  if (pick === undefined) return NO_RESULT;
  const album = await ctx.api.album(pick.id);
  const others = albumTracks(album).filter((t) => !t.artists.some((a) => a.id === artist.id));
  const tracks = shuffle(ctx.rng, others).slice(0, 5);
  const newArtists = new Map<string, SeedArtist>();
  for (const t of tracks) for (const a of t.artists) if (!newArtists.has(a.id)) newArtists.set(a.id, { id: a.id, name: a.name, weight: 1 });
  return {
    candidates: tracks.map((track) => ({ track, reason: 'appears_on' as const, reasonDetail: artist.name })),
    newArtists: [...newArtists.values()],
  };
}

/** ジャンル × 年代の検索(1 コール) */
export async function genreSearch(ctx: ExpandContext): Promise<ExpandResult> {
  const genre = pickGenre(ctx.rng, ctx.preferredGenres);
  if (genre === undefined) return NO_RESULT;
  const q = genreQuery(genre, pickYearRange(ctx.rng, ctx.currentYear));
  const knownTotal = ctx.searchTotals.get(q);
  const maxOffset = Math.min(1000 - 10, Math.max(0, (knownTotal ?? 200) - 10));
  const offset = randomInt(ctx.rng, 0, maxOffset + 1);
  const res = await ctx.api.search(q, ['track'], { limit: 10, offset });
  const total = res.tracks?.total ?? 0;
  ctx.searchTotals.set(q, total);
  const tracks = (res.tracks?.items ?? []).filter(isPlayableTrack);
  return { candidates: tracks.map((track) => ({ track, reason: 'genre' as const, reasonDetail: genre })), newArtists: [] };
}

async function albumTagSearch(ctx: ExpandContext, tag: 'tag:new' | 'tag:hipster', reason: 'new' | 'hipster', maxOffset: number): Promise<ExpandResult> {
  const knownTotal = ctx.searchTotals.get(tag);
  const bound = Math.min(maxOffset, Math.max(0, (knownTotal ?? maxOffset + 10) - 10));
  const offset = randomInt(ctx.rng, 0, bound + 1);
  const res = await ctx.api.search(tag, ['album'], { limit: 10, offset });
  ctx.searchTotals.set(tag, res.albums?.total ?? 0);
  const pick = pickOne(ctx.rng, res.albums?.items ?? []);
  if (pick === undefined) return NO_RESULT;
  const album = await ctx.api.album(pick.id);
  const tracks = shuffle(ctx.rng, albumTracks(album)).slice(0, 3);
  return { candidates: tracks.map((track) => ({ track, reason })), newArtists: [] };
}

/** 過去 2 週間の新譜(2 コール) */
export const tagNew = (ctx: ExpandContext): Promise<ExpandResult> => albumTagSearch(ctx, 'tag:new', 'new', 100);

/** 人気の低い 10% のアルバム(2 コール) */
export const tagHipster = (ctx: ExpandContext): Promise<ExpandResult> => albumTagSearch(ctx, 'tag:hipster', 'hipster', 300);
