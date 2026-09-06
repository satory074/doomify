/** 裏で動く強化キュー。Spotify の種アーティスト → MBID → ListenBrainz の類似アーティスト・タグを集め、
 *  いいねした曲 → ISRC → 類似録音を集める。フィードの供給は一切ブロックしない(失敗は「無し」)。
 *  結果は IndexedDB に 30 日キャッシュ(Spotify コンテンツは含まない: MBID・名前・スコア・タグだけ) */
import type { ExternalStats } from '../external/http';
import type { LbSimilarArtist, LbSimilarRecording, LbTag, ListenBrainzClient } from '../external/listenbrainz';
import type { MusicBrainzClient } from '../external/musicbrainz';
import { EXTERNAL_MAX_TTL_MS, getEntry, setWithTtl, type KeyValueStore } from '../spotify/cache';
import type { Track } from '../spotify/types';
import { createIdentity, type Identity } from './identity';
import type { SeedArtist } from './sources';

export interface SimilarEntry {
  mbid: string;
  name: string;
  score: number;
  /** 0 始まりの順位(score 降順) */
  rank: number;
}

export interface SimilarTrackEntry {
  mbid: string;
  name: string;
  artistName: string;
  artistMbids: string[];
  score: number;
  rank: number;
}

export interface EnrichmentStats {
  mb: ExternalStats;
  lb: ExternalStats;
  resolvedArtists: number;
  unresolvedArtists: number;
  similarSeeds: number;
  similarEntries: number;
  taggedArtists: number;
  similarTracks: number;
  cacheHits: number;
}

export interface Enrichment {
  /** 種(hop 0)が更新されたら呼ぶ。重み順に MBID 解決 → 類似 → タグ */
  onSeeds(artists: readonly SeedArtist[]): void;
  /** いいね直後: ISRC → 類似録音 */
  onLiked(track: Track): void;
  /** hop 1 のアーティストが好評だったら、その先(hop 2 用の類似)を用意する */
  onPositive(artist: SeedArtist): void;
  /** 種 Spotify ID → まだ使っていない類似アーティスト(順位順) */
  similarOf(seedId: string): readonly SimilarEntry[];
  /** 類似エントリを持つ種の Spotify ID */
  seedsWithSimilar(): readonly string[];
  markUsed(seedId: string, mbid: string): void;
  similarTracksOf(trackId: string): readonly SimilarTrackEntry[];
  /** 類似録音を持つ曲の ID(いいねした順) */
  tracksWithSimilar(): readonly string[];
  markTrackUsed(trackId: string, mbid: string): void;
  /** onLiked で覚えた曲名(カードのラベル用) */
  trackNameOf(trackId: string): string | undefined;
  tagsOfMbid(mbid: string): readonly string[] | undefined;
  tagsOfSpotifyArtist(spotifyId: string): readonly string[] | undefined;
  mbidOfSpotifyArtist(spotifyId: string): string | undefined;
  /** 検索結果などから分かった MBID ↔ Spotify ID の対応を覚える */
  noteSpotifyArtist(mbid: string, spotifyId: string): void;
  /** 好みのタグ重み(最大 1 に正規化) */
  tagProfile(): ReadonlyMap<string, number>;
  /** 結果が増えたときの通知(onUpdate に加えて後から購読できる) */
  subscribe(listener: () => void): () => void;
  /** 進行中の処理が終わるまで待つ(テスト・診断用) */
  idle(): Promise<void>;
  stats(): EnrichmentStats;
  dispose(): void;
}

export interface EnrichmentDeps {
  mb: MusicBrainzClient;
  lb: ListenBrainzClient;
  store: KeyValueStore;
  now: () => number;
  enabled: () => boolean;
  onUpdate?: () => void;
  identity?: Identity;
  /** 解決する種の上限(既定 12) */
  maxSeeds?: number;
  /** 1 バッチで解決する種の数(既定 4)。最初の類似カードを早く出す */
  batchSize?: number;
  /** タグを引く類似アーティストの上限 / バッチ(既定 25) */
  topSimilarTags?: number;
}

export const similarKey = (mbid: string): string => `doomify:ext:similar:${mbid}`;
export const tagsKey = (mbid: string): string => `doomify:ext:tags:${mbid}`;
export const similarRecordingsKey = (mbid: string): string => `doomify:ext:simrec:${mbid}`;
const TTL = 30 * 24 * 60 * 60 * 1000;
export const TAGS_PER_ARTIST = 5;

export function createEnrichment(deps: EnrichmentDeps): Enrichment {
  const identity = deps.identity ?? createIdentity({ mb: deps.mb, store: deps.store, now: deps.now });
  const maxSeeds = deps.maxSeeds ?? 12;
  const batchSize = deps.batchSize ?? 4;
  const topSimilarTags = deps.topSimilarTags ?? 25;

  const mbidOfSpotify = new Map<string, string>();
  const spotifyOfMbid = new Map<string, string>();
  const similarByMbid = new Map<string, LbSimilarArtist[]>();
  const similar = new Map<string, SimilarEntry[]>();
  const used = new Set<string>();
  const tagsByMbid = new Map<string, LbTag[]>();
  const tagWeights = new Map<string, number>();
  const similarTracks = new Map<string, SimilarTrackEntry[]>();
  const trackNames = new Map<string, string>();
  const usedTracks = new Set<string>();
  const queued = new Set<string>();
  const positiveDone = new Set<string>();
  const likedDone = new Set<string>();
  let queuedCount = 0;
  let disposed = false;
  let chain: Promise<void> = Promise.resolve();
  const stats = { resolvedArtists: 0, unresolvedArtists: 0, similarTracks: 0, cacheHits: 0 };

  const listeners = new Set<() => void>();
  const enqueue = (task: () => Promise<void>) => {
    chain = chain.then(task).catch(() => {});
  };
  const notify = () => {
    deps.onUpdate?.();
    for (const l of listeners) l();
  };

  const readCache = async <T>(key: string): Promise<T | undefined> => {
    try {
      const hit = await getEntry<T>(deps.store, key, deps.now(), 0, EXTERNAL_MAX_TTL_MS);
      if (hit !== undefined) stats.cacheHits++;
      return hit?.value;
    } catch {
      return undefined;
    }
  };
  const writeCache = async <T>(key: string, value: T) => {
    try {
      await setWithTtl(deps.store, key, value, TTL, deps.now(), EXTERNAL_MAX_TTL_MS);
    } catch {
      // 書けなくても続行
    }
  };

  /** 類似アーティストをキャッシュ優先でまとめて引く */
  const loadSimilar = async (mbids: readonly string[]) => {
    const missing: string[] = [];
    for (const m of mbids) {
      if (similarByMbid.has(m)) continue;
      const cached = await readCache<LbSimilarArtist[]>(similarKey(m));
      if (cached !== undefined) similarByMbid.set(m, cached);
      else missing.push(m);
    }
    if (missing.length === 0) return;
    const fetched = await deps.lb.similarArtists(missing);
    for (const m of missing) {
      const list = fetched.get(m) ?? [];
      similarByMbid.set(m, list);
      await writeCache(similarKey(m), list);
    }
  };

  const loadTags = async (mbids: readonly string[]) => {
    const missing: string[] = [];
    for (const m of mbids) {
      if (tagsByMbid.has(m)) continue;
      const cached = await readCache<LbTag[]>(tagsKey(m));
      if (cached !== undefined) tagsByMbid.set(m, cached);
      else missing.push(m);
    }
    if (missing.length === 0) return;
    const fetched = await deps.lb.artistTags(missing);
    for (const m of missing) {
      const list = fetched.get(m) ?? [];
      tagsByMbid.set(m, list);
      await writeCache(tagsKey(m), list);
    }
  };

  const toEntries = (list: readonly LbSimilarArtist[]): SimilarEntry[] => list.map((s, rank) => ({ mbid: s.mbid, name: s.name, score: s.score, rank }));

  const absorbSeedTags = (seed: SeedArtist, tags: readonly LbTag[]) => {
    const total = tags.reduce((a, t) => a + t.count, 0);
    if (total <= 0) return;
    for (const t of tags.slice(0, TAGS_PER_ARTIST)) {
      tagWeights.set(t.tag, (tagWeights.get(t.tag) ?? 0) + Math.max(0.1, seed.weight) * (t.count / total));
    }
  };

  const processBatch = async (seeds: readonly SeedArtist[]) => {
    if (disposed || !deps.enabled()) return;
    const resolved: { seed: SeedArtist; mbid: string }[] = [];
    for (const seed of seeds) {
      if (disposed) return;
      const known = seed.mbid ?? mbidOfSpotify.get(seed.id);
      const mbid = known ?? (await identity.resolveArtist(seed));
      if (mbid === null || mbid === undefined) {
        stats.unresolvedArtists++;
        continue;
      }
      stats.resolvedArtists++;
      mbidOfSpotify.set(seed.id, mbid);
      spotifyOfMbid.set(mbid, seed.id);
      resolved.push({ seed, mbid });
    }
    if (resolved.length === 0 || disposed) return;
    await loadSimilar(resolved.map((r) => r.mbid));
    for (const r of resolved) similar.set(r.seed.id, toEntries(similarByMbid.get(r.mbid) ?? []));
    notify();
    await loadTags(resolved.map((r) => r.mbid));
    for (const r of resolved) absorbSeedTags(r.seed, tagsByMbid.get(r.mbid) ?? []);
    const similarMbids: string[] = [];
    for (const r of resolved) for (const e of similar.get(r.seed.id) ?? []) if (similarMbids.length < topSimilarTags) similarMbids.push(e.mbid);
    await loadTags(similarMbids);
    notify();
  };

  return {
    onSeeds(artists) {
      if (disposed || !deps.enabled()) return;
      const fresh = artists
        .filter((a) => (a.hop ?? 0) === 0 && !queued.has(a.id))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, Math.max(0, maxSeeds - queuedCount));
      if (fresh.length === 0) return;
      for (const a of fresh) queued.add(a.id);
      queuedCount += fresh.length;
      for (let i = 0; i < fresh.length; i += batchSize) {
        const batch = fresh.slice(i, i + batchSize);
        enqueue(() => processBatch(batch));
      }
    },

    onLiked(track) {
      if (disposed || !deps.enabled() || likedDone.has(track.id)) return;
      likedDone.add(track.id);
      trackNames.set(track.id, track.name);
      enqueue(async () => {
        const rec = await identity.resolveRecording(track);
        if (rec === null || disposed) return;
        let list = await readCache<LbSimilarRecording[]>(similarRecordingsKey(rec.recordingMbid));
        if (list === undefined) {
          list = (await deps.lb.similarRecordings([rec.recordingMbid])).get(rec.recordingMbid) ?? [];
          await writeCache(similarRecordingsKey(rec.recordingMbid), list);
        }
        if (list.length === 0) return;
        similarTracks.set(
          track.id,
          list.map((r, rank) => ({ mbid: r.mbid, name: r.name, artistName: r.artistName, artistMbids: r.artistMbids, score: r.score, rank })),
        );
        stats.similarTracks++;
        notify();
      });
    },

    onPositive(artist) {
      if (disposed || !deps.enabled()) return;
      const mbid = artist.mbid ?? mbidOfSpotify.get(artist.id);
      if (mbid === undefined || similar.has(artist.id) || positiveDone.has(artist.id)) return;
      positiveDone.add(artist.id);
      enqueue(async () => {
        await loadSimilar([mbid]);
        if (disposed) return;
        mbidOfSpotify.set(artist.id, mbid);
        spotifyOfMbid.set(mbid, artist.id);
        similar.set(artist.id, toEntries(similarByMbid.get(mbid) ?? []));
        notify();
      });
    },

    similarOf: (seedId) => (similar.get(seedId) ?? []).filter((e) => !used.has(`${seedId}:${e.mbid}`)),
    seedsWithSimilar: () => [...similar.keys()].filter((id) => (similar.get(id) ?? []).some((e) => !used.has(`${id}:${e.mbid}`))),
    markUsed(seedId, mbid) {
      used.add(`${seedId}:${mbid}`);
    },
    similarTracksOf: (trackId) => (similarTracks.get(trackId) ?? []).filter((e) => !usedTracks.has(`${trackId}:${e.mbid}`)),
    tracksWithSimilar: () => [...similarTracks.keys()].filter((id) => (similarTracks.get(id) ?? []).some((e) => !usedTracks.has(`${id}:${e.mbid}`))),
    markTrackUsed(trackId, mbid) {
      usedTracks.add(`${trackId}:${mbid}`);
    },
    trackNameOf: (trackId) => trackNames.get(trackId),
    tagsOfMbid: (mbid) => tagsByMbid.get(mbid)?.slice(0, TAGS_PER_ARTIST).map((t) => t.tag),
    tagsOfSpotifyArtist(spotifyId) {
      const mbid = mbidOfSpotify.get(spotifyId);
      return mbid === undefined ? undefined : tagsByMbid.get(mbid)?.slice(0, TAGS_PER_ARTIST).map((t) => t.tag);
    },
    mbidOfSpotifyArtist: (spotifyId) => mbidOfSpotify.get(spotifyId),
    noteSpotifyArtist(mbid, spotifyId) {
      mbidOfSpotify.set(spotifyId, mbid);
      spotifyOfMbid.set(mbid, spotifyId);
    },

    tagProfile() {
      let max = 0;
      for (const w of tagWeights.values()) max = Math.max(max, w);
      const out = new Map<string, number>();
      if (max <= 0) return out;
      for (const [tag, w] of tagWeights) out.set(tag, w / max);
      return out;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    idle: () => chain,

    stats: () => ({
      mb: deps.mb.stats(),
      lb: deps.lb.stats(),
      resolvedArtists: stats.resolvedArtists,
      unresolvedArtists: stats.unresolvedArtists,
      similarSeeds: similar.size,
      similarEntries: [...similar.values()].reduce((a, l) => a + l.length, 0),
      taggedArtists: tagsByMbid.size,
      similarTracks: stats.similarTracks,
      cacheHits: stats.cacheHits,
    }),

    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
