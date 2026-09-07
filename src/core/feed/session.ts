/** セッション(ひと続きの聴取)の状態。TikTok(WSJ の実験: 視聴時間だけで 40 分〜2 時間で狭まる)・Monolith(オンライン学習)・
 *  Phoenix(直近の行動シーケンスが主入力)の写し: このセッションでどのタグ・アーティストに長く居たかを興味とし、
 *  カード数が増えるほど(確信が上がるほど)その興味を強く効かせる。
 *  同日に見たタグの回数は Algo 101 の「同じ日に見たカテゴリを減点」。純関数、React 非依存 */

/** これだけ操作が空いたら新しいセッション */
export const SESSION_GAP_MS = 30 * 60_000;
/** この枚数で確信度 1.0 */
export const SESSION_CONFIDENCE_CARDS = 12;
/** boost = exp(GAMMA × 確信度 × 興味) */
export const SESSION_GAMMA = 1.2;
/** 一瞥(この時間までは興味と見なさない。早期スキップの閾値と同じ) */
export const GLANCE_MS = 3000;
/** 滞在の下限(スワイプの速さの差を残しつつ 0 を避ける) */
export const MIN_DWELL_MS = 500;
export const MAX_SESSION_ARTISTS = 100;
export const MAX_SESSION_TAGS = 50;
/** 1 枚のカードで興味に数えるタグの上限 */
export const TAGS_PER_CARD = 3;
/** 同日にこの枚数までは減点なし */
export const DAY_PENALTY_FREE = 10;
export const DAY_PENALTY_DECAY = 0.9;
export const DAY_PENALTY_FLOOR = 0.4;

export interface SessionState {
  startedAt: number;
  /** 最後にカードを観測した時刻 */
  lastAt: number;
  /** 観測したカード数 */
  cards: number;
  totalDwellMs: number;
  dwellByArtist: Record<string, number>;
  dwellByTag: Record<string, number>;
}

export function createSession(now: number): SessionState {
  return { startedAt: now, lastAt: now, cards: 0, totalDwellMs: 0, dwellByArtist: {}, dwellByTag: {} };
}

/** 空き時間が閾値を超えていれば新しいセッション、そうでなければそのまま */
export function touchSession(s: SessionState, now: number): SessionState {
  return now - s.lastAt >= SESSION_GAP_MS ? createSession(now) : s;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

function trimTo(record: Record<string, number>, max: number): Record<string, number> {
  const entries = Object.entries(record);
  if (entries.length <= max) return record;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, max));
}

/** カードを観測する(離脱時)。一瞥を差し引いた滞在をアーティストとタグ(上位 3 つ)に積む */
export function observeCard(s: SessionState, i: { artistId: string; tags: readonly string[]; dwellMs: number; now: number }): SessionState {
  const dwell = Math.max(MIN_DWELL_MS, (Number.isFinite(i.dwellMs) ? i.dwellMs : 0) - GLANCE_MS);
  const dwellByArtist = { ...s.dwellByArtist };
  if (i.artistId !== '') dwellByArtist[i.artistId] = (dwellByArtist[i.artistId] ?? 0) + dwell;
  const dwellByTag = { ...s.dwellByTag };
  for (const t of i.tags.slice(0, TAGS_PER_CARD)) dwellByTag[t] = (dwellByTag[t] ?? 0) + dwell;
  return {
    startedAt: s.startedAt,
    lastAt: i.now,
    cards: s.cards + 1,
    totalDwellMs: s.totalDwellMs + dwell,
    dwellByArtist: trimTo(dwellByArtist, MAX_SESSION_ARTISTS),
    dwellByTag: trimTo(dwellByTag, MAX_SESSION_TAGS),
  };
}

/** このセッションでの興味 0..1: タグ最大の滞在割合と、アーティスト滞在割合の 2 倍の大きい方 */
export function interestOf(s: SessionState, artistId: string, tags: readonly string[]): number {
  if (s.totalDwellMs <= 0) return 0;
  let best = 0;
  for (const t of tags) best = Math.max(best, s.dwellByTag[t] ?? 0);
  if (artistId !== '') best = Math.max(best, 2 * (s.dwellByArtist[artistId] ?? 0));
  return clamp01(best / s.totalDwellMs);
}

export function confidenceOf(s: SessionState): number {
  return Math.min(1, Math.max(0, s.cards / SESSION_CONFIDENCE_CARDS));
}

/** 候補への乗数 ∈ [1, e^GAMMA] */
export function sessionBoost(s: SessionState, artistId: string, tags: readonly string[]): number {
  return Math.exp(SESSION_GAMMA * confidenceOf(s) * interestOf(s, artistId, tags));
}

/** 診断用: 滞在割合の大きいタグ */
export function topInterests(s: SessionState, limit = 3): { key: string; share: number }[] {
  if (s.totalDwellMs <= 0) return [];
  return Object.entries(s.dwellByTag)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, ms]) => ({ key, share: clamp01(ms / s.totalDwellMs) }));
}

/** ローカル日付 YYYY-MM-DD */
export function dayKeyOf(now: number): string {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 同日にそのタグを見た枚数による乗数(10 枚までは 1、以降 0.9^k、下限 0.4) */
export function dayPenalty(count: number): number {
  const over = Math.max(0, count - DAY_PENALTY_FREE);
  return Math.max(DAY_PENALTY_FLOOR, Math.pow(DAY_PENALTY_DECAY, over));
}
