/** Authorization Code + PKCE(RFC 7636)の純関数群。crypto / fetch は注入可能(テストのため) */

export interface PkceCrypto {
  getRandomValues(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
  sha256(data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
}

export const webCrypto: PkceCrypto = {
  getRandomValues: (bytes) => globalThis.crypto.getRandomValues(bytes),
  sha256: (data) => globalThis.crypto.subtle.digest('SHA-256', data),
};

export const AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';
export const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';

export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 48 バイトの乱数を base64url にすると 64 文字(全て RFC 7636 の unreserved 文字) */
export function generateVerifier(c: PkceCrypto = webCrypto): string {
  return base64Url(c.getRandomValues(new Uint8Array(48)));
}

export function generateState(c: PkceCrypto = webCrypto): string {
  return base64Url(c.getRandomValues(new Uint8Array(16)));
}

export async function challengeS256(verifier: string, c: PkceCrypto = webCrypto): Promise<string> {
  const digest = await c.sha256(new TextEncoder().encode(verifier));
  return base64Url(digest);
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  state: string;
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: 'code',
    redirect_uri: p.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: p.codeChallenge,
    scope: p.scope,
    state: p.state,
  });
  return `${AUTHORIZE_ENDPOINT}?${q.toString()}`;
}

export type CallbackResult =
  | { kind: 'code'; code: string; state: string | null }
  | { kind: 'error'; error: string; state: string | null }
  | { kind: 'none' };

/** location.search を解釈する。code/error のどちらも無ければ none */
export function parseCallback(search: string): CallbackResult {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const state = q.get('state');
  const error = q.get('error');
  if (error !== null) return { kind: 'error', error, state };
  const code = q.get('code');
  if (code !== null && code !== '') return { kind: 'code', code, state };
  return { kind: 'none' };
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  /** refresh 応答では省略されることがある(その場合は旧トークンを使い続ける) */
  refresh_token?: string;
  scope?: string;
}

export class TokenRequestError extends Error {
  readonly status: number;
  readonly error: string | null;
  readonly description: string | null;

  constructor(status: number, error: string | null, description: string | null) {
    super(`token request failed: ${status} ${error ?? ''} ${description ?? ''}`.trim());
    this.name = 'TokenRequestError';
    this.status = status;
    this.error = error;
    this.description = description;
  }

  /** リフレッシュトークンが無効(失効・取り消し)。再ログインが必要 */
  get isInvalidGrant(): boolean {
    return this.status === 400 && this.error === 'invalid_grant';
  }
}

async function postToken(body: Record<string, string>, fetchFn: typeof fetch): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetchFn(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  } catch (e) {
    throw new TokenRequestError(0, 'network_error', e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as { error?: string; error_description?: string } | null;
    throw new TokenRequestError(res.status, json?.error ?? null, json?.error_description ?? null);
  }
  return (await res.json()) as TokenResponse;
}

export interface ExchangeParams {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export function exchangeCode(p: ExchangeParams, fetchFn: typeof fetch = fetch): Promise<TokenResponse> {
  return postToken(
    {
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      code_verifier: p.codeVerifier,
    },
    fetchFn,
  );
}

export function refreshAccessToken(
  p: { clientId: string; refreshToken: string },
  fetchFn: typeof fetch = fetch,
): Promise<TokenResponse> {
  return postToken(
    { grant_type: 'refresh_token', refresh_token: p.refreshToken, client_id: p.clientId },
    fetchFn,
  );
}
