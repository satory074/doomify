import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, buildUrl, createApiClient, parseRetryAfterMs, type ApiClient } from './apiClient';

type FetchCall = { url: string; init: RequestInit };

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** 応答を順番に返す fetch。足りなければ最後の応答を繰り返す */
function scriptedFetch(responses: (Response | (() => Response | Promise<Response>))[]) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r === undefined) throw new Error('no response scripted');
    return typeof r === 'function' ? r() : r.clone();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function makeClient(
  fetchFn: typeof fetch,
  opts: { concurrency?: number; minSpacingMs?: number; getAccessToken?: ApiClientDepsToken } = {},
): { client: ApiClient; tokenCalls: ({ forceRefresh?: boolean } | undefined)[] } {
  const tokenCalls: ({ forceRefresh?: boolean } | undefined)[] = [];
  const client = createApiClient({
    getAccessToken: async (o) => {
      tokenCalls.push(o);
      return opts.getAccessToken ? opts.getAccessToken(o) : 'tok';
    },
    fetchFn,
    now: () => Date.now(),
    concurrency: opts.concurrency ?? 2,
    minSpacingMs: opts.minSpacingMs ?? 0,
  });
  return { client, tokenCalls };
}
type ApiClientDepsToken = (o?: { forceRefresh?: boolean }) => Promise<string>;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('buildUrl / parseRetryAfterMs', () => {
  it('undefined のクエリは省き、値は文字列化する', () => {
    expect(buildUrl('https://api.spotify.com/v1', '/search', { q: 'a b', limit: 10, market: undefined })).toBe(
      'https://api.spotify.com/v1/search?q=a+b&limit=10',
    );
  });
  it('Retry-After 秒 → ms', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('x')).toBeNull();
  });
});

describe('request', () => {
  it('Bearer を付けて GET し JSON を返す', async () => {
    const { fn, calls } = scriptedFetch([jsonRes(200, { id: 'me' })]);
    const { client } = makeClient(fn);
    const me = await client.request<{ id: string }>({ method: 'GET', path: '/me' });
    expect(me).toEqual({ id: 'me' });
    expect(calls[0]?.url).toBe('https://api.spotify.com/v1/me');
    const headers = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe('Bearer tok');
  });

  it('204 は undefined、body は JSON で送る', async () => {
    const { fn, calls } = scriptedFetch([new Response(null, { status: 204 })]);
    const { client } = makeClient(fn);
    const r = await client.request({ method: 'PUT', path: '/me/player/play', query: { device_id: 'd' }, body: { uris: ['u'] } });
    expect(r).toBeUndefined();
    expect(calls[0]?.url).toBe('https://api.spotify.com/v1/me/player/play?device_id=d');
    expect(calls[0]?.init.body).toBe('{"uris":["u"]}');
  });

  it('401 はトークンを強制更新して 1 回だけ再試行する', async () => {
    const { fn, calls } = scriptedFetch([jsonRes(401, { error: { status: 401, message: 'expired' } }), jsonRes(200, { ok: true })]);
    const { client, tokenCalls } = makeClient(fn);
    expect(await client.request({ method: 'GET', path: '/me' })).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(tokenCalls).toEqual([undefined, { forceRefresh: true }]);
  });

  it('2 連続 401 は unauthorized', async () => {
    const { fn } = scriptedFetch([jsonRes(401, { error: { message: 'bad' } })]);
    const { client } = makeClient(fn);
    const err = await client.request({ method: 'GET', path: '/me' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('unauthorized');
  });

  it('404 の reason を保持する', async () => {
    const { fn } = scriptedFetch([jsonRes(404, { error: { status: 404, message: 'Device not found', reason: 'NO_ACTIVE_DEVICE' } })]);
    const { client } = makeClient(fn);
    const err = (await client.request({ method: 'PUT', path: '/me/player/play' }).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('not_found');
    expect(err.reason).toBe('NO_ACTIVE_DEVICE');
  });

  it('ネットワーク失敗は network、abort は aborted', async () => {
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const { client } = makeClient(failing);
    const err = (await client.request({ method: 'GET', path: '/me' }).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('network');

    const ac = new AbortController();
    ac.abort();
    const { fn } = scriptedFetch([jsonRes(200, {})]);
    const { client: c2 } = makeClient(fn);
    const err2 = (await c2.request({ method: 'GET', path: '/me', signal: ac.signal }).catch((e: unknown) => e)) as ApiError;
    expect(err2.code).toBe('aborted');
  });
});

describe('429 ゲート', () => {
  it('Retry-After の間は全リクエストが待ち、その後 1 回再試行して成功する', async () => {
    const { fn, calls } = scriptedFetch([
      jsonRes(429, { error: { status: 429, message: 'Too many' } }, { 'Retry-After': '2' }),
      jsonRes(200, { first: true }),
      jsonRes(200, { second: true }),
    ]);
    const { client } = makeClient(fn, { concurrency: 1 });
    const infos: { reason: string }[] = [];
    client.onRateLimit((i) => infos.push(i));

    const p1 = client.request({ method: 'GET', path: '/a' });
    const p2 = client.request({ method: 'GET', path: '/b' });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(1);
    expect(infos).toEqual([{ untilMs: expect.any(Number) as number, reason: 'retry-after' }]);
    expect(client.rateLimitedUntil()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toHaveLength(1); // まだ待っている
    await vi.advanceTimersByTimeAsync(600);
    expect(await p1).toEqual({ first: true });
    expect(await p2).toEqual({ second: true });
    expect(calls).toHaveLength(3);
    expect(client.stats().rateLimits).toBe(1);
  });

  it('QUOTA_EXCEEDED は 60 秒以上ゲートし reason は quota。2 連続なら rate_limited を投げる', async () => {
    const { fn, calls } = scriptedFetch([
      jsonRes(429, { error: { status: 429, message: 'quota', reason: 'QUOTA_EXCEEDED' } }, { 'Retry-After': '1' }),
    ]);
    const { client } = makeClient(fn);
    const infos: { reason: string; untilMs: number }[] = [];
    client.onRateLimit((i) => infos.push(i));
    const start = Date.now();
    const p = client.request({ method: 'GET', path: '/a' });
    const rejected = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = (await rejected) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('rate_limited');
    expect(err.reason).toBe('QUOTA_EXCEEDED');
    expect(infos[0]?.reason).toBe('quota');
    expect((infos[0]?.untilMs ?? 0) - start).toBeGreaterThanOrEqual(60_000);
  });
});

describe('優先度・キャッシュ・並列', () => {
  it('playback > action > feed の順に実行する', async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const { fn, calls } = scriptedFetch([
      () => gate.then(() => jsonRes(200, { n: 0 })),
      jsonRes(200, { n: 1 }),
    ]);
    const { client } = makeClient(fn, { concurrency: 1 });
    const first = client.request({ method: 'GET', path: '/first' });
    await vi.advanceTimersByTimeAsync(0);
    const feed = client.request({ method: 'GET', path: '/feed', priority: 'feed' });
    const action = client.request({ method: 'GET', path: '/action', priority: 'action' });
    const playback = client.request({ method: 'GET', path: '/playback', priority: 'playback' });
    releaseFirst();
    await Promise.all([first, feed, action, playback]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/first', '/v1/playback', '/v1/action', '/v1/feed']);
  });

  it('cacheTtlMs 付き GET は 2 回目をキャッシュから返し、同時要求は 1 回の fetch を共有する', async () => {
    const { fn, calls } = scriptedFetch([jsonRes(200, { v: 1 })]);
    const { client } = makeClient(fn);
    const [a, b] = await Promise.all([
      client.request({ method: 'GET', path: '/x', cacheTtlMs: 10_000 }),
      client.request({ method: 'GET', path: '/x', cacheTtlMs: 10_000 }),
    ]);
    expect(a).toEqual({ v: 1 });
    expect(b).toEqual({ v: 1 });
    expect(calls).toHaveLength(1);
    expect(await client.request({ method: 'GET', path: '/x', cacheTtlMs: 10_000 })).toEqual({ v: 1 });
    expect(calls).toHaveLength(1);
    expect(client.stats().cacheHits).toBe(1);
  });

  it('同時実行数と最小間隔を守る', async () => {
    const times: number[] = [];
    const fn = (async () => {
      times.push(Date.now());
      await new Promise((r) => setTimeout(r, 50));
      return jsonRes(200, {});
    }) as unknown as typeof fetch;
    const { client } = makeClient(fn, { concurrency: 2, minSpacingMs: 100 });
    const ps = [1, 2, 3, 4].map((i) => client.request({ method: 'GET', path: `/${i}` }));
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(ps);
    expect(times).toHaveLength(4);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(100);
    }
  });
});
