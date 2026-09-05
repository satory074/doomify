/** 使うエンドポイントだけを薄く型付けする。開発モード(2026-02 以降)で利用可能なものに限定。
 *  limit 上限(search / artistAlbums は 10)は定数化して守る */
import type { ApiClient } from './apiClient';
import type {
  Album,
  AlbumGroup,
  AlbumRef,
  Artist,
  CurrentUser,
  Device,
  FollowedArtists,
  Paging,
  PlayHistoryItem,
  PlayerState,
  Playlist,
  PlaylistItem,
  SavedTrackItem,
  SearchResponse,
  TopTimeRange,
  Track,
} from './types';

export const LIMITS = {
  search: 10,
  artistAlbums: 10,
  savedTracks: 50,
  topItems: 50,
  playlistItems: 50,
  playlists: 50,
  following: 50,
  recentlyPlayed: 50,
  libraryUris: 40,
  playlistAddUris: 100,
  searchMaxOffset: 1000,
} as const;

const MIN = 60_000;
const HOUR = 60 * MIN;
/** メモリ内の短命キャッシュ TTL(ページを閉じれば消える) */
export const TTL = {
  profile: 6 * HOUR,
  topItems: 12 * HOUR,
  saved: 2 * HOUR,
  following: 12 * HOUR,
  playlists: 2 * HOUR,
  playlistItems: 2 * HOUR,
  recent: 10 * MIN,
  track: 24 * HOUR,
  album: 24 * HOUR,
  artist: 24 * HOUR,
  artistAlbums: 24 * HOUR,
  search: 1 * HOUR,
} as const;

export type SearchType = 'track' | 'album' | 'artist' | 'playlist';

export interface PlayOptions {
  uris: string[];
  positionMs?: number;
  signal?: AbortSignal;
}

export interface SpotifyApi {
  me(): Promise<CurrentUser>;
  topTracks(timeRange: TopTimeRange, limit?: number, offset?: number): Promise<Paging<Track>>;
  topArtists(timeRange: TopTimeRange, limit?: number, offset?: number): Promise<Paging<Artist>>;
  savedTracks(limit?: number, offset?: number): Promise<Paging<SavedTrackItem>>;
  followedArtists(after?: string, limit?: number): Promise<FollowedArtists>;
  recentlyPlayed(limit?: number): Promise<{ items: PlayHistoryItem[] }>;
  myPlaylists(limit?: number, offset?: number): Promise<Paging<Playlist>>;
  playlistItems(playlistId: string, limit?: number, offset?: number): Promise<Paging<PlaylistItem>>;
  createPlaylist(input: { name: string; description?: string; isPublic?: boolean }): Promise<Playlist>;
  addToPlaylist(playlistId: string, uris: string[]): Promise<{ snapshot_id: string }>;
  track(id: string): Promise<Track>;
  album(id: string): Promise<Album>;
  artist(id: string): Promise<Artist>;
  artistAlbums(id: string, groups: AlbumGroup[], limit?: number, offset?: number): Promise<Paging<AlbumRef>>;
  search(q: string, types: SearchType[], opts?: { limit?: number; offset?: number; signal?: AbortSignal }): Promise<SearchResponse>;
  saveToLibrary(uris: string[]): Promise<void>;
  removeFromLibrary(uris: string[]): Promise<void>;
  libraryContains(uris: string[]): Promise<boolean[]>;
  player: {
    state(): Promise<PlayerState | null>;
    devices(): Promise<Device[]>;
    transfer(deviceId: string, play: boolean): Promise<void>;
    play(deviceId: string | undefined, opts: PlayOptions): Promise<void>;
    pause(deviceId?: string): Promise<void>;
    resume(deviceId?: string): Promise<void>;
    seek(positionMs: number, deviceId?: string): Promise<void>;
  };
}

function clampLimit(value: number | undefined, max: number, fallback: number): number {
  const v = value ?? fallback;
  return Math.max(1, Math.min(max, Math.floor(v)));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createSpotifyApi(client: ApiClient): SpotifyApi {
  const get = <T>(path: string, query: Record<string, string | number | boolean | undefined> | undefined, cacheTtlMs: number, signal?: AbortSignal) =>
    client.request<T>({ method: 'GET', path, query, cacheTtlMs, priority: 'feed', signal });

  return {
    me: () => get<CurrentUser>('/me', undefined, TTL.profile),

    topTracks: (timeRange, limit, offset = 0) =>
      get<Paging<Track>>(
        '/me/top/tracks',
        { time_range: timeRange, limit: clampLimit(limit, LIMITS.topItems, LIMITS.topItems), offset },
        TTL.topItems,
      ),

    topArtists: (timeRange, limit, offset = 0) =>
      get<Paging<Artist>>(
        '/me/top/artists',
        { time_range: timeRange, limit: clampLimit(limit, LIMITS.topItems, LIMITS.topItems), offset },
        TTL.topItems,
      ),

    savedTracks: (limit, offset = 0) =>
      get<Paging<SavedTrackItem>>(
        '/me/tracks',
        { limit: clampLimit(limit, LIMITS.savedTracks, LIMITS.savedTracks), offset },
        TTL.saved,
      ),

    followedArtists: (after, limit) =>
      get<FollowedArtists>(
        '/me/following',
        { type: 'artist', after, limit: clampLimit(limit, LIMITS.following, LIMITS.following) },
        TTL.following,
      ),

    recentlyPlayed: (limit) =>
      get<{ items: PlayHistoryItem[] }>(
        '/me/player/recently-played',
        { limit: clampLimit(limit, LIMITS.recentlyPlayed, LIMITS.recentlyPlayed) },
        TTL.recent,
      ),

    myPlaylists: (limit, offset = 0) =>
      get<Paging<Playlist>>('/me/playlists', { limit: clampLimit(limit, LIMITS.playlists, LIMITS.playlists), offset }, TTL.playlists),

    playlistItems: (playlistId, limit, offset = 0) =>
      get<Paging<PlaylistItem>>(
        `/playlists/${encodeURIComponent(playlistId)}/items`,
        { limit: clampLimit(limit, LIMITS.playlistItems, LIMITS.playlistItems), offset },
        TTL.playlistItems,
      ),

    createPlaylist: ({ name, description, isPublic = false }) =>
      client.request<Playlist>({
        method: 'POST',
        path: '/me/playlists',
        body: { name, description: description ?? '', public: isPublic },
        priority: 'action',
      }),

    addToPlaylist: (playlistId, uris) =>
      client.request<{ snapshot_id: string }>({
        method: 'POST',
        path: `/playlists/${encodeURIComponent(playlistId)}/items`,
        body: { uris: uris.slice(0, LIMITS.playlistAddUris) },
        priority: 'action',
      }),

    track: (id) => get<Track>(`/tracks/${encodeURIComponent(id)}`, undefined, TTL.track),
    album: (id) => get<Album>(`/albums/${encodeURIComponent(id)}`, undefined, TTL.album),
    artist: (id) => get<Artist>(`/artists/${encodeURIComponent(id)}`, undefined, TTL.artist),

    artistAlbums: (id, groups, limit, offset = 0) =>
      get<Paging<AlbumRef>>(
        `/artists/${encodeURIComponent(id)}/albums`,
        {
          include_groups: groups.join(','),
          limit: clampLimit(limit, LIMITS.artistAlbums, LIMITS.artistAlbums),
          offset,
        },
        TTL.artistAlbums,
      ),

    search: (q, types, opts = {}) =>
      get<SearchResponse>(
        '/search',
        {
          q,
          type: types.join(','),
          limit: clampLimit(opts.limit, LIMITS.search, LIMITS.search),
          offset: Math.min(LIMITS.searchMaxOffset, Math.max(0, opts.offset ?? 0)),
        },
        TTL.search,
        opts.signal,
      ),

    async saveToLibrary(uris) {
      for (const part of chunk(uris, LIMITS.libraryUris)) {
        await client.request<void>({ method: 'PUT', path: '/me/library', query: { uris: part.join(',') }, priority: 'action' });
      }
    },

    async removeFromLibrary(uris) {
      for (const part of chunk(uris, LIMITS.libraryUris)) {
        await client.request<void>({ method: 'DELETE', path: '/me/library', query: { uris: part.join(',') }, priority: 'action' });
      }
    },

    async libraryContains(uris) {
      const out: boolean[] = [];
      for (const part of chunk(uris, LIMITS.libraryUris)) {
        const res = await client.request<boolean[]>({
          method: 'GET',
          path: '/me/library/contains',
          query: { uris: part.join(',') },
          priority: 'action',
        });
        out.push(...res);
      }
      return out;
    },

    player: {
      async state() {
        const res = await client.request<PlayerState | undefined>({ method: 'GET', path: '/me/player', priority: 'playback' });
        return res ?? null;
      },
      async devices() {
        const res = await client.request<{ devices: Device[] }>({ method: 'GET', path: '/me/player/devices', priority: 'playback' });
        return res.devices;
      },
      transfer: (deviceId, play) =>
        client.request<void>({ method: 'PUT', path: '/me/player', body: { device_ids: [deviceId], play }, priority: 'playback' }),
      play: (deviceId, opts) =>
        client.request<void>({
          method: 'PUT',
          path: '/me/player/play',
          query: { device_id: deviceId },
          body: { uris: opts.uris, ...(opts.positionMs !== undefined ? { position_ms: Math.max(0, Math.floor(opts.positionMs)) } : {}) },
          priority: 'playback',
          signal: opts.signal,
        }),
      pause: (deviceId) =>
        client.request<void>({ method: 'PUT', path: '/me/player/pause', query: { device_id: deviceId }, priority: 'playback' }),
      resume: (deviceId) =>
        client.request<void>({ method: 'PUT', path: '/me/player/play', query: { device_id: deviceId }, priority: 'playback' }),
      seek: (positionMs, deviceId) =>
        client.request<void>({
          method: 'PUT',
          path: '/me/player/seek',
          query: { position_ms: Math.max(0, Math.floor(positionMs)), device_id: deviceId },
          priority: 'playback',
        }),
    },
  };
}
