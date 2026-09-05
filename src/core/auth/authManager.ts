/** ログイン・コールバック処理・アクセストークン供給(single-flight refresh)を束ねる。
 *  React 非依存。navigate/fetch/crypto/now は注入可能 */
import {
  buildAuthorizeUrl,
  challengeS256,
  exchangeCode,
  generateState,
  generateVerifier,
  parseCallback,
  refreshAccessToken,
  TokenRequestError,
  webCrypto,
  type PkceCrypto,
} from './pkce';
import {
  authStatus,
  clearPending,
  clearTokens,
  consumePending,
  loadTokens,
  needsRefresh,
  savePending,
  saveTokens,
  tokensFromResponse,
  type AuthStatus,
  type StorageLike,
  type TokenSet,
} from './tokenStore';

export type AuthState = 'signed-out' | AuthStatus;

export type AuthErrorCode = 'config' | 'reauth' | 'network' | 'state_mismatch' | 'denied';

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export interface AuthManagerDeps {
  clientId: string;
  redirectUri: string;
  scope: string;
  storage: StorageLike;
  navigate: (url: string) => void;
  fetchFn?: typeof fetch;
  crypto?: PkceCrypto;
  now?: () => number;
}

export type RedirectOutcome = 'exchanged' | 'none';

export interface AuthManager {
  getTokens(): TokenSet | null;
  isSignedIn(): boolean;
  status(): AuthState;
  /** 認可画面へフルページ遷移する(ポップアップは iOS PWA で戻れないので使わない) */
  login(): Promise<void>;
  /** location.search を渡す。code があれば交換して保存する */
  handleRedirect(search: string): Promise<RedirectOutcome>;
  /** 有効なアクセストークンを返す。必要なら refresh。失効時は AuthError('reauth') */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  logout(): void;
  subscribe(listener: (state: AuthState) => void): () => void;
}

export function createAuthManager(deps: AuthManagerDeps): AuthManager {
  const fetchFn = deps.fetchFn ?? fetch;
  const crypto = deps.crypto ?? webCrypto;
  const now = deps.now ?? (() => Date.now());
  const listeners = new Set<(state: AuthState) => void>();
  let refreshing: Promise<TokenSet> | null = null;

  const status = (): AuthState => {
    const t = loadTokens(deps.storage);
    return t === null ? 'signed-out' : authStatus(t, now());
  };

  const emit = () => {
    const s = status();
    for (const l of listeners) l(s);
  };

  const requireClientId = () => {
    if (deps.clientId === '') {
      throw new AuthError('config', 'VITE_SPOTIFY_CLIENT_ID が設定されていません');
    }
  };

  const refresh = (current: TokenSet): Promise<TokenSet> => {
    if (refreshing !== null) return refreshing;
    refreshing = (async () => {
      try {
        const res = await refreshAccessToken(
          { clientId: deps.clientId, refreshToken: current.refreshToken },
          fetchFn,
        );
        const next = tokensFromResponse(res, now(), current);
        saveTokens(deps.storage, next);
        return next;
      } catch (e) {
        if (e instanceof TokenRequestError && e.isInvalidGrant) {
          clearTokens(deps.storage);
          emit();
          throw new AuthError('reauth', '再ログインが必要です');
        }
        throw new AuthError('network', e instanceof Error ? e.message : String(e));
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };

  return {
    getTokens: () => loadTokens(deps.storage),
    isSignedIn: () => loadTokens(deps.storage) !== null,
    status,

    async login() {
      requireClientId();
      const verifier = generateVerifier(crypto);
      const state = generateState(crypto);
      const codeChallenge = await challengeS256(verifier, crypto);
      savePending(deps.storage, { verifier, state, createdAt: now() });
      deps.navigate(
        buildAuthorizeUrl({
          clientId: deps.clientId,
          redirectUri: deps.redirectUri,
          scope: deps.scope,
          codeChallenge,
          state,
        }),
      );
    },

    async handleRedirect(search) {
      const cb = parseCallback(search);
      if (cb.kind === 'none') return 'none';
      if (cb.kind === 'error') {
        clearPending(deps.storage);
        throw new AuthError('denied', cb.error);
      }
      const pending = consumePending(deps.storage, now());
      if (pending === null || pending.state !== cb.state) {
        throw new AuthError('state_mismatch', 'ログインの続きを確認できませんでした。もう一度お試しください');
      }
      requireClientId();
      let res;
      try {
        res = await exchangeCode(
          { clientId: deps.clientId, code: cb.code, redirectUri: deps.redirectUri, codeVerifier: pending.verifier },
          fetchFn,
        );
      } catch (e) {
        throw new AuthError('network', e instanceof Error ? e.message : String(e));
      }
      saveTokens(deps.storage, tokensFromResponse(res, now(), null));
      emit();
      return 'exchanged';
    },

    async getAccessToken(options) {
      const current = loadTokens(deps.storage);
      if (current === null) throw new AuthError('reauth', 'ログインしていません');
      if (options?.forceRefresh !== true && !needsRefresh(current, now())) return current.accessToken;
      const next = await refresh(current);
      return next.accessToken;
    },

    logout() {
      clearTokens(deps.storage);
      clearPending(deps.storage);
      emit();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
