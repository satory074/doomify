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

/** 年代レンジ。新しいほど重くする */
export function pickYearRange(rng: Rng, currentYear: number): YearRange | null {
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
  return pickWeighted(rng, ranges, (r) => r.weight)?.range ?? null;
}

export function pickGenre(rng: Rng, preferred: readonly string[], fallback: readonly string[] = DEFAULT_GENRES): string | undefined {
  // 好みのジャンルがあれば 3/4 の確率でそこから、残りは全体から(マンネリ防止)
  if (preferred.length > 0 && rng() < 0.75) return pickOne(rng, preferred);
  return pickOne(rng, fallback);
}

/** search の q に使う形。ジャンル名にスペースがあるので引用符で囲む */
export function genreQuery(genre: string, years: YearRange | null): string {
  const g = `genre:"${genre.replace(/"/g, '')}"`;
  if (years === null) return g;
  return years.from === years.to ? `${g} year:${years.from}` : `${g} year:${years.from}-${years.to}`;
}
