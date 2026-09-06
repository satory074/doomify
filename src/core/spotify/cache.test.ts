import { describe, expect, it } from 'vitest';
import { clampTtl, EXTERNAL_MAX_TTL_MS, getEntry, getFresh, MAX_TTL_MS, MemoryStore, setWithTtl, SyncTtlCache } from './cache';

const HOUR = 3_600_000;

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
  it('setWithTtl は保存時刻(storedAt)も書く', async () => {
    const s = new MemoryStore();
    await setWithTtl(s, 'a', 1, 500, 1000);
    expect(await s.get('a')).toEqual({ value: 1, expiresAt: 1500, storedAt: 1000 });
  });
});

describe('getEntry(stale-while-revalidate)', () => {
  it('期限内は fresh、期限切れでも保存から 24h 以内なら stale として返す', async () => {
    const s = new MemoryStore();
    await setWithTtl(s, 'a', { x: 1 }, 2 * HOUR, 0);
    expect(await getEntry(s, 'a', HOUR)).toEqual({ value: { x: 1 }, fresh: true, ageMs: HOUR });
    expect(await getEntry(s, 'a', 3 * HOUR)).toEqual({ value: { x: 1 }, fresh: false, ageMs: 3 * HOUR });
    expect(await getEntry(s, 'a', MAX_TTL_MS)).toEqual({ value: { x: 1 }, fresh: false, ageMs: MAX_TTL_MS });
    expect(await getEntry(s, 'a', MAX_TTL_MS + 1)).toBeUndefined();
    expect(await getFresh(s, 'a', 3 * HOUR)).toBeUndefined();
  });
  it('stale の猶予(maxAgeMs)は指定でき、24h で頭打ち', async () => {
    const s = new MemoryStore();
    await setWithTtl(s, 'a', 1, HOUR, 0);
    expect(await getEntry(s, 'a', 90 * 60_000, 2 * HOUR)).toMatchObject({ fresh: false });
    expect(await getEntry(s, 'a', 5 * HOUR, 2 * HOUR)).toBeUndefined();
    expect(await getEntry(s, 'a', 23 * HOUR, 48 * HOUR)).toMatchObject({ fresh: false });
    expect(await getEntry(s, 'a', 25 * HOUR, 48 * HOUR)).toBeUndefined();
  });
  it('storedAt の無い旧エントリは期限内のときだけ使う', async () => {
    const s = new MemoryStore();
    await s.set('legacy', { value: 'v', expiresAt: 1000 });
    expect(await getEntry(s, 'legacy', 999)).toEqual({ value: 'v', fresh: true, ageMs: 0 });
    expect(await getEntry(s, 'legacy', 1000)).toBeUndefined();
  });
  it('壊れたエントリ・無いキーは undefined', async () => {
    const s = new MemoryStore();
    await s.set('broken', 'not-an-entry');
    await s.set('noexp', { value: 1 });
    expect(await getEntry(s, 'broken', 0)).toBeUndefined();
    expect(await getEntry(s, 'noexp', 0)).toBeUndefined();
    expect(await getEntry(s, 'missing', 0)).toBeUndefined();
  });
});

describe('外部データの長い TTL', () => {
  it('maxTtlMs を渡すと 24h を超えて fresh のまま', async () => {
    const store = new MemoryStore();
    const day = 24 * 60 * 60 * 1000;
    await setWithTtl(store, 'ext', { v: 1 }, 30 * day, 0, EXTERNAL_MAX_TTL_MS);
    expect((await getEntry(store, 'ext', 10 * day, day, EXTERNAL_MAX_TTL_MS))?.fresh).toBe(true);
    await setWithTtl(store, 'sp', { v: 1 }, 30 * day, 0);
    expect((await getEntry(store, 'sp', 10 * day))).toBeUndefined();
  });
});
