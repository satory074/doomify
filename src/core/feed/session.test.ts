import { describe, expect, it } from 'vitest';
import {
  confidenceOf,
  createSession,
  dayKeyOf,
  dayPenalty,
  GLANCE_MS,
  interestOf,
  MAX_SESSION_ARTISTS,
  MIN_DWELL_MS,
  observeCard,
  SESSION_CONFIDENCE_CARDS,
  SESSION_GAMMA,
  SESSION_GAP_MS,
  sessionBoost,
  topInterests,
  touchSession,
} from './session';

const NOW = 1_700_000_000_000;

describe('session', () => {
  it('30 分空くと新しいセッション、それまでは同じ', () => {
    let s = createSession(NOW);
    s = observeCard(s, { artistId: 'a1', tags: ['j-pop'], dwellMs: 10_000, now: NOW + 1000 });
    expect(touchSession(s, NOW + 1000 + SESSION_GAP_MS - 1)).toBe(s);
    const fresh = touchSession(s, NOW + 1000 + SESSION_GAP_MS);
    expect(fresh.cards).toBe(0);
    expect(fresh.startedAt).toBe(NOW + 1000 + SESSION_GAP_MS);
  });

  it('滞在は一瞥(3 秒)を引いて下限つきで、アーティストと上位 3 タグに積まれる', () => {
    let s = createSession(NOW);
    s = observeCard(s, { artistId: 'a1', tags: ['t1', 't2', 't3', 't4'], dwellMs: 100, now: NOW });
    expect(s.totalDwellMs).toBe(MIN_DWELL_MS);
    expect(s.dwellByArtist.a1).toBe(MIN_DWELL_MS);
    expect(Object.keys(s.dwellByTag)).toEqual(['t1', 't2', 't3']);
    s = observeCard(s, { artistId: '', tags: [], dwellMs: GLANCE_MS + 1500, now: NOW + 1 });
    expect(s.cards).toBe(2);
    expect(s.totalDwellMs).toBe(2000);
    expect(s.lastAt).toBe(NOW + 1);
    // 素早いスワイプ(3 秒未満)は下限だけ
    s = observeCard(s, { artistId: 'a3', tags: ['t9'], dwellMs: 2500, now: NOW + 2 });
    expect(s.dwellByTag.t9).toBe(MIN_DWELL_MS);
  });

  it('興味はタグの滞在割合、アーティストは 2 倍で効く', () => {
    let s = createSession(NOW);
    s = observeCard(s, { artistId: 'a1', tags: ['city pop'], dwellMs: GLANCE_MS + 30_000, now: NOW });
    s = observeCard(s, { artistId: 'a2', tags: ['j-pop'], dwellMs: GLANCE_MS + 10_000, now: NOW });
    expect(interestOf(s, 'zz', ['city pop'])).toBeCloseTo(0.75);
    expect(interestOf(s, 'zz', ['j-pop'])).toBeCloseTo(0.25);
    expect(interestOf(s, 'a2', [])).toBeCloseTo(0.5);
    expect(interestOf(s, 'zz', ['unknown'])).toBe(0);
    expect(interestOf(createSession(NOW), 'a1', ['city pop'])).toBe(0);
  });

  it('確信度は 12 枚で 1、boost は興味 0 で 1・最大 e^γ', () => {
    let s = createSession(NOW);
    for (let i = 0; i < SESSION_CONFIDENCE_CARDS / 2; i++) s = observeCard(s, { artistId: 'a1', tags: ['x'], dwellMs: 1000, now: NOW });
    expect(confidenceOf(s)).toBeCloseTo(0.5);
    for (let i = 0; i < SESSION_CONFIDENCE_CARDS; i++) s = observeCard(s, { artistId: 'a1', tags: ['x'], dwellMs: 1000, now: NOW });
    expect(confidenceOf(s)).toBe(1);
    expect(sessionBoost(s, 'zz', ['other'])).toBe(1);
    expect(sessionBoost(s, 'zz', ['x'])).toBeCloseTo(Math.exp(SESSION_GAMMA));
    expect(topInterests(s)).toEqual([{ key: 'x', share: 1 }]);
  });

  it('アーティストは上限で滞在の小さい順に落ちる', () => {
    let s = createSession(NOW);
    for (let i = 0; i <= MAX_SESSION_ARTISTS; i++) s = observeCard(s, { artistId: `a${i}`, tags: [], dwellMs: GLANCE_MS + 1000 + i, now: NOW });
    expect(Object.keys(s.dwellByArtist)).toHaveLength(MAX_SESSION_ARTISTS);
    expect(s.dwellByArtist.a0).toBeUndefined();
    expect(s.dwellByArtist[`a${MAX_SESSION_ARTISTS}`]).toBe(1000 + MAX_SESSION_ARTISTS);
  });

  it('dayKeyOf はローカル日付、dayPenalty は 10 枚まで 1 → 0.9^k → 下限 0.4', () => {
    expect(dayKeyOf(new Date(2026, 8, 7, 12, 0, 0).getTime())).toBe('2026-09-07');
    expect(dayPenalty(0)).toBe(1);
    expect(dayPenalty(10)).toBe(1);
    expect(dayPenalty(11)).toBeCloseTo(0.9);
    expect(dayPenalty(13)).toBeCloseTo(0.729);
    expect(dayPenalty(100)).toBe(0.4);
  });
});
