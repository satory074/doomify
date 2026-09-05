import { describe, expect, it } from 'vitest';
import { clampTtl, getFresh, MAX_TTL_MS, MemoryStore, setWithTtl, SyncTtlCache } from './cache';

describe('SyncTtlCache', () => {
  it('TTL 内は返し、超えたら消える', () => {
    const c = new SyncTtlCache();
    c.set('k', 1, 1000, 0);
    expect(c.get('k', 999)).toBe(1);
    expect(c.get('k', 1000)).toBeUndefined();
    expect(c.size).toBe(0);
  });
  it('TTL は 24 時間で頭打ち', () => {
    expect(clampTtl(MAX_TTL_MS * 10)).toBe(MAX_TTL_MS);
    expect(clampTtl(-5)).toBe(0);
  });
});

describe('getFresh / setWithTtl', () => {
  it('KeyValueStore 上で TTL 付き保存できる', async () => {
    const s = new MemoryStore();
    await setWithTtl(s, 'a', { x: 1 }, 500, 0);
    expect(await getFresh(s, 'a', 499)).toEqual({ x: 1 });
    expect(await getFresh(s, 'a', 500)).toBeUndefined();
    expect(await getFresh(s, 'missing', 0)).toBeUndefined();
  });
});
