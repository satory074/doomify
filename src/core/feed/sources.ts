/** フィードの「種」を集める。ユーザー本人のデータ(トップ曲・保存曲・フォロー・最近再生・自分のプレイリスト)。
 *  各 1 コール。IndexedDB に短期キャッシュし、期限切れでも 24h 以内なら stale として先に使い、裏で再取得する(stale-while-revalidate)。
 *  ソースは届いた順に集約へ合流し、曲を含む最初の 1 本で `first` が解決する(最初のカードを残りの種で待たせない) */
import { getEntry, setWithTtl, type KeyValueStore } from '../spotify/cache';
import type { SpotifyApi } from '../spotify/endpoints';
import type { Artist, CurrentUser, FollowedArtists, Paging, PlayHistoryItem, Playlist, SavedTrackItem, Track } from '../spotify/types';
import type { Strategy } from './scheduler';
import type { FeedReason, SeedRef } from './types';

export interface Candidate {
  track: Track;
  reason: FeedReason;
  reasonDetail?: string;
  /** 候補を作った戦略 */
  strategy?: Strategy;
  /** 類似・橋渡しの元になった種 */
  seed?: SeedRef;
  /** 種からの距離(0: 既知、1: 類似、2: 類似の類似) */
  hop?: number;
  /** 類似度 0..1(類似順位から。無ければ既定値で扱う) */
  similarity?: number;
}

export interface SeedArtist {
  id: string;
  name: string;
  weight: number;
  /** 種からの距離(既定 0 = ユーザー自身のデータ由来) */
  hop?: number;
  /** MusicBrainz ID(解決済みなら) */
  mbid?: string;
  /** hop ≥ 1 のとき、たどってきた元の種 */
  from?: SeedRef;
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
  /** 取得に失敗した種の数(表示・診断用。キャッシュも無かったものだけ数える) */
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

export const seedCacheKey = (name: string): string => `doomify:pool:${name}:v1`;

function isPlayableTrack(t: Track | null | undefined): t is Track {
  return !!t && typeof t.id === 'string' && t.id !== '' && t.is_local !== true && (t.type === undefined || t.type === 'track');
}

/** 各ソースの生の応答。届いた分だけ埋まる */
interface SourceValues {
  me?: CurrentUser;
  topShort?: Paging<Track>;
  topMedium?: Paging<Track>;
  topLong?: Paging<Track>;
  topArtists?: Paging<Artist>;
  following?: FollowedArtists;
  saved?: Paging<SavedTrackItem>;
  playlists?: Paging<Playlist>;
  recent?: { items: PlayHistoryItem[] };
}

type SourceName = keyof SourceValues;

interface SourceSpec {
  name: SourceName;
  cacheName: string;
  ttlMs: number;
  fetch: (api: SpotifyApi) => Promise<unknown>;
  set: (values: SourceValues, value: unknown) => void;
}

function source<K extends SourceName>(
  name: K,
  cacheName: string,
  ttlMs: number,
  fetch: (api: SpotifyApi) => Promise<NonNullable<SourceValues[K]>>,
): SourceSpec {
  return {
    name,
    cacheName,
    ttlMs,
    fetch,
    set: (values, value) => {
      values[name] = value as SourceValues[K];
    },
  };
}

/** ネットワーク要求の順序 = この並び。曲が直接手に入る 3 本を先頭に(apiClient のキューは同一優先度なら FIFO)。
 *  キャッシュキー名は以前の loadSeeds と同じ(既存の IndexedDB エントリを生かす) */
const SOURCES: readonly SourceSpec[] = [
  source('topShort', 'top:tracks:short', POOL_TTL.top, (api) => api.topTracks('short_term')),
  source('saved', 'saved:0', POOL_TTL.saved, (api) => api.savedTracks(50, 0)),
  source('recent', 'recent', POOL_TTL.recent, (api) => api.recentlyPlayed(50)),
  source('topArtists', 'top:artists:medium', POOL_TTL.top, (api) => api.topArtists('medium_term')),
  source('topMedium', 'top:tracks:medium', POOL_TTL.top, (api) => api.topTracks('medium_term')),
  source('following', 'following', POOL_TTL.following, (api) => api.followedArtists()),
  source('topLong', 'top:tracks:long', POOL_TTL.top, (api) => api.topTracks('long_term')),
  source('playlists', 'playlists', POOL_TTL.playlists, (api) => api.myPlaylists(50, 0)),
  source('me', 'me', POOL_TTL.me, (api) => api.me()),
];

export const SEED_SOURCE_COUNT = SOURCES.length;

/** 届いている応答から集約を作る(純関数。更新のたびに作り直すので、stale → fresh と 2 回届いても重みが二重加算されない) */
function assembleSeeds(v: SourceValues, failures: number): Seeds {
  const known: Candidate[] = [];
  const artistWeight = new Map<string, SeedArtist>();
  const bump = (a: { id: string; name: string }, w: number) => {
    const cur = artistWeight.get(a.id);
    if (cur) cur.weight += w;
    else artistWeight.set(a.id, { id: a.id, name: a.name, weight: w });
  };

  for (const paging of [v.topShort, v.topMedium, v.topLong]) {
    for (const t of paging?.items ?? []) {
      if (!isPlayableTrack(t)) continue;
      known.push({ track: t, reason: 'top' });
      for (const a of t.artists) bump(a, 1);
    }
  }
  for (const item of v.saved?.items ?? []) {
    if (!isPlayableTrack(item.track)) continue;
    known.push({ track: item.track, reason: 'saved' });
    for (const a of item.track.artists) bump(a, 0.5);
  }
  for (const item of v.recent?.items ?? []) {
    if (!isPlayableTrack(item.track)) continue;
    known.push({ track: item.track, reason: 'recent' });
    for (const a of item.track.artists) bump(a, 0.5);
  }

  const topArtistItems = v.topArtists?.items ?? [];
  topArtistItems.forEach((a, i) => bump(a, 3 - (i / Math.max(1, topArtistItems.length)) * 1.5));
  for (const a of v.following?.artists.items ?? []) bump(a, 2);

  const genres = new Set<string>();
  for (const a of topArtistItems) for (const g of a.genres ?? []) genres.add(g);

  const userId = v.me?.id ?? null;
  const ownPlaylists: OwnPlaylist[] = (v.playlists?.items ?? [])
    .filter((p) => (userId !== null && p.owner.id === userId) || p.collaborative)
    .map((p) => ({ id: p.id, name: p.name, total: p.items?.total ?? p.tracks?.total ?? 0 }))
    .filter((p) => p.total > 0);

  return {
    known,
    artists: [...artistWeight.values()].sort((a, b) => b.weight - a.weight),
    genres: [...genres],
    playlists: ownPlaylists,
    savedTotal: v.saved?.total ?? 0,
    userId,
    failures,
  };
}

export interface SeedLoad {
  /** 曲を 1 件以上含む最初のソースが届いた時点(全て失敗なら全確定時点)で解決 */
  first: Promise<Seeds>;
  /** 全ソース(stale の裏再取得も含む)が確定した時点で解決。reject しない */
  done: Promise<Seeds>;
}

export interface SeedLoadOptions {
  /** 種が増える・更新されるたびに、その時点の集約を渡す。final は全確定 */
  onUpdate?: (seeds: Seeds, final: boolean) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 種の取得を始める。
 *  1. キャッシュ相: 全ソースの IDB エントリを読み、fresh も stale も集約に入れて 1 回通知(ゼロコール)
 *  2. ネットワーク相: 無かったもの・stale だったものを SOURCES の順に取得し、届くたびに通知。書き込み失敗は失敗に数えない */
export function startSeeds(deps: SourceDeps, opts: SeedLoadOptions = {}): SeedLoad {
  const values: SourceValues = {};
  let failures = 0;
  let firstResolved = false;
  const first = deferred<Seeds>();
  const done = deferred<Seeds>();

  const publish = (final: boolean) => {
    const seeds = assembleSeeds(values, failures);
    opts.onUpdate?.(seeds, final);
    if (!firstResolved && (final || seeds.known.length > 0)) {
      firstResolved = true;
      first.resolve(seeds);
    }
    if (final) done.resolve(seeds);
  };

  const readCache = async (spec: SourceSpec) => {
    try {
      return await getEntry<unknown>(deps.store, seedCacheKey(spec.cacheName), deps.now());
    } catch {
      return undefined;
    }
  };

  const fetchSource = async (spec: SourceSpec, hadValue: boolean) => {
    let value: unknown;
    try {
      value = await spec.fetch(deps.api);
    } catch {
      if (!hadValue) failures++;
      return;
    }
    spec.set(values, value);
    publish(false);
    try {
      await setWithTtl(deps.store, seedCacheKey(spec.cacheName), value, spec.ttlMs, deps.now());
    } catch {
      // 書き込めなくても取得した値は使う(プライベートモード等)
    }
  };

  const run = async () => {
    const hits = await Promise.all(SOURCES.map(readCache));
    const pending: { spec: SourceSpec; hadValue: boolean }[] = [];
    let anyHit = false;
    SOURCES.forEach((spec, i) => {
      const hit = hits[i];
      if (hit !== undefined) {
        anyHit = true;
        spec.set(values, hit.value);
      }
      if (hit === undefined || !hit.fresh) pending.push({ spec, hadValue: hit !== undefined });
    });
    if (pending.length === 0) {
      publish(true);
      return;
    }
    if (anyHit) publish(false);
    await Promise.all(pending.map(({ spec, hadValue }) => fetchSource(spec, hadValue)));
    publish(true);
  };

  void run().catch(() => {
    const seeds = assembleSeeds(values, failures);
    first.resolve(seeds);
    done.resolve(seeds);
  });

  return { first: first.promise, done: done.promise };
}

/** 全確定まで待つ従来形(テスト・互換用) */
export function loadSeeds(deps: SourceDeps): Promise<Seeds> {
  return startSeeds(deps).done;
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
