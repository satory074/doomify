/** ListenBrainz(CORS 可・トークン不要の範囲だけ)。
 *  - Labs: 類似アーティスト / 類似録音(POST で複数の MBID をまとめて 1 回)
 *  - API: アーティストのタグ(metadata/artist、25 件ずつ)
 *  失敗は空で返す。429/503 はバックオフ */
import { createThrottle, fetchJson, shouldBackoff, type ExternalStats, type FetchLike, type Throttle } from './http';

export const LISTENBRAINZ_LABS_BASE = 'https://labs.api.listenbrainz.org';
export const LISTENBRAINZ_API_BASE = 'https://api.listenbrainz.org/1';
export const SIMILAR_ARTISTS_ALGORITHM = 'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';
export const SIMILAR_RECORDINGS_ALGORITHM = 'session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30_top_n_listeners_1000';
export const TAGS_BATCH = 25;

export interface LbSimilarArtist {
  mbid: string;
  name: string;
  score: number;
}

export interface LbSimilarRecording {
  mbid: string;
  name: string;
  artistName: string;
  artistMbids: string[];
  releaseName: string | null;
  score: number;
}

export interface LbTag {
  tag: string;
  count: number;
}

export interface ListenBrainzClient {
  /** 種 MBID → 類似アーティスト(score 降順)。見つからない種は含まれない */
  similarArtists(mbids: readonly string[]): Promise<Map<string, LbSimilarArtist[]>>;
  similarRecordings(mbids: readonly string[]): Promise<Map<string, LbSimilarRecording[]>>;
  /** アーティスト MBID → タグ(count 降順) */
  artistTags(mbids: readonly string[]): Promise<Map<string, LbTag[]>>;
  stats(): ExternalStats;
}

export interface ListenBrainzDeps {
  fetchFn?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  labsBase?: string;
  apiBase?: string;
  minSpacingMs?: number;
  /** 429 / 503 の後に止める時間(既定 10 秒) */
  backoffMs?: number;
  throttle?: Throttle;
}

interface SimilarArtistRow {
  artist_mbid?: string | null;
  name?: string | null;
  score?: number | null;
  reference_mbid?: string | null;
}
interface SimilarRecordingRow {
  recording_mbid?: string | null;
  recording_name?: string | null;
  artist_credit_name?: string | null;
  artist_credit_mbids?: string[] | null;
  release_name?: string | null;
  score?: number | null;
  reference_mbid?: string | null;
}
interface ArtistMetadataRow {
  artist_mbid?: string;
  name?: string;
  tag?: { artist?: { tag?: string; count?: number }[] };
}

const uniq = (ids: readonly string[]) => [...new Set(ids.filter((id) => id !== ''))];

export function createListenBrainzClient(deps: ListenBrainzDeps = {}): ListenBrainzClient {
  const fetchFn = deps.fetchFn ?? fetch;
  const labs = deps.labsBase ?? LISTENBRAINZ_LABS_BASE;
  const api = deps.apiBase ?? LISTENBRAINZ_API_BASE;
  const throttle = deps.throttle ?? createThrottle({ minSpacingMs: deps.minSpacingMs ?? 250, concurrency: 2, now: deps.now, sleep: deps.sleep, backoffMs: deps.backoffMs });
  const stats: ExternalStats = { requests: 0, failures: 0, backoffs: 0 };

  const request = async <T>(url: string, body?: unknown): Promise<T | null> =>
    throttle.run(async () => {
      stats.requests++;
      const res = await fetchJson<T>(fetchFn, url, body === undefined ? {} : { method: 'POST', body });
      if (res.json === null) {
        stats.failures++;
        if (shouldBackoff(res.status)) {
          stats.backoffs++;
          throttle.backoff();
        }
      }
      return res.json;
    });

  return {
    async similarArtists(mbids) {
      const ids = uniq(mbids);
      const out = new Map<string, LbSimilarArtist[]>();
      if (ids.length === 0) return out;
      const rows = await request<SimilarArtistRow[]>(`${labs}/similar-artists/json`, [{ artist_mbids: ids, algorithm: SIMILAR_ARTISTS_ALGORITHM }]);
      for (const r of Array.isArray(rows) ? rows : []) {
        if (typeof r.reference_mbid !== 'string' || typeof r.artist_mbid !== 'string' || typeof r.name !== 'string') continue;
        const list = out.get(r.reference_mbid) ?? [];
        list.push({ mbid: r.artist_mbid, name: r.name, score: typeof r.score === 'number' ? r.score : 0 });
        out.set(r.reference_mbid, list);
      }
      for (const list of out.values()) list.sort((a, b) => b.score - a.score);
      return out;
    },

    async similarRecordings(mbids) {
      const ids = uniq(mbids);
      const out = new Map<string, LbSimilarRecording[]>();
      if (ids.length === 0) return out;
      const rows = await request<SimilarRecordingRow[]>(`${labs}/similar-recordings/json`, [
        { recording_mbids: ids, algorithm: SIMILAR_RECORDINGS_ALGORITHM },
      ]);
      for (const r of Array.isArray(rows) ? rows : []) {
        if (typeof r.reference_mbid !== 'string' || typeof r.recording_mbid !== 'string' || typeof r.recording_name !== 'string') continue;
        const list = out.get(r.reference_mbid) ?? [];
        list.push({
          mbid: r.recording_mbid,
          name: r.recording_name,
          artistName: r.artist_credit_name ?? '',
          artistMbids: Array.isArray(r.artist_credit_mbids) ? r.artist_credit_mbids.filter((m): m is string => typeof m === 'string') : [],
          releaseName: r.release_name ?? null,
          score: typeof r.score === 'number' ? r.score : 0,
        });
        out.set(r.reference_mbid, list);
      }
      for (const list of out.values()) list.sort((a, b) => b.score - a.score);
      return out;
    },

    async artistTags(mbids) {
      const ids = uniq(mbids);
      const out = new Map<string, LbTag[]>();
      for (let i = 0; i < ids.length; i += TAGS_BATCH) {
        const chunk = ids.slice(i, i + TAGS_BATCH);
        const url = `${api}/metadata/artist/?artist_mbids=${encodeURIComponent(chunk.join(','))}&inc=tag`;
        const rows = await request<ArtistMetadataRow[]>(url);
        for (const r of Array.isArray(rows) ? rows : []) {
          if (typeof r.artist_mbid !== 'string') continue;
          const tags = (r.tag?.artist ?? [])
            .filter((t): t is { tag: string; count: number } => typeof t.tag === 'string' && typeof t.count === 'number')
            .map((t) => ({ tag: t.tag.toLowerCase(), count: t.count }))
            .sort((a, b) => b.count - a.count);
          out.set(r.artist_mbid, tags);
        }
      }
      return out;
    },

    stats: () => ({ ...stats }),
  };
}
