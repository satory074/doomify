/** 発見用のジャンル語彙。artist.genres は API から消える前提なので、静的な一覧を土台にし、
 *  ユーザーが設定で選んだものと(返ってくれば)トップアーティストの genres を混ぜる */
import { pickOne, pickWeighted, type Rng } from './rng';

export const DEFAULT_GENRES: readonly string[] = [
  'j-pop',
  'city pop',
  'j-rock',
  'anime',
  'shibuya-kei',
  'vocaloid',
  'k-pop',
  'pop',
  'indie pop',
  'indie rock',
  'alternative rock',
  'shoegaze',
  'dream pop',
  'post-rock',
  'math rock',
  'punk',
  'emo',
  'metal',
  'hip hop',
  'japanese hip hop',
  'r&b',
  'neo soul',
  'soul',
  'funk',
  'disco',
  'house',
  'techno',
  'ambient',
  'lo-fi',
  'electronica',
  'idm',
  'drum and bass',
  'jazz',
  'bossa nova',
  'classical',
  'folk',
  'singer-songwriter',
  'country',
  'latin',
  'reggae',
];

export interface YearRange {
  from: number;
  to: number;
}

export interface WeightedGenre {
  genre: string;
  weight: number;
  /** tag: 聴取データ由来(ListenBrainz のタグ)、chip: ユーザーが設定で選んだ */
  source?: 'tag' | 'chip';
}

/** 年代レンジ。新しいほど重くする。eraShare(そのレンジに入る既知曲の割合 0..1)があれば、聴いている年代を厚くする */
export function pickYearRange(rng: Rng, currentYear: number, eraShare?: (range: YearRange) => number): YearRange | null {
  const ranges: { range: YearRange | null; weight: number }[] = [
    { range: null, weight: 3 }, // 指定なし
    { range: { from: currentYear - 1, to: currentYear }, weight: 3 },
    { range: { from: currentYear - 5, to: currentYear - 2 }, weight: 3 },
    { range: { from: 2010, to: Math.max(2010, currentYear - 6) }, weight: 2 },
    { range: { from: 2000, to: 2009 }, weight: 1.5 },
    { range: { from: 1990, to: 1999 }, weight: 1.2 },
    { range: { from: 1980, to: 1989 }, weight: 1 },
    { range: { from: 1970, to: 1979 }, weight: 0.6 },
  ];
  const weightOf = (r: { range: YearRange | null; weight: number }) =>
    r.range === null || eraShare === undefined ? r.weight : r.weight * (0.3 + 3 * Math.min(1, Math.max(0, eraShare(r.range))));
  return pickWeighted(rng, ranges, weightOf)?.range ?? null;
}

export function pickGenre(rng: Rng, preferred: readonly string[], fallback: readonly string[] = DEFAULT_GENRES): string | undefined {
  // 好みのジャンルがあれば 3/4 の確率でそこから、残りは全体から(マンネリ防止)
  if (preferred.length > 0 && rng() < 0.75) return pickOne(rng, preferred);
  return pickOne(rng, fallback);
}

/** 個人化されたジャンル(タグ重み)があれば 3/4 の確率で重み付き抽選、残りは語彙全体から */
export function pickWeightedGenre(
  rng: Rng,
  weighted: readonly WeightedGenre[],
  fallback: readonly string[] = DEFAULT_GENRES,
): { genre: string; personalized: boolean; source?: 'tag' | 'chip' } | undefined {
  if (weighted.length > 0 && rng() < 0.75) {
    const w = pickWeighted(rng, weighted, (g) => g.weight);
    if (w !== undefined) return { genre: w.genre, personalized: true, source: w.source };
  }
  const g = pickOne(rng, fallback);
  return g === undefined ? undefined : { genre: g, personalized: false };
}

/** search の q に使う形。ジャンル名にスペースがあるので引用符で囲む */
export function genreQuery(genre: string, years: YearRange | null): string {
  const g = `genre:"${genre.replace(/"/g, '')}"`;
  if (years === null) return g;
  return years.from === years.to ? `${g} year:${years.from}` : `${g} year:${years.from}-${years.to}`;
}
