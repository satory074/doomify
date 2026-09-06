/** MusicBrainz Web Service v2(CORS 可・キー不要)。1 req/s を守る。
 *  - 名前 → MBID(検索)、MBID → Spotify アーティスト ID(url-rels)+ジャンル、ISRC → 録音+アーティスト MBID
 *  - ブラウザからは User-Agent を設定できないので既定のまま。失敗は空/null で返し、503/429 は 10 秒バックオフ */
import { createThrottle, fetchJson, shouldBackoff, type ExternalStats, type FetchLike, type Throttle } from './http';

export const MUSICBRAINZ_BASE = 'https://musicbrainz.org/ws/2';

export interface MbArtistHit {
  mbid: string;
  name: string;
  /** 検索スコア 0..100 */
  score: number;
  type?: string;
  country?: string;
  disambiguation?: string;
}

export interface MbArtist {
  mbid: string;
  name: string;
  spotifyArtistId: string | null;
  genres: { name: string; count: number }[];
}

export interface MbRecording {
  mbid: string;
  title: string;
  artists: { mbid: string; name: string }[];
}

export interface MusicBrainzClient {
  searchArtist(name: string, limit?: number): Promise<MbArtistHit[]>;
  artist(mbid: string): Promise<MbArtist | null>;
  recordingsByIsrc(isrc: string): Promise<MbRecording[]>;
  stats(): ExternalStats;
}

export interface MusicBrainzDeps {
  fetchFn?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  /** 既定 1100ms(MusicBrainz は 1 req/s) */
  minSpacingMs?: number;
  /** 429 / 503 の後に止める時間(既定 10 秒) */
  backoffMs?: number;
  throttle?: Throttle;
}

interface MbSearchResponse {
  artists?: { id?: string; name?: string; score?: number; type?: string; country?: string; disambiguation?: string }[];
}
interface MbArtistResponse {
  id?: string;
  name?: string;
  relations?: { type?: string; url?: { resource?: string } }[];
  genres?: { name?: string; count?: number }[];
}
interface MbIsrcResponse {
  recordings?: { id?: string; title?: string; 'artist-credit'?: { artist?: { id?: string; name?: string } }[] }[];
}

export function spotifyArtistIdFromUrl(url: string): string | null {
  const m = /open\.spotify\.com\/artist\/([A-Za-z0-9]+)/.exec(url);
  return m?.[1] ?? null;
}

/** Lucene の特殊文字を落として引用符で囲む */
export function artistQuery(name: string): string {
  const cleaned = name.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return `artist:"${cleaned}"`;
}

export function createMusicBrainzClient(deps: MusicBrainzDeps = {}): MusicBrainzClient {
  const fetchFn = deps.fetchFn ?? fetch;
  const base = deps.baseUrl ?? MUSICBRAINZ_BASE;
  const throttle =
    deps.throttle ?? createThrottle({ minSpacingMs: deps.minSpacingMs ?? 1100, concurrency: 1, now: deps.now, sleep: deps.sleep, backoffMs: deps.backoffMs });
  const stats: ExternalStats = { requests: 0, failures: 0, backoffs: 0 };

  const get = async <T>(path: string, query: Record<string, string>): Promise<T | null> => {
    const url = new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set('fmt', 'json');
    return throttle.run(async () => {
      stats.requests++;
      const res = await fetchJson<T>(fetchFn, url.toString());
      if (res.json === null) {
        stats.failures++;
        if (shouldBackoff(res.status)) {
          stats.backoffs++;
          throttle.backoff();
        }
      }
      return res.json;
    });
  };

  return {
    async searchArtist(name, limit = 3) {
      if (name.trim() === '') return [];
      const res = await get<MbSearchResponse>('artist/', { query: artistQuery(name), limit: String(limit) });
      return (res?.artists ?? [])
        .filter((a) => typeof a.id === 'string' && typeof a.name === 'string')
        .map((a) => ({
          mbid: a.id as string,
          name: a.name as string,
          score: typeof a.score === 'number' ? a.score : 0,
          type: a.type,
          country: a.country,
          disambiguation: a.disambiguation,
        }));
    },

    async artist(mbid) {
      const res = await get<MbArtistResponse>(`artist/${encodeURIComponent(mbid)}`, { inc: 'url-rels+genres' });
      if (res === null || typeof res.id !== 'string') return null;
      let spotifyArtistId: string | null = null;
      for (const rel of res.relations ?? []) {
        const id = spotifyArtistIdFromUrl(rel.url?.resource ?? '');
        if (id !== null) {
          spotifyArtistId = id;
          break;
        }
      }
      return {
        mbid: res.id,
        name: res.name ?? '',
        spotifyArtistId,
        genres: (res.genres ?? [])
          .filter((g) => typeof g.name === 'string')
          .map((g) => ({ name: g.name as string, count: typeof g.count === 'number' ? g.count : 0 }))
          .sort((a, b) => b.count - a.count),
      };
    },

    async recordingsByIsrc(isrc) {
      const clean = isrc.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (clean === '') return [];
      const res = await get<MbIsrcResponse>(`isrc/${clean}`, { inc: 'artists' });
      return (res?.recordings ?? [])
        .filter((r) => typeof r.id === 'string')
        .map((r) => ({
          mbid: r.id as string,
          title: r.title ?? '',
          artists: (r['artist-credit'] ?? [])
            .map((c) => c.artist)
            .filter((a): a is { id: string; name: string } => typeof a?.id === 'string' && typeof a.name === 'string')
            .map((a) => ({ mbid: a.id, name: a.name })),
        }));
    },

    stats: () => ({ ...stats }),
  };
}
