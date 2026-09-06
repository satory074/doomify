/** 補充計画と抽選の純粋ロジック(API を呼ばない)。
 *  - bucketWeights: 発見度 d からバケット(known/adjacent/discover)の抽選重みを決める
 *  - planRefill: 予算(API 呼び出し回数)内で、足りないバケットを埋める戦略の並びを決める
 *  - 重複判定・同一アーティスト間隔 */
import type { AlbumRef, Track } from '../spotify/types';
import { pickWeighted, type Rng } from './rng';
import type { Bucket } from './types';

export type Strategy =
  | 'saved_random'
  | 'playlist_random'
  | 'deep_cut'
  | 'appears_on'
  | 'similar_artist'
  | 'bridge'
  | 'similar_track'
  | 'genre_search'
  | 'tag_new'
  | 'tag_hipster';

export const ALL_STRATEGIES: readonly Strategy[] = [
  'saved_random',
  'playlist_random',
  'deep_cut',
  'appears_on',
  'similar_artist',
  'bridge',
  'similar_track',
  'genre_search',
  'tag_new',
  'tag_hipster',
];

/** 戦略 1 回あたりの Spotify API 呼び出し回数(外部 API は数えない) */
export const STRATEGY_COST: Record<Strategy, number> = {
  saved_random: 1,
  playlist_random: 1,
  deep_cut: 2,
  appears_on: 2,
  similar_artist: 1,
  bridge: 1,
  similar_track: 2,
  genre_search: 1,
  tag_new: 2,
  tag_hipster: 2,
};

export const STRATEGY_BUCKET: Record<Strategy, Bucket> = {
  saved_random: 'known',
  playlist_random: 'known',
  deep_cut: 'adjacent',
  appears_on: 'adjacent',
  similar_artist: 'discover',
  bridge: 'discover',
  similar_track: 'discover',
  genre_search: 'discover',
  tag_new: 'discover',
  tag_hipster: 'discover',
};

/** 戦略 1 回で期待できる候補数(計画時の見積り) */
export const EXPECTED_YIELD: Record<Strategy, number> = {
  saved_random: 40,
  playlist_random: 30,
  deep_cut: 4,
  appears_on: 5,
  similar_artist: 4,
  bridge: 3,
  similar_track: 2,
  genre_search: 8,
  tag_new: 3,
  tag_hipster: 3,
};

const BUCKETS: readonly Bucket[] = ['known', 'adjacent', 'discover'];

/** 1 回の計画で同じ戦略を使える回数(安価で収量の多いものだけ 2 回) */
export const MAX_PER_PLAN: Record<Strategy, number> = {
  saved_random: 1,
  playlist_random: 1,
  deep_cut: 1,
  appears_on: 1,
  similar_artist: 2,
  bridge: 1,
  similar_track: 1,
  genre_search: 2,
  tag_new: 1,
  tag_hipster: 1,
};

export function bucketWeights(discovery: number): Record<Bucket, number> {
  const d = Math.min(1, Math.max(0, Number.isFinite(discovery) ? discovery : 0));
  const known = Math.max(0.2, 1 - d);
  const rest = 1 - known;
  // 発見度が高いほど discover 寄り(adjacent : discover = 1:1 → 1:2)
  const discoverShare = 0.5 + 0.17 * d;
  return { known, adjacent: rest * (1 - discoverShare), discover: rest * discoverShare };
}

export interface PlanInput {
  discovery: number;
  /** 使える API 呼び出し回数 */
  budget: number;
  rateLimited: boolean;
  poolSizes: Record<Bucket, number>;
  /** 1 回の補充で追加したい件数 */
  target: number;
  availability: Record<Strategy, boolean>;
  /** 直前に使った戦略(同じものの連発を避ける) */
  recent: readonly Strategy[];
  rng: Rng;
  /** バンディットがサンプルした戦略の重み θ(既定 1) */
  strategyWeight?: (s: Strategy) => number;
  /** 補充しないバケット(クールダウン中の discover など) */
  excludeBuckets?: readonly Bucket[];
}

export function planRefill(input: PlanInput): Strategy[] {
  if (input.rateLimited || input.budget <= 0) return [];
  const weights = bucketWeights(input.discovery);
  // プールは目標の 2 倍を維持したい
  const deficit: Record<Bucket, number> = {
    known: weights.known * input.target * 2 - input.poolSizes.known,
    adjacent: weights.adjacent * input.target * 2 - input.poolSizes.adjacent,
    discover: weights.discover * input.target * 2 - input.poolSizes.discover,
  };
  const byBucket: Record<Bucket, Strategy[]> = {
    known: ['saved_random', 'playlist_random'],
    adjacent: ['deep_cut', 'appears_on'],
    discover: ['similar_artist', 'similar_track', 'bridge', 'genre_search', 'tag_new', 'tag_hipster'],
  };
  const excluded = new Set(input.excludeBuckets ?? []);
  const theta = input.strategyWeight ?? (() => 1);
  const plan: Strategy[] = [];
  let budget = input.budget;
  for (let guard = 0; guard < 12 && budget > 0; guard++) {
    const candidates = BUCKETS.filter((b) => deficit[b] > 0 && weights[b] > 0 && !excluded.has(b));
    if (candidates.length === 0) break;
    const bucket = pickWeighted(input.rng, candidates, (b) => deficit[b] * weights[b]) ?? candidates[0];
    if (bucket === undefined) break;
    const options = byBucket[bucket].filter(
      (s) => input.availability[s] && STRATEGY_COST[s] <= budget && plan.filter((p) => p === s).length < MAX_PER_PLAN[s],
    );
    if (options.length === 0) {
      deficit[bucket] = 0;
      continue;
    }
    const fresh = options.filter((s) => !input.recent.includes(s));
    const strategy = pickWeighted(input.rng, fresh.length > 0 ? fresh : options, (s) => Math.max(0.01, theta(s)) * (EXPECTED_YIELD[s] / STRATEGY_COST[s]));
    if (strategy === undefined) break;
    plan.push(strategy);
    budget -= STRATEGY_COST[strategy];
    deficit[bucket] -= EXPECTED_YIELD[strategy];
  }
  return plan;
}

/** 「(feat. X)」「- Remastered 2011」などの飾りを落として、同じ曲の別版を同一視する */
export function normalizeTitle(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*[([][^)\]]*(feat\.?|ft\.?|with |remaster|version|edit|mix|live|acoustic|instrumental|demo|mono|stereo|deluxe|bonus)[^)\]]*[)\]]/g, '')
    .replace(/\s+-\s+(remaster(ed)?|.*version|.*edit|.*mix|live|feat\.?|ft\.?|mono|stereo|single|radio|album|bonus|deluxe|from|instrumental)\b.*$/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function dedupeKey(track: Pick<Track, 'name' | 'artists'>): string {
  return `${normalizeTitle(track.name)}|${track.artists[0]?.id ?? ''}`;
}

/** 直近 n 枚に同じアルバムがあれば true(禁止ではなく減点に使う) */
export function sameAlbumRecently(
  track: { album: Pick<AlbumRef, 'id'> },
  recent: readonly { track: { album: Pick<AlbumRef, 'id'> } }[],
  n: number,
): boolean {
  if (n <= 0) return false;
  return recent.slice(-n).some((it) => it.track.album.id === track.album.id);
}

/** 直近 spacing 枚に同じアーティストがいれば true */
export function violatesArtistSpacing(
  track: Pick<Track, 'artists'>,
  recent: readonly { track: Pick<Track, 'artists'> }[],
  spacing: number,
): boolean {
  if (spacing <= 0) return false;
  const ids = new Set(track.artists.map((a) => a.id));
  return recent.slice(-spacing).some((it) => it.track.artists.some((a) => ids.has(a.id)));
}
