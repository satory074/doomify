/** Spotify Web API クライアント。
 *  - Bearer 付与、401 → トークン強制更新して 1 回再試行
 *  - 429 → Retry-After(QUOTA_EXCEEDED は 60 秒以上)の共通ゲート。全リクエストが待つ。1 回だけ再試行
 *  - 優先度キュー(playback > action > feed)、同時実行数と最小間隔で開発モードのレート制限に配慮。
 *    playback は同時実行数 +1 の専用枠で最小間隔も免除(再生要求を feed の取得の後ろで待たせない)
 *  - GET は短命キャッシュ + 同一リクエストの in-flight 共有
 *  React 非依存。fetch / now / sleep は注入可能 */
import { SyncTtlCache } from './cache';

export type Priority = 'playback' | 'action' | 'feed';
const PRIORITY_ORDER: Record<Priority, number> = { playback: 0, action: 1, feed: 2 };

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'network'
  | 'server'
  | 'aborted'
  | 'other';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** Spotify の error.reason(例: NO_ACTIVE_DEVICE, PREMIUM_REQUIRED, QUOTA_EXCEEDED) */
  readonly reason: string | null;
  readonly retryAfterMs: number | null;

  constructor(code: ApiErrorCode, status: number, message: string, reason: string | null = null, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RateLimitInfo {
  untilMs: number;
  reason: 'retry-after' | 'quota';
}

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE';

export interface ApiRequest {
  method: HttpMethod;
  /** '/me/player/play' のように baseUrl からの相対パス */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** 既定 feed */
  priority?: Priority;
  /** GET のみ。ミリ秒(最長 24h に丸められる) */
  cacheTtlMs?: number;
  signal?: AbortSignal;
}

export interface ApiClientStats {
  requests: number;
  cacheHits: number;
  rateLimits: number;
}

export interface ApiClient {
  request<T>(req: ApiRequest): Promise<T>;
  onRateLimit(cb: (info: RateLimitInfo) => void): () => void;
  rateLimitedUntil(): number | null;
  stats(): ApiClientStats;
}

export interface ApiClientDeps {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 同時実行数(既定 2) */
  concurrency?: number;
  /** リクエスト開始の最小間隔 ms(既定 150) */
  minSpacingMs?: number;
  baseUrl?: string;
  /** QUOTA_EXCEEDED 時の最低ゲート ms(既定 60 秒) */
  quotaGateMs?: number;
  /** Retry-After ヘッダが無い 429 の待ち ms(既定 5 秒) */
  defaultRetryAfterMs?: number;
}

export const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

interface Job {
  req: ApiRequest;
  prio: number;
  seq: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  retried401: boolean;
  retried429: boolean;
  forceRefresh: boolean;
}

interface SpotifyErrorBody {
  error?: { status?: number; message?: string; reason?: string };
}

function mapStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'bad_request';
  if (status >= 500) return 'server';
  return 'other';
}

export function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.ceil(seconds * 1000);
}

export function buildUrl(baseUrl: string, path: string, query?: ApiRequest['query']): string {
  const url = new URL(path.startsWith('/') ? `${baseUrl}${path}` : `${baseUrl}/${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const concurrency = deps.concurrency ?? 2;
  const minSpacingMs = deps.minSpacingMs ?? 150;
  const baseUrl = deps.baseUrl ?? SPOTIFY_API_BASE;
  const quotaGateMs = deps.quotaGateMs ?? 60_000;
  const defaultRetryAfterMs = deps.defaultRetryAfterMs ?? 5_000;

  const cache = new SyncTtlCache();
  const inflight = new Map<string, Promise<unknown>>();
  const listeners = new Set<(info: RateLimitInfo) => void>();
  const queue: Job[] = [];
  const stats: ApiClientStats = { requests: 0, cacheHits: 0, rateLimits: 0 };
  let seq = 0;
  let active = 0;
  let lastStartAt = Number.NEGATIVE_INFINITY;
  let gateUntil = 0;
  let pumping = false;
  /** 間隔待ちで眠っている pump を起こす(playback が積まれたとき) */
  let wake: (() => void) | null = null;

  const cacheKeyOf = (req: ApiRequest): string | null =>
    req.method === 'GET' && req.cacheTtlMs !== undefined && req.cacheTtlMs > 0
      ? buildUrl(baseUrl, req.path, req.query)
      : null;

  const setGate = (untilMs: number, reason: RateLimitInfo['reason']) => {
    if (untilMs <= gateUntil) return;
    gateUntil = untilMs;
    stats.rateLimits++;
    for (const l of listeners) l({ untilMs, reason });
  };

  const safeJson = async (res: Response): Promise<SpotifyErrorBody | null> => {
    try {
      return (await res.json()) as SpotifyErrorBody;
    } catch {
      return null;
    }
  };

  const execute = async (job: Job): Promise<unknown> => {
    const { req } = job;
    if (req.signal?.aborted) throw new ApiError('aborted', 0, 'aborted');

    const key = cacheKeyOf(req);
    if (key !== null) {
      const hit = cache.get<unknown>(key, now());
      if (hit !== undefined) {
        stats.cacheHits++;
        return hit;
      }
    }

    const token = await deps.getAccessToken(job.forceRefresh ? { forceRefresh: true } : undefined);
    const hasBody = req.body !== undefined;
    let res: Response;
    try {
      res = await fetchFn(buildUrl(baseUrl, req.path, req.query), {
        method: req.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(req.body) : undefined,
        signal: req.signal,
      });
    } catch (e) {
      if (isAbortError(e) || req.signal?.aborted) throw new ApiError('aborted', 0, 'aborted');
      throw new ApiError('network', 0, e instanceof Error ? e.message : String(e));
    }
    stats.requests++;

    if (res.status === 401 && !job.retried401) {
      job.retried401 = true;
      job.forceRefresh = true;
      return execute(job);
    }

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('Retry-After')) ?? defaultRetryAfterMs;
      const body = await safeJson(res);
      const reason = body?.error?.reason ?? null;
      const isQuota = reason === 'QUOTA_EXCEEDED';
      const until = now() + (isQuota ? Math.max(retryAfterMs, quotaGateMs) : retryAfterMs);
      setGate(until, isQuota ? 'quota' : 'retry-after');
      if (!job.retried429) {
        job.retried429 = true;
        await sleep(Math.max(0, gateUntil - now()));
        return execute(job);
      }
      throw new ApiError('rate_limited', 429, body?.error?.message ?? 'rate limited', reason, retryAfterMs);
    }

    if (res.status === 204 || res.status === 202) return undefined;

    if (!res.ok) {
      const body = await safeJson(res);
      throw new ApiError(
        mapStatus(res.status),
        res.status,
        body?.error?.message ?? `HTTP ${res.status}`,
        body?.error?.reason ?? null,
      );
    }

    const text = await res.text();
    if (text === '') return undefined;
    const data: unknown = JSON.parse(text);
    if (key !== null && req.cacheTtlMs !== undefined) cache.set(key, data, req.cacheTtlMs, now());
    return data;
  };

  const run = async (job: Job) => {
    try {
      job.resolve(await execute(job));
    } catch (e) {
      job.reject(e);
    }
  };

  const wakeSignal = () =>
    new Promise<void>((r) => {
      wake = r;
    });

  const isPlayback = (job: Job) => job.prio === PRIORITY_ORDER.playback;
  /** playback は通常の枠が埋まっていても 1 本だけ追加で走らせる */
  const limitFor = (job: Job) => (isPlayback(job) ? concurrency + 1 : concurrency);

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const head = queue[0];
        if (head === undefined) break;
        if (head.req.signal?.aborted) {
          queue.shift();
          head.reject(new ApiError('aborted', 0, 'aborted'));
          continue;
        }
        if (active >= limitFor(head)) break;
        const t = now();
        const wait = Math.max(gateUntil - t, isPlayback(head) ? 0 : lastStartAt + minSpacingMs - t, 0);
        if (wait > 0) {
          await Promise.race([sleep(wait), wakeSignal()]);
          wake = null;
          continue;
        }
        queue.shift();
        active++;
        if (!isPlayback(head)) lastStartAt = now();
        void run(head).finally(() => {
          active--;
          void pump();
        });
      }
    } finally {
      pumping = false;
    }
  };

  const enqueue = (req: ApiRequest): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      const job: Job = {
        req,
        prio: PRIORITY_ORDER[req.priority ?? 'feed'],
        seq: seq++,
        resolve,
        reject,
        retried401: false,
        retried429: false,
        forceRefresh: false,
      };
      queue.push(job);
      queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      if (isPlayback(job) && wake !== null) {
        const w = wake;
        wake = null;
        w();
      }
      void pump();
    });

  return {
    request<T>(req: ApiRequest): Promise<T> {
      const key = cacheKeyOf(req);
      if (key !== null) {
        const hit = cache.get<T>(key, now());
        if (hit !== undefined) {
          stats.cacheHits++;
          return Promise.resolve(hit);
        }
        const shared = inflight.get(key);
        if (shared !== undefined) return shared as Promise<T>;
        const p = enqueue(req).finally(() => {
          inflight.delete(key);
        });
        inflight.set(key, p);
        return p as Promise<T>;
      }
      return enqueue(req) as Promise<T>;
    },
    onRateLimit(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    rateLimitedUntil: () => (gateUntil > now() ? gateUntil : null),
    stats: () => ({ ...stats }),
  };
}
