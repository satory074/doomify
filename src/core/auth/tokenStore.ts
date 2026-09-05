/** トークンと PKCE 途中状態の永続化。localStorage 互換の StorageLike を注入する(テストは MemoryStorage) */
import type { TokenResponse } from './pkce';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export const AUTH_KEY = 'doomify:auth:v1';
export const PENDING_KEY = 'doomify:pkce:v1';

/** アクセストークンはこの余裕を残して更新する */
export const ACCESS_TOKEN_MARGIN_MS = 60_000;
/** Spotify のリフレッシュトークンは初回認可から 6 か月で失効する(更新してもリセットされない) */
export const REFRESH_TOKEN_LIFETIME_MS = 182 * 24 * 60 * 60 * 1000;
/** 失効のこの期間前から「まもなく再ログイン」を予告する */
export const REAUTH_WARNING_MS = 14 * 24 * 60 * 60 * 1000;
/** 認可画面に飛んでから戻るまでの許容時間 */
export const PENDING_TTL_MS = 10 * 60 * 1000;

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
  /** 初回認可(code 交換)の epoch ms。refresh では更新しない */
  authorizedAt: number;
  scope: string;
}

function isTokenSet(v: unknown): v is TokenSet {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.accessToken === 'string' &&
    typeof o.refreshToken === 'string' &&
    typeof o.expiresAt === 'number' &&
    typeof o.authorizedAt === 'number' &&
    typeof o.scope === 'string'
  );
}

export function loadTokens(storage: StorageLike): TokenSet | null {
  try {
    const raw = storage.getItem(AUTH_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isTokenSet(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveTokens(storage: StorageLike, tokens: TokenSet): void {
  storage.setItem(AUTH_KEY, JSON.stringify(tokens));
}

export function clearTokens(storage: StorageLike): void {
  storage.removeItem(AUTH_KEY);
}

/** token 応答から TokenSet を作る。refresh_token が省略されていれば旧値を維持し、authorizedAt は初回のみ設定 */
export function tokensFromResponse(res: TokenResponse, now: number, previous: TokenSet | null): TokenSet {
  const refreshToken = res.refresh_token ?? previous?.refreshToken ?? '';
  return {
    accessToken: res.access_token,
    refreshToken,
    expiresAt: now + res.expires_in * 1000,
    authorizedAt: previous?.authorizedAt ?? now,
    scope: res.scope ?? previous?.scope ?? '',
  };
}

export function needsRefresh(tokens: TokenSet, now: number): boolean {
  return now >= tokens.expiresAt - ACCESS_TOKEN_MARGIN_MS;
}

export type AuthStatus = 'ok' | 'expiring-soon' | 'reauth-required';

/** 6 か月失効に対する状態。実際の失効判定は refresh の invalid_grant で行い、ここは予告用 */
export function authStatus(tokens: TokenSet, now: number): AuthStatus {
  const age = now - tokens.authorizedAt;
  if (age >= REFRESH_TOKEN_LIFETIME_MS) return 'reauth-required';
  if (age >= REFRESH_TOKEN_LIFETIME_MS - REAUTH_WARNING_MS) return 'expiring-soon';
  return 'ok';
}

export interface PendingAuth {
  verifier: string;
  state: string;
  createdAt: number;
}

export function savePending(storage: StorageLike, pending: PendingAuth): void {
  storage.setItem(PENDING_KEY, JSON.stringify(pending));
}

/** 読み出しと同時に削除する(1 回限り)。TTL 超過なら null */
export function consumePending(storage: StorageLike, now: number): PendingAuth | null {
  try {
    const raw = storage.getItem(PENDING_KEY);
    storage.removeItem(PENDING_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<PendingAuth>;
    if (typeof parsed.verifier !== 'string' || typeof parsed.state !== 'string' || typeof parsed.createdAt !== 'number') {
      return null;
    }
    if (now - parsed.createdAt > PENDING_TTL_MS) return null;
    return { verifier: parsed.verifier, state: parsed.state, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

export function clearPending(storage: StorageLike): void {
  storage.removeItem(PENDING_KEY);
}
