import { describe, expect, it } from 'vitest';
import {
  base64Url,
  buildAuthorizeUrl,
  challengeS256,
  exchangeCode,
  generateVerifier,
  parseCallback,
  refreshAccessToken,
  TokenRequestError,
  TOKEN_ENDPOINT,
} from './pkce';

describe('challengeS256', () => {
  it('RFC 7636 付録 B のベクタと一致する', async () => {
    const challenge = await challengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('generateVerifier', () => {
  it('64 文字・unreserved 文字のみ', () => {
    const v = generateVerifier();
    expect(v).toHaveLength(64);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('呼ぶたびに異なる', () => {
    expect(generateVerifier()).not.toBe(generateVerifier());
  });
});

describe('base64Url', () => {
  it('パディング無し・URL セーフ', () => {
    expect(base64Url(new Uint8Array([251, 255, 191]))).toBe('-_-_');
    expect(base64Url(new Uint8Array([1]))).toBe('AQ');
  });
});

describe('buildAuthorizeUrl', () => {
  it('必要なパラメータを全て含む', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'cid',
        redirectUri: 'https://example.com/doomify/',
        scope: 'streaming user-read-email',
        codeChallenge: 'chal',
        state: 'st',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/doomify/');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('scope')).toBe('streaming user-read-email');
    expect(url.searchParams.get('state')).toBe('st');
  });
});

describe('parseCallback', () => {
  it('code と state を取り出す', () => {
    expect(parseCallback('?code=abc&state=xyz')).toEqual({ kind: 'code', code: 'abc', state: 'xyz' });
  });
  it('error を優先する', () => {
    expect(parseCallback('?error=access_denied&state=xyz')).toEqual({
      kind: 'error',
      error: 'access_denied',
      state: 'xyz',
    });
  });
  it('どちらも無ければ none', () => {
    expect(parseCallback('')).toEqual({ kind: 'none' });
    expect(parseCallback('?foo=bar')).toEqual({ kind: 'none' });
  });
});

function fakeFetch(status: number, body: unknown): typeof fetch & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch & { calls: { url: string; init: RequestInit }[] };
  fn.calls = calls;
  return fn;
}

describe('exchangeCode / refreshAccessToken', () => {
  it('フォームエンコードで token エンドポイントに POST する', async () => {
    const f = fakeFetch(200, { access_token: 'a', token_type: 'Bearer', expires_in: 3600, refresh_token: 'r' });
    const res = await exchangeCode(
      { clientId: 'cid', code: 'code', redirectUri: 'https://x/', codeVerifier: 'v' },
      f,
    );
    expect(res.access_token).toBe('a');
    const call = f.calls[0];
    expect(call?.url).toBe(TOKEN_ENDPOINT);
    const body = new URLSearchParams(String(call?.init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('v');
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('redirect_uri')).toBe('https://x/');
  });

  it('invalid_grant は TokenRequestError.isInvalidGrant になる', async () => {
    const f = fakeFetch(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
    const err = await refreshAccessToken({ clientId: 'cid', refreshToken: 'r' }, f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenRequestError);
    expect((err as TokenRequestError).isInvalidGrant).toBe(true);
    expect((err as TokenRequestError).status).toBe(400);
  });

  it('ネットワーク失敗は status 0 の TokenRequestError', async () => {
    const f = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const err = await refreshAccessToken({ clientId: 'cid', refreshToken: 'r' }, f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenRequestError);
    expect((err as TokenRequestError).status).toBe(0);
    expect((err as TokenRequestError).isInvalidGrant).toBe(false);
  });
});
