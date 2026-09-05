/** フィードの「種」を集める。ユーザー本人のデータ(トップ曲・保存曲・フォロー・最近再生・自分のプレイリスト)。
 *  各 1 コールで、IndexedDB に短期キャッシュしてコールドスタートのコール数を抑える */
import { getFresh, setWithTtl, type KeyValueStore } from '../spotify/cache';
import type { SpotifyApi } from '../spotify/endpoints';
import type { Artist, CurrentUser, FollowedArtists, Paging, PlayHistoryItem, Playlist, SavedTrackItem, Track } from '../spotify/types';
import type { FeedReason } from './types';

export interface Candidate {
  track: Track;
  reason: FeedReason;
  reasonDetail?: string;
}

export interface SeedArtist {
  id: string;
  name: string;
  weight: number;
}

export interface OwnPlaylist {
  id: string;
  name: string;
  total: number;
}

export interface Seeds {
  known: Candidate[];
  artists: SeedArtist[];
  genres: string[];
  playlists: OwnPlaylist[];
  savedTotal: number;
  userId: string | null;
  /** 取得に失敗した種の数(表示・診断用) */
  failures: number;
}

export interface SourceDeps {
  api: SpotifyApi;
  store: KeyValueStore;
  now: () => number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
export const POOL_TTL = {
  me: 24 * HOUR,
  top: 12 * HOUR,
  following: 12 * HOUR,
  saved: 2 * HOUR,
  playlists: 2 * HOUR,
  recent: 10 * MIN,
} as const;

const KEY = (name: string) => `doomify:pool:${name}:v1`;

async function cached<T>(deps: SourceDeps, name: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const hit = await getFresh<T>(deps.store, KEY(name), deps.now());
  if (hit !== undefined) return hit;
  const value = await fetcher();
  await setWithTtl(deps.store, KEY(name), value, ttlMs, deps.now());
  return value;
}

function isPlayableTrack(t: Track | null | undefined): t is Track {
  return !!t && typeof t.id === 'string' && t.id !== '' && t.is_local !== true && (t.type === undefined || t.type === 'track');
}

export async function loadSeeds(deps: SourceDeps): Promise<Seeds> {
  const [me, topShort, topMedium, topLong, topArtists, following, saved, playlists, recent] = await Promise.allSettled([
    cached<CurrentUser>(deps, 'me', POOL_TTL.me, () => deps.api.me()),
    cached<Paging<Track>>(deps, 'top:tracks:short', POOL_TTL.top, () => deps.api.topTracks('short_term')),
    cached<Paging<Track>>(deps, 'top:tracks:medium', POOL_TTL.top, () => deps.api.topTracks('medium_term')),
    cached<Paging<Track>>(deps, 'top:tracks:long', POOL_TTL.top, () => deps.api.topTracks('long_term')),
    cached<Paging<Artist>>(deps, 'top:artists:medium', POOL_TTL.top, () => deps.api.topArtists('medium_term')),
    cached<FollowedArtists>(deps, 'following', POOL_TTL.following, () => deps.api.followedArtists()),
    cached<Paging<SavedTrackItem>>(deps, 'saved:0', POOL_TTL.saved, () => deps.api.savedTracks(50, 0)),
    cached<Paging<Playlist>>(deps, 'playlists', POOL_TTL.playlists, () => deps.api.myPlaylists(50, 0)),
    cached<{ items: PlayHistoryItem[] }>(deps, 'recent', POOL_TTL.recent, () => deps.api.recentlyPlayed(50)),
  ]);

  const ok = <T>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);
  const results = [me, topShort, topMedium, topLong, topArtists, following, saved, playlists, recent];
  const failures = results.filter((r) => r.status === 'rejected').length;

  const known: Candidate[] = [];
  const artistWeight = new Map<string, SeedArtist>();
  const bump = (a: { id: string; name: string }, w: number) => {
    const cur = artistWeight.get(a.id);
    if (cur) cur.weight += w;
    else artistWeight.set(a.id, { id: a.id, name: a.name, weight: w });
  };

  for (const paging of [ok(topShort), ok(topMedium), ok(topLong)]) {
    for (const t of paging?.items ?? []) {
      if (!isPlayableTrack(t)) continue;
      known.push({ track: t, reason: 'top' });
      for (const a of t.artists) bump(a, 1);
    }
  }
  for (const item of ok(saved)?.items ?? []) {
    if (!isPlayableTrack(item.track)) continue;
    known.push({ track: item.track, reason: 'saved' });
    for (const a of item.track.artists) bump(a, 0.5);
  }
  for (const item of ok(recent)?.items ?? []) {
    if (!isPlayableTrack(item.track)) continue;
    known.push({ track: item.track, reason: 'recent' });
    for (const a of item.track.artists) bump(a, 0.5);
  }

  const topArtistItems = ok(topArtists)?.items ?? [];
  topArtistItems.forEach((a, i) => bump(a, 3 - (i / Math.max(1, topArtistItems.length)) * 1.5));
  for (const a of ok(following)?.artists.items ?? []) bump(a, 2);

  const genres = new Set<string>();
  for (const a of topArtistItems) for (const g of a.genres ?? []) genres.add(g);

  const userId = ok(me)?.id ?? null;
  const ownPlaylists: OwnPlaylist[] = (ok(playlists)?.items ?? [])
    .filter((p) => (userId !== null && p.owner.id === userId) || p.collaborative)
    .map((p) => ({ id: p.id, name: p.name, total: p.items?.total ?? p.tracks?.total ?? 0 }))
    .filter((p) => p.total > 0);

  return {
    known,
    artists: [...artistWeight.values()].sort((a, b) => b.weight - a.weight),
    genres: [...genres],
    playlists: ownPlaylists,
    savedTotal: ok(saved)?.total ?? 0,
    userId,
    failures,
  };
}

/** 保存曲のランダムなページ(1 コール) */
export async function savedRandomPage(api: SpotifyApi, savedTotal: number, offsetPick: (max: number) => number): Promise<Candidate[]> {
  const maxOffset = Math.max(0, savedTotal - 50);
  const page = await api.savedTracks(50, offsetPick(maxOffset));
  return page.items.filter((i) => isPlayableTrack(i.track)).map((i) => ({ track: i.track, reason: 'saved' as const }));
}

/** 自分のプレイリストのランダムなページ(1 コール) */
export async function playlistRandomPage(api: SpotifyApi, playlist: OwnPlaylist, offsetPick: (max: number) => number): Promise<Candidate[]> {
  const maxOffset = Math.max(0, playlist.total - 50);
  const page = await api.playlistItems(playlist.id, 50, offsetPick(maxOffset));
  return page.items
    .map((i) => i.item ?? i.track ?? null)
    .filter(isPlayableTrack)
    .map((t) => ({ track: t, reason: 'playlist' as const, reasonDetail: playlist.name }));
}

export { isPlayableTrack };
