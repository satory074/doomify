import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../spotify/cache';
import { createHistory, FLUSH_DELAY_MS, HISTORY_KEY, migrateHistory, SEEN_TTL_MS, type HistoryData } from './history';

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

  it('v1 の保存データを v2 に移行する', () => {
    const migrated = migrateHistory({ version: 1, seen: { t1: { at: 1, action: 'liked' } }, artistAffinity: { a1: 2 } });
    expect(migrated?.version).toBe(2);
    expect(migrated?.seen.t1?.action).toBe('liked');
    expect(migrated?.artistAffinity.a1).toBe(2);
    expect(migrated?.tagAffinity).toEqual({});
    expect(migrated?.exploration.cooldownLeft).toBe(0);
    expect(migrateHistory({ version: 3, seen: {} })).toBeNull();
    expect(migrateHistory('junk')).toBeNull();
  });
});
