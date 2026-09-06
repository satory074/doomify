/** Spotify のアーティスト / 曲 → MusicBrainz ID の解決。結果は長期キャッシュ(見つからなかったことも短めに覚える)。
 *  - 名前検索の上位が 1 件だけ高スコアなら採用。複数が拮抗するときは url-rels の Spotify リンクで本人確認
 *  - 全て null 許容。失敗しても投げない */
import type { MusicBrainzClient } from '../external/musicbrainz';
import { EXTERNAL_MAX_TTL_MS, getEntry, setWithTtl, type KeyValueStore } from '../spotify/cache';
import { normalizeName } from './taste';

export interface IdentityDeps {
  mb: MusicBrainzClient;
  store: KeyValueStore;
  now: () => number;
}

export interface RecordingIdentity {
  recordingMbid: string;
  artistMbids: string[];
}

export interface Identity {
  /** Spotify アーティスト → MBID。見つからなければ null */
  resolveArtist(artist: { id: string; name: string }): Promise<string | null>;
  /** MBID → Spotify アーティスト ID(url-rels)。無ければ null */
  spotifyIdOf(mbid: string): Promise<string | null>;
  /** 曲の ISRC → 録音 MBID とアーティスト MBID */
  resolveRecording(track: { id: string; external_ids?: { isrc?: string } }): Promise<RecordingIdentity | null>;
}

const DAY = 24 * 60 * 60 * 1000;
export const HIT_TTL_MS = 30 * DAY;
export const MISS_TTL_MS = 7 * DAY;
export const ACCEPT_SCORE = 95;
export const AMBIGUOUS_SCORE = 90;
export const CANDIDATE_SCORE = 70;

export const artistKey = (spotifyId: string): string => `doomify:ext:artist:${spotifyId}`;
export const mbidKey = (mbid: string): string => `doomify:ext:mbid:${mbid}`;
export const isrcKey = (isrc: string): string => `doomify:ext:isrc:${isrc}`;

interface ArtistEntry {
  mbid: string | null;
}
interface MbidEntry {
  spotifyId: string | null;
}
interface IsrcEntry {
  recordingMbid: string | null;
  artistMbids: string[];
}

export function createIdentity(deps: IdentityDeps): Identity {
  const read = async <T>(key: string): Promise<T | undefined> => {
    try {
      return (await getEntry<T>(deps.store, key, deps.now(), 0, EXTERNAL_MAX_TTL_MS))?.value;
    } catch {
      return undefined;
    }
  };
  const write = async <T>(key: string, value: T, ttl: number) => {
    try {
      await setWithTtl(deps.store, key, value, ttl, deps.now(), EXTERNAL_MAX_TTL_MS);
    } catch {
      // 書けなくても続行
    }
  };

  const spotifyIdOf = async (mbid: string): Promise<string | null> => {
    const cached = await read<MbidEntry>(mbidKey(mbid));
    if (cached !== undefined) return cached.spotifyId;
    const a = await deps.mb.artist(mbid);
    const spotifyId = a?.spotifyArtistId ?? null;
    if (a !== null) await write<MbidEntry>(mbidKey(mbid), { spotifyId }, spotifyId === null ? MISS_TTL_MS : HIT_TTL_MS);
    return spotifyId;
  };

  return {
    async resolveArtist(artist) {
      const cached = await read<ArtistEntry>(artistKey(artist.id));
      if (cached !== undefined) return cached.mbid;
      const hits = await deps.mb.searchArtist(artist.name, 3);
      const wanted = normalizeName(artist.name);
      const top = hits[0];
      let mbid: string | null = null;
      const strong = hits.filter((h) => h.score >= AMBIGUOUS_SCORE);
      if (top !== undefined && strong.length <= 1 && top.score >= ACCEPT_SCORE && normalizeName(top.name) === wanted) {
        mbid = top.mbid;
      } else {
        for (const h of hits.filter((h) => h.score >= CANDIDATE_SCORE).slice(0, 3)) {
          const spotifyId = await spotifyIdOf(h.mbid);
          if (spotifyId === artist.id) {
            mbid = h.mbid;
            break;
          }
        }
        if (mbid === null && top !== undefined && strong.length <= 1 && top.score >= AMBIGUOUS_SCORE && normalizeName(top.name) === wanted) {
          mbid = top.mbid;
        }
      }
      if (mbid !== null) await write<MbidEntry>(mbidKey(mbid), { spotifyId: artist.id }, HIT_TTL_MS);
      await write<ArtistEntry>(artistKey(artist.id), { mbid }, mbid === null ? MISS_TTL_MS : HIT_TTL_MS);
      return mbid;
    },

    spotifyIdOf,

    async resolveRecording(track) {
      const isrc = track.external_ids?.isrc?.replace(/[^A-Za-z0-9]/g, '').toUpperCase() ?? '';
      if (isrc === '') return null;
      const cached = await read<IsrcEntry>(isrcKey(isrc));
      if (cached !== undefined) return cached.recordingMbid === null ? null : { recordingMbid: cached.recordingMbid, artistMbids: cached.artistMbids };
      const recs = await deps.mb.recordingsByIsrc(isrc);
      const first = recs[0];
      const entry: IsrcEntry = first === undefined ? { recordingMbid: null, artistMbids: [] } : { recordingMbid: first.mbid, artistMbids: first.artists.map((a) => a.mbid) };
      await write(isrcKey(isrc), entry, entry.recordingMbid === null ? MISS_TTL_MS : HIT_TTL_MS);
      return entry.recordingMbid === null ? null : { recordingMbid: entry.recordingMbid, artistMbids: entry.artistMbids };
    },
  };
}
