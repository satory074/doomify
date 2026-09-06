/** テスト用の偽 SpotifyApi と偽外部(MusicBrainz / ListenBrainz)。呼び出しを記録し、決定的なダミーデータを返す */
import type { LbSimilarArtist, LbSimilarRecording, LbTag, ListenBrainzClient } from '../external/listenbrainz';
import type { MbArtist, MbArtistHit, MbRecording, MusicBrainzClient } from '../external/musicbrainz';
import type { SpotifyApi } from '../spotify/endpoints';
import type { Album, AlbumRef, Artist, Paging, Track } from '../spotify/types';
import { normalizeName } from './taste';

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
    external_ids: { isrc: `ISRC${String(n).replace(/[^A-Za-z0-9]/g, '')}` },
  };
}

/** 任意のアーティスト名・曲名の曲(類似アーティスト経由の検索結果用) */
export function namedTrack(id: string, name: string, artist: { id: string; name: string }, albumId = `al-${artist.id}`): Track {
  return {
    id,
    uri: `spotify:track:${id}`,
    name,
    duration_ms: 210_000,
    artists: [{ id: artist.id, name: artist.name, uri: `spotify:artist:${artist.id}` }],
    album: { id: albumId, name: `Album ${albumId}`, uri: `spotify:album:${albumId}`, images: [{ url: `https://picsum.photos/seed/${albumId.replace(/[^a-z0-9]/gi, '')}/640/640`, width: 640, height: 640 }], release_date: '2021-05-01' },
    external_ids: { isrc: `ISRC${id.replace(/[^A-Za-z0-9]/g, '')}` },
  };
}

/** 偽外部の命名規則: 種 "Artist a1" → MBID "mb:artista1"、その類似は "Sim artista1 1".."Sim artista1 5"(Spotify ID "sim-artista1-1") */
export const FAKE_SIMILAR_COUNT = 5;
export const fakeMbid = (name: string): string => `mb:${normalizeName(name)}`;
export const fakeSimilarName = (seedMbid: string, n: number): string => `Sim ${seedMbid.slice(3)} ${n}`;
export const fakeSimilarSpotifyId = (seedMbid: string, n: number): string => `sim-${seedMbid.slice(3)}-${n}`;
export const fakeSpotifyIdOfMbid = (mbid: string): string | null => {
  const m = /^mb:sim-(.+)-(\d+)$/.exec(mbid);
  return m === null ? null : `sim-${m[1]}-${m[2]}`;
};

/** 検索クエリのフィルタを読む(偽 API 用) */
export function parseQuery(q: string): { artist?: string; track?: string; genre?: string; tag?: string } {
  const pick = (key: string) => {
    const m = new RegExp(`${key}:"([^"]*)"`).exec(q);
    return m?.[1];
  };
  const tag = /tag:(new|hipster)/.exec(q)?.[1];
  return { artist: pick('artist'), track: pick('track'), genre: pick('genre'), tag };
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
      const f = parseQuery(q);
      if (f.artist !== undefined && f.artist.startsWith('Nobody')) return { tracks: paging([], 0, 0) };
      if (f.artist !== undefined && f.track !== undefined) {
        // 曲名 + アーティスト名の本人確認検索: 1 件目が完全一致
        const artist = { id: `sp-${normalizeName(f.artist)}`, name: f.artist };
        return { tracks: paging([namedTrack(`x${h}`, f.track, artist), namedTrack(`x${h}-b`, `${f.track} (Live)`, artist)], 2, 0) };
      }
      if (f.artist !== undefined) {
        // アーティスト名検索: 10 曲(3 アルバム)。末尾 1 件は別アーティストの feat. 混入
        const artist = { id: `sp-${normalizeName(f.artist)}`, name: f.artist };
        const tracks = Array.from({ length: 9 }, (_, i) => namedTrack(`${artist.id}-${offset + i}`, `${f.artist} Song ${offset + i}`, artist, `al-${artist.id}-${i % 3}`));
        tracks.push(namedTrack(`${artist.id}-other`, 'Other Song', { id: 'someone-else', name: 'Someone Else' }));
        return { tracks: paging(tracks, 40, offset) };
      }
      if (types.includes('album')) {
        return { albums: paging(Array.from({ length: 10 }, (_, i) => albumRef(`s${h}:own:${offset + i}`, `sa${h % 9}`)), 400, offset) };
      }
      if (f.genre === 'nothing') return { tracks: paging([], 0, 0) };
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

export interface FakeExternal {
  mb: MusicBrainzClient;
  lb: ListenBrainzClient;
  calls: string[];
}

/** 偽 MusicBrainz / ListenBrainz。名前 → MBID は決定的、類似は 5 件、タグは種が j-pop/anime、類似は奇数が j-pop・偶数が city pop */
export function createFakeExternal(over: { mb?: Partial<MusicBrainzClient>; lb?: Partial<ListenBrainzClient> } = {}): FakeExternal {
  const calls: string[] = [];
  const log = (s: string) => {
    calls.push(s);
  };
  const empty = () => ({ requests: calls.length, failures: 0, backoffs: 0 });
  const mb: MusicBrainzClient = {
    async searchArtist(name): Promise<MbArtistHit[]> {
      log(`mb:search:${name}`);
      if (name.startsWith('Nobody')) return [];
      return [{ mbid: fakeMbid(name), name, score: 100 }];
    },
    async artist(mbid): Promise<MbArtist | null> {
      log(`mb:artist:${mbid}`);
      return { mbid, name: mbid.slice(3), spotifyArtistId: fakeSpotifyIdOfMbid(mbid), genres: [{ name: 'j-pop', count: 2 }] };
    },
    async recordingsByIsrc(isrc): Promise<MbRecording[]> {
      log(`mb:isrc:${isrc}`);
      if (isrc.startsWith('NONE')) return [];
      return [{ mbid: `rec:${isrc}`, title: `Recording ${isrc}`, artists: [{ mbid: 'mb:someone', name: 'Someone' }] }];
    },
    stats: empty,
    ...over.mb,
  };
  const lb: ListenBrainzClient = {
    async similarArtists(mbids) {
      log(`lb:similar:${mbids.join(',')}`);
      const out = new Map<string, LbSimilarArtist[]>();
      for (const m of mbids) {
        if (m.startsWith('mb:lonely')) continue;
        out.set(
          m,
          Array.from({ length: FAKE_SIMILAR_COUNT }, (_, i) => ({ mbid: `mb:sim-${m.slice(3)}-${i + 1}`, name: fakeSimilarName(m, i + 1), score: 100 - i * 10 })),
        );
      }
      return out;
    },
    async similarRecordings(mbids) {
      log(`lb:simrec:${mbids.join(',')}`);
      const out = new Map<string, LbSimilarRecording[]>();
      for (const m of mbids) {
        out.set(
          m,
          Array.from({ length: 3 }, (_, i) => ({ mbid: `${m}:sim${i + 1}`, name: `Like ${m.slice(4)} ${i + 1}`, artistName: `Rec Artist ${i + 1}`, artistMbids: [], releaseName: null, score: 50 - i })),
        );
      }
      return out;
    },
    async artistTags(mbids) {
      log(`lb:tags:${mbids.length}`);
      const out = new Map<string, LbTag[]>();
      for (const m of mbids) {
        const sim = /-(\d+)$/.exec(m);
        out.set(m, sim === null ? [{ tag: 'j-pop', count: 5 }, { tag: 'anime', count: 2 }] : Number(sim[1]) % 2 === 1 ? [{ tag: 'j-pop', count: 3 }] : [{ tag: 'city pop', count: 3 }]);
      }
      return out;
    },
    stats: empty,
    ...over.lb,
  };
  return { mb, lb, calls };
}
