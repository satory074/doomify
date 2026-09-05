/** テスト用の偽 SpotifyApi。呼び出しを記録し、決定的なダミーデータを返す */
import type { SpotifyApi } from '../spotify/endpoints';
import type { Album, AlbumRef, Artist, Paging, Track } from '../spotify/types';

export function fixtureTrack(n: number | string, artistId = `a${typeof n === 'number' ? n % 7 : 0}`, albumId?: string): Track {
  const id = `t${n}`;
  const al = albumId ?? `al${n}`;
  return {
    id,
    uri: `spotify:track:${id}`,
    name: `Track ${n}`,
    duration_ms: 200_000,
    artists: [{ id: artistId, name: `Artist ${artistId}`, uri: `spotify:artist:${artistId}` }],
    album: { id: al, name: `Album ${al}`, uri: `spotify:album:${al}`, images: [{ url: `https://picsum.photos/seed/${al}/640/640`, width: 640, height: 640 }] },
  };
}

export function paging<T>(items: T[], total = items.length, offset = 0): Paging<T> {
  return { items, total, limit: items.length, offset, next: null };
}

function albumRef(id: string, artistId: string, type = 'album'): AlbumRef {
  return {
    id,
    name: `Album ${id}`,
    uri: `spotify:album:${id}`,
    images: [{ url: `https://picsum.photos/seed/${id.replace(/[^a-z0-9]/gi, '')}/640/640`, width: 640, height: 640 }],
    album_type: type,
    artists: [{ id: artistId, name: `Artist ${artistId}`, uri: `spotify:artist:${artistId}` }],
  };
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 100_000;
}

export interface FakeApiOptions {
  /** 呼び出し名(calls に記録される文字列)ごとの応答遅延 ms。setTimeout なので vi.useFakeTimers + advanceTimersByTimeAsync で進める */
  delay?: (call: string) => number;
}

type AsyncMethod = (...args: never[]) => Promise<unknown>;

/** 各メソッドを「応答の前に delay(呼び出し名) だけ待つ」形に包む。calls への記録は呼び出し時のまま(先頭で同期的に log される) */
function withDelay(api: SpotifyApi, calls: readonly string[], delay: (call: string) => number): SpotifyApi {
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const wrap = <F extends AsyncMethod>(fn: F): F => {
    const wrapped = async (...args: Parameters<F>): Promise<unknown> => {
      const at = calls.length;
      try {
        return await fn(...args);
      } finally {
        const ms = delay(calls[at] ?? '');
        if (ms > 0) await wait(ms);
      }
    };
    return wrapped as unknown as F;
  };
  return {
    me: wrap(api.me),
    topTracks: wrap(api.topTracks),
    topArtists: wrap(api.topArtists),
    savedTracks: wrap(api.savedTracks),
    followedArtists: wrap(api.followedArtists),
    recentlyPlayed: wrap(api.recentlyPlayed),
    myPlaylists: wrap(api.myPlaylists),
    playlistItems: wrap(api.playlistItems),
    createPlaylist: wrap(api.createPlaylist),
    addToPlaylist: wrap(api.addToPlaylist),
    track: wrap(api.track),
    album: wrap(api.album),
    artist: wrap(api.artist),
    artistAlbums: wrap(api.artistAlbums),
    search: wrap(api.search),
    saveToLibrary: wrap(api.saveToLibrary),
    removeFromLibrary: wrap(api.removeFromLibrary),
    libraryContains: wrap(api.libraryContains),
    player: api.player,
  };
}

export function createFakeApi(overrides: Partial<SpotifyApi> = {}, opts: FakeApiOptions = {}): { api: SpotifyApi; calls: string[] } {
  const calls: string[] = [];
  const log = (s: string) => {
    calls.push(s);
  };
  const artist = (id: string, genres?: string[]): Artist => ({ id, name: `Artist ${id}`, uri: `spotify:artist:${id}`, genres });

  const base: SpotifyApi = {
    me: async () => {
      log('me');
      return { id: 'me', display_name: 'Me' };
    },
    topTracks: async (range) => {
      log(`topTracks:${range}`);
      const base = range === 'short_term' ? 1000 : range === 'medium_term' ? 1100 : 1200;
      return paging(Array.from({ length: 20 }, (_, i) => fixtureTrack(base + i)));
    },
    topArtists: async () => {
      log('topArtists');
      return paging([artist('a0', ['shoegaze']), artist('a1'), artist('a2', ['city pop']), artist('a3'), artist('a4')]);
    },
    savedTracks: async (limit = 50, offset = 0) => {
      log(`savedTracks:${offset}`);
      return paging(
        Array.from({ length: limit }, (_, i) => ({ added_at: '2026-01-01', track: fixtureTrack(2000 + offset + i) })),
        500,
        offset,
      );
    },
    followedArtists: async () => {
      log('followedArtists');
      return { artists: { items: [artist('f1'), artist('f2')], next: null, cursors: { after: null }, total: 2 } };
    },
    recentlyPlayed: async () => {
      log('recentlyPlayed');
      return { items: Array.from({ length: 10 }, (_, i) => ({ played_at: '2026-01-01', track: fixtureTrack(4000 + i) })) };
    },
    myPlaylists: async () => {
      log('myPlaylists');
      return paging([
        { id: 'pl1', name: 'My List', uri: 'spotify:playlist:pl1', owner: { id: 'me' }, collaborative: false, images: [], items: { total: 100 } },
        { id: 'pl2', name: 'Editorial', uri: 'spotify:playlist:pl2', owner: { id: 'spotify' }, collaborative: false, images: [], items: { total: 100 } },
      ]);
    },
    playlistItems: async (id, limit = 50, offset = 0) => {
      log(`playlistItems:${id}:${offset}`);
      return paging(Array.from({ length: limit }, (_, i) => ({ item: fixtureTrack(3000 + offset + i) })), 100, offset);
    },
    createPlaylist: async ({ name }) => {
      log('createPlaylist');
      return { id: 'new', name, uri: 'spotify:playlist:new', owner: { id: 'me' }, collaborative: false, images: [] };
    },
    addToPlaylist: async (id) => {
      log(`addToPlaylist:${id}`);
      return { snapshot_id: 's' };
    },
    track: async (id) => {
      log(`track:${id}`);
      return fixtureTrack(id);
    },
    album: async (id) => {
      log(`album:${id}`);
      const isAppears = id.includes(':appears:');
      const ownerArtist = id.split(':')[0] ?? 'a0';
      const tracks = Array.from({ length: 8 }, (_, i) => {
        const artistId = isAppears ? `x${hash(id) % 5}-${i % 3}` : ownerArtist;
        const t = fixtureTrack(`${id}-${i}`, artistId, id);
        const { album: _album, ...simplified } = t;
        return simplified;
      });
      const album: Album = { ...albumRef(id, ownerArtist), tracks: paging(tracks) };
      return album;
    },
    artist: async (id) => {
      log(`artist:${id}`);
      return artist(id);
    },
    artistAlbums: async (id, groups, limit = 10, offset = 0) => {
      log(`artistAlbums:${id}:${groups.join('+')}:${offset}`);
      const kind = groups.includes('appears_on') ? 'appears' : 'own';
      return paging(
        Array.from({ length: Math.min(limit, 5) }, (_, i) => albumRef(`${id}:${kind}:${offset + i}`, id, i % 2 === 0 ? 'album' : 'single')),
        25,
        offset,
      );
    },
    search: async (q, types, opts = {}) => {
      const offset = opts.offset ?? 0;
      log(`search:${q}:${types.join('+')}:${offset}`);
      const h = hash(q);
      if (types.includes('album')) {
        return { albums: paging(Array.from({ length: 10 }, (_, i) => albumRef(`s${h}:own:${offset + i}`, `sa${h % 9}`)), 400, offset) };
      }
      return { tracks: paging(Array.from({ length: 10 }, (_, i) => fixtureTrack(`s${h}-${offset + i}`, `g${(h + i) % 11}`)), 800, offset) };
    },
    saveToLibrary: async () => {
      log('saveToLibrary');
    },
    removeFromLibrary: async () => {
      log('removeFromLibrary');
    },
    libraryContains: async (uris) => {
      log('libraryContains');
      return uris.map(() => false);
    },
    player: {
      state: async () => null,
      devices: async () => [],
      transfer: async () => {},
      play: async () => {
        log('play');
      },
      pause: async () => {},
      resume: async () => {},
      seek: async () => {},
    },
    ...overrides,
  };
  const api = opts.delay === undefined ? base : withDelay(base, calls, opts.delay);
  return { api, calls };
}
