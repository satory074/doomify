import { describe, expect, it, vi } from 'vitest';
import { createThrottle, fakeFetch, fetchJson, shouldBackoff } from './http';

describe('fetchJson', () => {
  it('JSON を返し、非 2xx・パース失敗・例外は json=null', async () => {
    const ok = fakeFetch(() => ({ status: 200, body: { a: 1 } }));
    expect(await fetchJson(ok, 'https://x/')).toEqual({ status: 200, json: { a: 1 } });
    const bad = fakeFetch(() => ({ status: 503, body: {} }));
    expect((await fetchJson(bad, 'https://x/')).json).toBeNull();
    const boom = (async () => {
      throw new Error('net');
    }) as unknown as typeof fetch;
    expect(await fetchJson(boom, 'https://x/')).toEqual({ status: 0, json: null });
    expect(shouldBackoff(503)).toBe(true);
    expect(shouldBackoff(404)).toBe(false);
  });

  it('POST は JSON ボディと Content-Type を付ける', async () => {
    let seen: RequestInit | undefined;
    const f = fakeFetch((_u, init) => {
      seen = init;
      return { status: 200, body: [] };
    });
    await fetchJson(f, 'https://x/', { method: 'POST', body: [{ q: 1 }] });
    expect(seen?.method).toBe('POST');
    expect(seen?.body).toBe('[{"q":1}]');
    const headers = seen?.headers as Record<string, string> | undefined;
    expect(headers?.['Content-Type']).toBe('application/json');
  });
});

describe('createThrottle', () => {
  it('最小間隔と同時実行数を守り、backoff で止まる', async () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const now = () => t;
      const sleep = (ms: number) =>
        new Promise<void>((r) =>
          setTimeout(() => {
            t += ms;
            r();
          }, ms),
        );
      const th = createThrottle({ minSpacingMs: 1000, concurrency: 1, now, sleep, backoffMs: 5000 });
      const starts: number[] = [];
      const task = () => async () => {
        starts.push(t);
        return t;
      };
      const p = Promise.all([th.run(task()), th.run(task()), th.run(task())]);
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(starts).toEqual([0, 1000]);
      th.backoff();
      await vi.advanceTimersByTimeAsync(1000);
      expect(starts).toEqual([0, 1000]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(starts).toEqual([0, 1000, 6000]);
      await p;
      expect(th.pending()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('失敗したタスクは reject され、次のタスクは進む', async () => {
    const th = createThrottle({ minSpacingMs: 0, concurrency: 2 });
    await expect(
      th.run(async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(await th.run(async () => 7)).toBe(7);
  });
});
