import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../spotify/cache';
import { createHistory, FLUSH_DELAY_MS, HISTORY_KEY, SEEN_TTL_MS, type HistoryData } from './history';

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
