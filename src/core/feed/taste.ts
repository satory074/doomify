/** 好みのプロファイル(既知アーティスト・年代)と候補のスコアリング。React 非依存の純 TS。
 *  「未知」= 主アーティストが既知集合に無い。既知集合はユーザー自身のデータ(top/saved/recent/following/自分のプレイリスト)から作る */
import type { Track } from '../spotify/types';
import type { YearRange } from './genres';
import type { Candidate } from './sources';

export interface TasteProfile {
  knownArtistIds: Set<string>;
  /** 正規化したアーティスト名(外部データ由来の名前照合に使う) */
  knownArtistNames: Set<string>;
  /** 年 → 既知曲数 */
  years: Map<number, number>;
  yearTotal: number;
}

export function createTasteProfile(): TasteProfile {
  return { knownArtistIds: new Set(), knownArtistNames: new Set(), years: new Map(), yearTotal: 0 };
}

/** 表記ゆれを吸収した名前(NFKC・小文字・記号と空白を除去) */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

export function absorbArtists(profile: TasteProfile, artists: readonly { id: string; name: string }[]): void {
  for (const a of artists) {
    profile.knownArtistIds.add(a.id);
    const n = normalizeName(a.name);
    if (n !== '') profile.knownArtistNames.add(n);
  }
}

export function yearOfTrack(track: Pick<Track, 'album'>): number | null {
  const m = /^(\d{4})/.exec(track.album.release_date ?? '');
  const y = m?.[1] === undefined ? Number.NaN : Number(m[1]);
  return Number.isFinite(y) ? y : null;
}

/** ユーザー自身の曲(既知)を取り込む: アーティストと年代 */
export function absorbKnownTracks(profile: TasteProfile, tracks: readonly Pick<Track, 'artists' | 'album'>[]): void {
  for (const t of tracks) {
    absorbArtists(profile, t.artists);
    const y = yearOfTrack(t);
    if (y === null) continue;
    profile.years.set(y, (profile.years.get(y) ?? 0) + 1);
    profile.yearTotal++;
  }
}

export function isKnownArtistId(profile: TasteProfile, id: string): boolean {
  return profile.knownArtistIds.has(id);
}

export function isKnownArtistName(profile: TasteProfile, name: string): boolean {
  return profile.knownArtistNames.has(normalizeName(name));
}

/** 主アーティストが既知なら true */
export function isKnownArtist(profile: TasteProfile, track: Pick<Track, 'artists'>): boolean {
  const primary = track.artists[0];
  if (primary === undefined) return false;
  return isKnownArtistId(profile, primary.id) || isKnownArtistName(profile, primary.name);
}

export function hasEra(profile: TasteProfile): boolean {
  return profile.yearTotal >= 5;
}

/** 既知曲のうち、そのレンジに入る割合 0..1 */
export function eraShare(profile: TasteProfile, range: YearRange): number {
  if (profile.yearTotal === 0) return 0;
  let n = 0;
  for (const [y, c] of profile.years) if (y >= range.from && y <= range.to) n += c;
  return n / profile.yearTotal;
}

/** 候補の年代が好みの年代に近いほど 1 に近づく(0.7..1.0)。年代データが無ければ 1 */
export function eraFit(profile: TasteProfile, track: Pick<Track, 'album'>): number {
  if (!hasEra(profile)) return 1;
  const y = yearOfTrack(track);
  if (y === null) return 1;
  const share = eraShare(profile, { from: y - 3, to: y + 3 });
  return 0.7 + 0.3 * Math.min(1, share * 3);
}

/** 候補アーティストのタグと好みのタグ重み(最大 1 に正規化)の適合 0..1。判定できなければ null */
export function tagFit(candidateTags: readonly string[] | undefined, tagProfile: ReadonlyMap<string, number>): number | null {
  if (candidateTags === undefined || candidateTags.length === 0 || tagProfile.size === 0) return null;
  let best = 0;
  let sum = 0;
  for (const t of candidateTags) {
    const w = tagProfile.get(t) ?? 0;
    best = Math.max(best, w);
    sum += w;
  }
  const mean = sum / candidateTags.length;
  return Math.min(1, 0.7 * best + 0.3 * mean);
}

export const DEFAULT_SIMILARITY = 0.6;

export interface ScoreInput {
  candidate: Candidate;
  artistAffinity: number;
  seedAffinity: number;
  tagFit: number | null;
  eraFit: number;
  sameAlbumRecently: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 抽選の重み。類似順位 × タグ適合 × 年代適合 × アーティスト親和度 × 種の親和度 × 同一アルバム減点 */
export function scoreCandidate(i: ScoreInput): number {
  let s = i.candidate.similarity ?? DEFAULT_SIMILARITY;
  if (i.tagFit !== null) s *= 0.5 + 0.5 * i.tagFit;
  s *= clamp(i.eraFit, 0, 1);
  s *= Math.exp(0.25 * clamp(i.artistAffinity, -5, 10));
  s *= Math.exp(0.3 * clamp(i.seedAffinity, -3, 5));
  if (i.sameAlbumRecently) s *= 0.8;
  return s;
}
