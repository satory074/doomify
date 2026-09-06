/** 外部 API(MusicBrainz / ListenBrainz)向けの薄い fetch と、同時実行数・最小間隔・バックオフを守るスロットル。
 *  投げない: 失敗は status と json=null で返す。React 非依存、fetch / now / sleep は注入可能 */

export type FetchLike = typeof fetch;

export interface ExternalStats {
  requests: number;
  failures: number;
  backoffs: number;
}

export interface JsonResponse<T> {
  status: number;
  json: T | null;
}

export interface JsonRequest {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 12_000;

/** JSON を取りに行く。ネットワーク・タイムアウト・パース失敗は status 0 で返す */
export async function fetchJson<T>(fetchFn: FetchLike, url: string, req: JsonRequest = {}): Promise<JsonResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchFn(url, {
      method: req.method ?? 'GET',
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: controller.signal,
    });
    if (!res.ok) return { status: res.status, json: null };
    try {
      return { status: res.status, json: (await res.json()) as T };
    } catch {
      return { status: res.status, json: null };
    }
  } catch {
    return { status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
}

export interface ThrottleDeps {
  /** リクエスト開始の最小間隔 ms */
  minSpacingMs: number;
  concurrency: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** backoff() で止める時間(既定 10 秒) */
  backoffMs?: number;
}

export interface Throttle {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** 503 / 429 の後に呼ぶ。次の開始を backoffMs だけ遅らせる */
  backoff(): void;
  pending(): number;
}

export function createThrottle(deps: ThrottleDeps): Throttle {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoffMs = deps.backoffMs ?? 10_000;
  const queue: (() => void)[] = [];
  let active = 0;
  let nextAllowedAt = 0;
  let pumping = false;

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0 && active < deps.concurrency) {
        const wait = nextAllowedAt - now();
        if (wait > 0) {
          await sleep(wait);
          continue;
        }
        const start = queue.shift();
        if (start === undefined) break;
        nextAllowedAt = now() + deps.minSpacingMs;
        active++;
        start();
      }
    } finally {
      pumping = false;
    }
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          task()
            .then(resolve, reject)
            .finally(() => {
              active--;
              void pump();
            });
        });
        void pump();
      });
    },
    backoff() {
      nextAllowedAt = Math.max(nextAllowedAt, now() + backoffMs);
    },
    pending: () => queue.length + active,
  };
}

/** 429 / 503 / ネットワーク断ならバックオフ対象 */
export function shouldBackoff(status: number): boolean {
  return status === 429 || status === 503 || status === 0;
}

/** テスト用: 固定応答の fetch を作る */
export function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>): FetchLike {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const r = await handler(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as FetchLike;
}
