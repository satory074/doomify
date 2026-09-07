import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../spotify/cache';
import { ACTION_ARTISTS_MAX, createHistory, FLUSH_DELAY_MS, HISTORY_KEY, migrateHistory, SEEN_TTL_MS, type HistoryData } from './history';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createHistory', () => {
  it('record → has、TTL を過ぎたら has は false', () => {
    const h = createHistory(new MemoryStore());
    h.record('t1', 'played', ['a1'], 1000);
    expect(h.has('t1', 2000)).toBe(true);
    expect(h.has('t1', 1000 + SEEN_TTL_MS)).toBe(false);
    expect(h.has('unknown', 0)).toBe(false);
  });

  it('親和度: liked +2 / skipped -1 / played +0.2、範囲内に収まる', () => {
    const h = createHistory(new MemoryStore());
    h.record('t1', 'liked', ['a1'], 1);
    h.record('t2', 'skipped', ['a1'], 2);
    h.record('t3', 'played', ['a1'], 3);
    expect(h.affinity('a1')).toBeCloseTo(1.2);
    for (let i = 0; i < 20; i++) h.record(`s${i}`, 'skipped', ['a2'], i);
    expect(h.affinity('a2')).toBe(-5);
  });

  it('liked は後の played/skipped で上書きされない', () => {
    const h = createHistory(new MemoryStore());
    h.record('t1', 'liked', [], 1);
    h.record('t1', 'skipped', [], 2);
    expect(h.actionOf('t1')).toBe('liked');
    expect(h.likedIds()).toEqual(['t1']);
  });

  it('書き込みは 1 秒でまとめて永続化し、load で復元できる', async () => {
    const store = new MemoryStore();
    const h = createHistory(store);
    h.record('t1', 'played', ['a1'], 1);
    h.record('t2', 'liked', ['a1'], 2);
    expect(await store.get(HISTORY_KEY)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    const saved = await store.get<HistoryData>(HISTORY_KEY);
    expect(Object.keys(saved?.seen ?? {})).toEqual(['t1', 't2']);

    const h2 = createHistory(store);
    await h2.load();
    expect(h2.has('t2', 3)).toBe(true);
    expect(h2.affinity('a1')).toBeCloseTo(2.2);
  });

  it('reset で消える', async () => {
    const store = new MemoryStore();
    const h = createHistory(store);
    h.record('t1', 'played', [], 1);
    await h.flush();
    await h.reset();
    expect(h.size()).toBe(0);
    expect(await store.get(HISTORY_KEY)).toBeUndefined();
  });
});

describe('feedback(v2)', () => {
  it('報酬でアーティスト・タグ・種・戦略を学習し、seen の action を導く', () => {
    const h = createHistory(new MemoryStore());
    h.feedback({ trackId: 't1', reward: 1, artistIds: ['a1'], tags: ['j-pop', 'anime', 'pop', 'extra'], seedId: 's1', strategy: 'similar_artist', bucket: 'discover', liked: true, now: 1 });
    expect(h.affinity('a1')).toBeCloseTo(2);
    expect(h.tagAffinity('j-pop')).toBeCloseTo(0.5);
    expect(h.tagAffinity('extra')).toBe(0);
    expect(h.seedAffinity('s1')).toBeCloseTo(0.5);
    expect(h.strategyStats().similar_artist?.a).toBeGreaterThan(3);
    expect(h.actionOf('t1')).toBe('liked');
    h.feedback({ trackId: 't1', reward: -1, artistIds: ['a1'], now: 2 });
    expect(h.actionOf('t1')).toBe('liked');
    h.feedback({ trackId: 't2', reward: -1, artistIds: ['a1'], strategy: 'tag_hipster', bucket: 'discover', now: 3 });
    expect(h.actionOf('t2')).toBe('skipped');
    expect(h.strategyStats().tag_hipster?.b).toBeGreaterThan(3);
    h.feedback({ trackId: 't3', reward: 0, artistIds: [], now: 4 });
    expect(h.actionOf('t3')).toBe('played');
    expect(h.recent()).toHaveLength(4);
    h.feedback({ trackId: 't1', reward: -0.5, artistIds: [], unliked: true, now: 5 });
    expect(h.actionOf('t1')).toBe('played');
    expect(h.likedIds()).toEqual([]);
  });

  it('avoid / deadTag は期限つき、exploration は保存される', async () => {
    const store = new MemoryStore();
    const h = createHistory(store);
    h.avoid('a9', 100);
    h.markDeadTag('weird', 100);
    h.setExploration({ ema: 0.4, earlySkipStreak: 1, cooldownLeft: 2 });
    expect(h.isAvoided('a9', 50)).toBe(true);
    expect(h.isAvoided('a9', 100)).toBe(false);
    expect(h.isDeadTag('weird', 99)).toBe(true);
    await h.flush();
    const h2 = createHistory(store);
    await h2.load();
    expect(h2.exploration()).toEqual({ ema: 0.4, earlySkipStreak: 1, cooldownLeft: 2 });
  });

  it('v1 / v2 の保存データを v3 に移行する(無いフィールドは既定値)', () => {
    const migrated = migrateHistory({ version: 1, seen: { t1: { at: 1, action: 'liked' } }, artistAffinity: { a1: 2 } });
    expect(migrated?.version).toBe(3);
    expect(migrated?.seen.t1?.action).toBe('liked');
    expect(migrated?.artistAffinity.a1).toBe(2);
    expect(migrated?.tagAffinity).toEqual({});
    expect(migrated?.exploration.cooldownLeft).toBe(0);
    expect(migrated?.actions.global).toEqual({ n: 0, k: {}, at: 0 });
    expect(migrated?.trials).toEqual({});
    expect(migrated?.session.cards).toBe(0);
    expect(migrated?.session.dayTags).toEqual({});
    const v2 = migrateHistory({ version: 2, seen: {}, tagAffinity: { 'j-pop': 1 }, recent: [], actions: { global: 'broken', artist: { a1: { n: 2, k: { like: 1 }, at: 5 }, a2: 'junk' } } });
    expect(v2?.version).toBe(3);
    expect(v2?.tagAffinity['j-pop']).toBe(1);
    expect(v2?.actions.global).toEqual({ n: 0, k: {}, at: 0 });
    expect(v2?.actions.artist.a1?.k.like).toBe(1);
    expect(v2?.actions.artist.a2).toBeUndefined();
    expect(migrateHistory({ version: 4, seen: {} })).toBeNull();
    expect(migrateHistory('junk')).toBeNull();
  });
});

describe('v3(行動計数・試験・セッション)', () => {
  it('exposure / observe が global・戦略・タグ・主アーティストの計数を増やし、取り消しは 0 未満にならない', () => {
    const h = createHistory(new MemoryStore());
    h.exposure({ artistIds: ['a1', 'a2'], tags: ['j-pop', 'anime'], strategy: 'similar_artist', now: 10 });
    h.observe({ action: 'like', artistIds: ['a1', 'a2'], tags: ['j-pop', 'anime'], strategy: 'similar_artist', now: 11 });
    expect(h.actionCounts('global').n).toBeCloseTo(1);
    expect(h.actionCounts('global').k.like).toBe(1);
    expect(h.actionCounts('strategy', 'similar_artist')?.n).toBeCloseTo(1);
    expect(h.actionCounts('tag', 'anime')?.k.like).toBe(1);
    expect(h.actionCounts('artist', 'a1')?.k.like).toBe(1);
    expect(h.actionCounts('artist', 'a2')).toBeUndefined();
    h.observe({ action: 'like', delta: -1, artistIds: ['a1'], now: 12 });
    h.observe({ action: 'like', delta: -1, artistIds: ['a1'], now: 13 });
    expect(h.actionCounts('artist', 'a1')?.k.like).toBeUndefined();
    expect(h.actionCounts('global').k.like).toBeUndefined();
    expect(h.actionCounts('artist', 'a1')?.at).toBe(13);
  });

  it('試験状態とセッションは保存され、日付が変わると同日タグ回数が空になる', async () => {
    const store = new MemoryStore();
    const h = createHistory(store);
    const day1 = new Date(2026, 8, 7, 12).getTime();
    const day2 = new Date(2026, 8, 8, 1).getTime();
    h.setTrial('a1', { stage: 1, shown: 1, at: day1 });
    h.exposure({ artistIds: ['a1'], tags: ['j-pop', 'anime', 'pop', 'extra'], now: day1 });
    h.exposure({ artistIds: ['a2'], tags: ['j-pop'], now: day1 + 1 });
    expect(h.session().dayTags).toEqual({ 'j-pop': 2, anime: 1, pop: 1 });
    h.setSession({ startedAt: day1, lastAt: day1 + 1, cards: 2, totalDwellMs: 5000, dwellByArtist: { a1: 5000 }, dwellByTag: { 'j-pop': 5000 } });
    await h.flush();
    const h2 = createHistory(store);
    await h2.load();
    expect(h2.trialOf('a1')).toEqual({ stage: 1, shown: 1, at: day1 });
    expect(h2.trials()).toEqual({ a1: { stage: 1, shown: 1, at: day1 } });
    expect(h2.session().cards).toBe(2);
    expect(h2.session().dwellByTag['j-pop']).toBe(5000);
    expect(h2.session().dayTags['j-pop']).toBe(2);
    h2.touchDay(day1 + 1000);
    expect(h2.session().dayTags['j-pop']).toBe(2);
    h2.touchDay(day2);
    expect(h2.session().dayTags).toEqual({});
    expect(h2.session().cards).toBe(2);
  });

  it('アーティストの計数は上限を超えると古い順に落ちる', () => {
    const h = createHistory(new MemoryStore());
    const total = Math.floor(ACTION_ARTISTS_MAX * 1.2) + 1;
    for (let i = 0; i < total; i++) h.exposure({ artistIds: [`a${i}`], now: i + 1 });
    expect(h.actionCounts('artist', 'a0')).toBeUndefined();
    expect(h.actionCounts('artist', `a${total - 1}`)?.n).toBe(1);
    expect(h.actionCounts('global').n).toBeCloseTo(total, 0);
  });
});
