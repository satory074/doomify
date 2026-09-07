/** 種から候補を広げる戦略。各関数の Spotify コール数は STRATEGY_COST と一致させる(外部 API は数えない)。
 *  発見系(appears_on / similar / bridge / similar_track / genre / tag)は、既知アーティスト・避けるアーティストの曲を落とす */
import type { SpotifyApi } from '../spotify/endpoints';
import type { Album, AlbumRef, SimplifiedTrack, Track } from '../spotify/types';
import type { Enrichment } from './enrichment';
import { DEFAULT_GENRES, genreQuery, pickWeightedGenre, pickYearRange, type WeightedGenre } from './genres';
import type { History } from './history';
import { pickOne, pickWeighted, randomInt, shuffle, type Rng } from './rng';
import { normalizeTitle } from './scheduler';
import { isPlayableTrack, type Candidate, type SeedArtist } from './sources';
import { eraShare as eraShareOf, hasEra, isKnownArtist, isKnownArtistName, normalizeName, type TasteProfile } from './taste';
import type { SeedRef } from './types';

export interface ExpandContext {
  api: SpotifyApi;
  rng: Rng;
  currentYear: number;
  now: () => number;
  /** 個人化されたジャンル(タグ重み + 設定のチップ)。空なら語彙全体から */
  weightedGenres: () => readonly WeightedGenre[];
  taste: TasteProfile;
  enrichment: Enrichment | null;
  history: Pick<History, 'affinity' | 'seedAffinity' | 'isAvoided' | 'isDeadTag' | 'markDeadTag'>;
  /** アーティストごとの albums total(2 回目以降のランダム offset に使う) */
  albumTotals: Map<string, number>;
  /** 検索クエリごとの total */
  searchTotals: Map<string, number>;
  /** タグ集合への好み(セッション興味 × 価値モデル)。候補を取りに行く段階でも個人化する(Phoenix の検索側に相当)。無ければ 1 */
  tagBoost?: (tags: readonly string[]) => number;
}

export interface ExpandResult {
  candidates: Candidate[];
  /** 新たに見つかった隣接アーティスト */
  newArtists: SeedArtist[];
}

const NO_RESULT: ExpandResult = { candidates: [], newArtists: [] };
const DEAD_TAG_MS = 7 * 24 * 60 * 60 * 1000;
/** 類似アーティストの抽選: 順位が下がるほど exp で薄くする */
const SIMILAR_RANK_SCALE = 6;
const SIMILAR_TOP_N = 20;

export function toTrack(t: SimplifiedTrack, album: AlbumRef): Track {
  const { id, name, uri, images, artists, album_type, release_date, release_date_precision, total_tracks } = album;
  return { ...t, album: { id, name, uri, images, artists, album_type, release_date, release_date_precision, total_tracks } };
}

function albumTracks(album: Album): Track[] {
  return album.tracks.items.map((t) => toTrack(t, album)).filter(isPlayableTrack);
}

/** 検索の q に入れる文字列(引用符・バックスラッシュを落とす) */
export function escapeQuery(s: string): string {
  return s.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 発見用のフィルタ: 既知アーティスト・避けるアーティストの曲を落とす */
export function freshOnly(ctx: ExpandContext, tracks: readonly Track[]): Track[] {
  const now = ctx.now();
  return tracks.filter((t) => !isKnownArtist(ctx.taste, t) && !t.artists.some((a) => ctx.history.isAvoided(a.id, now)));
}

function pickArtist(rng: Rng, artists: readonly SeedArtist[], affinity: (id: string) => number): SeedArtist | undefined {
  return pickWeighted(rng, artists, (a) => Math.max(0.05, a.weight * (1 + Math.max(-0.8, affinity(a.id) / 5))));
}

/** アーティストのアルバム/シングルから深掘り(2 コール)。既知アーティストの曲なので adjacent */
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
    candidates: tracks.map((track) => ({ track, reason: 'deepcut' as const, reasonDetail: artist.name, strategy: 'deep_cut' as const })),
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
  const others = freshOnly(
    ctx,
    albumTracks(album).filter((t) => !t.artists.some((a) => a.id === artist.id)),
  );
  const tracks = shuffle(ctx.rng, others).slice(0, 5);
  const seed: SeedRef = { id: artist.id, name: artist.name };
  const newArtists = new Map<string, SeedArtist>();
  for (const t of tracks) for (const a of t.artists) if (!newArtists.has(a.id)) newArtists.set(a.id, { id: a.id, name: a.name, weight: 1, hop: 1, from: seed });
  return {
    candidates: tracks.map((track) => ({ track, reason: 'appears_on' as const, reasonDetail: artist.name, seed, hop: 1, strategy: 'appears_on' as const })),
    newArtists: [...newArtists.values()],
  };
}

/** ListenBrainz の類似アーティストから未知のアーティストを 1 人選び、その曲を検索する(1 コール)。
 *  hop 1: 既知の種から。hop 2(bridge): hop 1 のアーティストを種にして更に先へ */
export async function similarArtist(ctx: ExpandContext, artists: readonly SeedArtist[], hop: 1 | 2): Promise<ExpandResult> {
  const enrichment = ctx.enrichment;
  if (enrichment === null) return NO_RESULT;
  const seedHop = hop - 1;
  const withSimilar = new Set(enrichment.seedsWithSimilar());
  const pool = artists.filter((a) => (a.hop ?? 0) === seedHop && withSimilar.has(a.id));
  const seed = pickWeighted(ctx.rng, pool, (a) =>
    Math.max(0.05, a.weight * Math.exp(0.3 * ctx.history.seedAffinity(a.id)) * (1 + Math.max(-0.8, ctx.history.affinity(a.id) / 5))),
  );
  if (seed === undefined) return NO_RESULT;
  const entries = enrichment
    .similarOf(seed.id)
    .filter((e) => !isKnownArtistName(ctx.taste, e.name))
    .slice(0, SIMILAR_TOP_N);
  const boost = ctx.tagBoost;
  const entry = pickWeighted(ctx.rng, entries, (e) => Math.exp(-e.rank / SIMILAR_RANK_SCALE) * (boost === undefined ? 1 : boost(enrichment.tagsOfMbid(e.mbid) ?? [])));
  if (entry === undefined) return NO_RESULT;
  enrichment.markUsed(seed.id, entry.mbid);

  const res = await ctx.api.search(`artist:"${escapeQuery(entry.name)}"`, ['track'], { limit: 10 });
  const wanted = normalizeName(entry.name);
  const byArtist = (res.tracks?.items ?? []).filter(isPlayableTrack).filter((t) => normalizeName(t.artists[0]?.name ?? '') === wanted);
  const primary = byArtist[0]?.artists[0];
  if (primary === undefined) return NO_RESULT;
  if (ctx.history.isAvoided(primary.id, ctx.now())) return NO_RESULT;
  enrichment.noteSpotifyArtist(entry.mbid, primary.id);

  // 同じアルバムに偏らないように 1 アルバム 2 曲まで、最大 4 曲
  const perAlbum = new Map<string, number>();
  const picked: Track[] = [];
  for (const t of shuffle(ctx.rng, byArtist)) {
    const n = perAlbum.get(t.album.id) ?? 0;
    if (n >= 2) continue;
    perAlbum.set(t.album.id, n + 1);
    picked.push(t);
    if (picked.length >= 4) break;
  }
  const seedRef: SeedRef = { id: seed.id, name: seed.name };
  const similarity = 1 / (1 + entry.rank / 20);
  const reason = hop === 1 ? ('similar' as const) : ('bridge' as const);
  const strategy = hop === 1 ? ('similar_artist' as const) : ('bridge' as const);
  const reasonDetail = hop === 1 ? seed.name : `${seed.from?.name ?? seed.name} → ${seed.name}`;
  return {
    candidates: picked.map((track) => ({ track, reason, reasonDetail, seed: seedRef, hop, similarity, strategy })),
    newArtists: [{ id: primary.id, name: entry.name, weight: 1, hop, mbid: entry.mbid, from: seedRef }],
  };
}

/** いいねした曲の類似録音を曲名+アーティスト名で本人確認して 1 曲ずつ取る(最大 2 コール) */
export async function similarTrack(ctx: ExpandContext): Promise<ExpandResult> {
  const enrichment = ctx.enrichment;
  if (enrichment === null) return NO_RESULT;
  const seeds = enrichment.tracksWithSimilar();
  const seedId = seeds[seeds.length - 1];
  if (seedId === undefined) return NO_RESULT;
  const seedRef: SeedRef = { id: seedId, name: enrichment.trackNameOf(seedId) ?? '' };
  const entries = enrichment.similarTracksOf(seedId).filter((e) => !isKnownArtistName(ctx.taste, e.artistName));
  const candidates: Candidate[] = [];
  const newArtists: SeedArtist[] = [];
  for (const entry of entries.slice(0, 2)) {
    enrichment.markTrackUsed(seedId, entry.mbid);
    const res = await ctx.api.search(`track:"${escapeQuery(entry.name)}" artist:"${escapeQuery(entry.artistName)}"`, ['track'], { limit: 3 });
    const wantedTitle = normalizeTitle(entry.name);
    const wantedArtist = normalizeName(entry.artistName);
    const hit = (res.tracks?.items ?? [])
      .filter(isPlayableTrack)
      .find((t) => normalizeTitle(t.name) === wantedTitle && t.artists.some((a) => normalizeName(a.name) === wantedArtist));
    if (hit === undefined || hit.artists.some((a) => ctx.history.isAvoided(a.id, ctx.now()))) continue;
    const primary = hit.artists[0];
    candidates.push({
      track: hit,
      reason: 'similar_track',
      reasonDetail: seedRef.name,
      seed: seedRef,
      hop: 1,
      similarity: 1 / (1 + entry.rank / 10),
      strategy: 'similar_track',
    });
    if (primary !== undefined) {
      const mbid = entry.artistMbids[0];
      if (mbid !== undefined) enrichment.noteSpotifyArtist(mbid, primary.id);
      newArtists.push({ id: primary.id, name: primary.name, weight: 1, hop: 1, mbid, from: seedRef });
    }
  }
  return { candidates, newArtists };
}

/** ジャンル × 年代の検索(1 コール)。ジャンルは聴取データ由来のタグ + 設定のチップから、年代は聴いている年代を厚く */
export async function genreSearch(ctx: ExpandContext): Promise<ExpandResult> {
  const now = ctx.now();
  const weighted = ctx.weightedGenres().filter((g) => !ctx.history.isDeadTag(g.genre, now));
  const pick = pickWeightedGenre(
    ctx.rng,
    weighted,
    DEFAULT_GENRES.filter((g) => !ctx.history.isDeadTag(g, now)),
  );
  if (pick === undefined) return NO_RESULT;
  const years = pickYearRange(ctx.rng, ctx.currentYear, hasEra(ctx.taste) ? (r) => eraShareOf(ctx.taste, r) : undefined);
  const q = genreQuery(pick.genre, years);
  const knownTotal = ctx.searchTotals.get(q);
  const maxOffset = Math.min(1000 - 10, Math.max(0, (knownTotal ?? 200) - 10));
  const offset = randomInt(ctx.rng, 0, maxOffset + 1);
  const res = await ctx.api.search(q, ['track'], { limit: 10, offset });
  const total = res.tracks?.total ?? 0;
  ctx.searchTotals.set(q, total);
  if (total === 0 && years === null) ctx.history.markDeadTag(pick.genre, now + DEAD_TAG_MS);
  const tracks = freshOnly(ctx, (res.tracks?.items ?? []).filter(isPlayableTrack));
  const reason = pick.source === 'tag' ? ('tag' as const) : ('genre' as const);
  return { candidates: tracks.map((track) => ({ track, reason, reasonDetail: pick.genre, strategy: 'genre_search' as const })), newArtists: [] };
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
  const tracks = shuffle(ctx.rng, freshOnly(ctx, albumTracks(album))).slice(0, 3);
  const strategy = reason === 'new' ? ('tag_new' as const) : ('tag_hipster' as const);
  return { candidates: tracks.map((track) => ({ track, reason, strategy })), newArtists: [] };
}

/** 過去 2 週間の新譜(2 コール) */
export const tagNew = (ctx: ExpandContext): Promise<ExpandResult> => albumTagSearch(ctx, 'tag:new', 'new', 100);

/** 人気の低い 10% のアルバム(2 コール) */
export const tagHipster = (ctx: ExpandContext): Promise<ExpandResult> => albumTagSearch(ctx, 'tag:hipster', 'hipster', 300);
