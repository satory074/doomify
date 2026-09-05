import { describe, expect, it, vi } from 'vitest';
import { AuthError, createAuthManager } from './authManager';
import type { PkceCrypto } from './pkce';
import { AUTH_KEY, MemoryStorage, PENDING_KEY, saveTokens, type TokenSet } from './tokenStore';

const fixedCrypto: PkceCrypto = {
  getRandomValues: (bytes) => {
    bytes.fill(7);
    return bytes;
  },
  sha256: (data) => globalThis.crypto.subtle.digest('SHA-256', data),
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(opts: { fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>; nowMs?: number } = {}) {
  const storage = new MemoryStorage();
  const navigate = vi.fn<(url: string) => void>();
  let nowMs = opts.nowMs ?? 1_000_000;
  const fetchFn = vi.fn((url: string | URL | Request, init?: RequestInit) =>
    (opts.fetchImpl ?? (async () => jsonResponse(500, {})))(String(url), init),
  ) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
  const auth = createAuthManager({
    clientId: 'cid',
    redirectUri: 'https://x/doomify/',
    scope: 'streaming',
    storage,
    navigate,
    fetchFn,
    crypto: fixedCrypto,
    now: () => nowMs,
  });
  return { auth, storage, navigate, fetchFn, setNow: (ms: number) => (nowMs = ms) };
}

describe('login', () => {
  it('pending を保存して authorize URL に遷移する', async () => {
    const { auth, storage, navigate } = setup();
    await auth.login();
    expect(navigate).toHaveBeenCalledTimes(1);
    const url = new URL(navigate.mock.calls[0]?.[0] ?? '');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const pending = JSON.parse(storage.getItem(PENDING_KEY) ?? '{}') as { state: string; verifier: string };
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(pending.verifier).toHaveLength(64);
  });

  it('Client ID 未設定なら config エラー', async () => {
    const storage = new MemoryStorage();
    const auth = createAuthManager({
      clientId: '',
      redirectUri: 'https://x/',
      scope: 's',
      storage,
      navigate: () => {},
    });
    await expect(auth.login()).rejects.toMatchObject({ code: 'config' });
  });
});

describe('handleRedirect', () => {
  it('state が一致すれば code を交換して保存する', async () => {
    const { auth, storage, navigate, fetchFn } = setup({
      fetchImpl: async () =>
        jsonResponse(200, { access_token: 'acc', token_type: 'Bearer', expires_in: 3600, refresh_token: 'ref', scope: 's' }),
    });
    await auth.login();
    const state = new URL(navigate.mock.calls[0]?.[0] ?? '').searchParams.get('state');
    const outcome = await auth.handleRedirect(`?code=thecode&state=${state}`);
    expect(outcome).toBe('exchanged');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const tokens = JSON.parse(storage.getItem(AUTH_KEY) ?? 'null') as TokenSet;
    expect(tokens.accessToken).toBe('acc');
    expect(tokens.refreshToken).toBe('ref');
    expect(tokens.authorizedAt).toBe(1_000_000);
    expect(storage.getItem(PENDING_KEY)).toBeNull();
    expect(auth.isSignedIn()).toBe(true);
  });

  it('state 不一致は state_mismatch', async () => {
    const { auth } = setup();
    await auth.login();
    await expect(auth.handleRedirect('?code=c&state=wrong')).rejects.toMatchObject({ code: 'state_mismatch' });
  });

  it('error パラメータは denied', async () => {
    const { auth } = setup();
    await expect(auth.handleRedirect('?error=access_denied&state=s')).rejects.toMatchObject({ code: 'denied' });
  });

  it('code も error も無ければ none', async () => {
    const { auth } = setup();
    expect(await auth.handleRedirect('')).toBe('none');
  });
});

describe('getAccessToken', () => {
  const stored: TokenSet = { accessToken: 'old', refreshToken: 'ref', expiresAt: 2_000_000, authorizedAt: 0, scope: 's' };

  it('期限内ならそのまま返す(fetch しない)', async () => {
    const { auth, storage, fetchFn } = setup({ nowMs: 1_000_000 });
    saveTokens(storage, stored);
    expect(await auth.getAccessToken()).toBe('old');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('期限が近ければ refresh し、同時呼び出しは 1 回にまとめる。refresh_token 省略時は旧値維持', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const { auth, storage, fetchFn } = setup({
      nowMs: 1_999_000,
      fetchImpl: () => new Promise<Response>((r) => (resolveFetch = r)),
    });
    saveTokens(storage, stored);
    const p1 = auth.getAccessToken();
    const p2 = auth.getAccessToken();
    resolveFetch(jsonResponse(200, { access_token: 'new', token_type: 'Bearer', expires_in: 3600 }));
    expect(await p1).toBe('new');
    expect(await p2).toBe('new');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const tokens = JSON.parse(storage.getItem(AUTH_KEY) ?? 'null') as TokenSet;
    expect(tokens.refreshToken).toBe('ref');
    expect(tokens.authorizedAt).toBe(0);
  });

  it('invalid_grant ならトークンを破棄して reauth を投げ、購読者に signed-out を通知する', async () => {
    const { auth, storage } = setup({
      nowMs: 1_999_000,
      fetchImpl: async () => jsonResponse(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' }),
    });
    saveTokens(storage, stored);
    const states: string[] = [];
    auth.subscribe((s) => states.push(s));
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'reauth' });
    expect(auth.isSignedIn()).toBe(false);
    expect(states).toEqual(['signed-out']);
  });

  it('一時的な失敗ではトークンを残して network を投げる', async () => {
    const { auth, storage } = setup({ nowMs: 1_999_000, fetchImpl: async () => jsonResponse(503, {}) });
    saveTokens(storage, stored);
    const err = await auth.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('network');
    expect(auth.isSignedIn()).toBe(true);
  });

  it('未ログインなら reauth', async () => {
    const { auth } = setup();
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'reauth' });
  });
});

describe('status / logout', () => {
  it('signed-out → ok → signed-out', async () => {
    const { auth, storage } = setup({ nowMs: 10 });
    expect(auth.status()).toBe('signed-out');
    saveTokens(storage, { accessToken: 'a', refreshToken: 'r', expiresAt: 999, authorizedAt: 0, scope: '' });
    expect(auth.status()).toBe('ok');
    auth.logout();
    expect(auth.status()).toBe('signed-out');
  });
});
