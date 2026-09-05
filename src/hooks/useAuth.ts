import { useCallback, useEffect, useState } from 'react';
import { AuthError, type AuthManager, type AuthState } from '../core/auth/authManager';

export type AuthUiState =
  | { kind: 'booting' }
  | { kind: 'signed-out'; message: string | null }
  | { kind: 'signed-in'; status: Exclude<AuthState, 'signed-out'> };

/** StrictMode の二重実行や再マウントでコールバック処理を 2 回走らせない */
let redirectHandled: Promise<string | null> | null = null;

function describeAuthError(e: unknown): string {
  if (e instanceof AuthError) {
    switch (e.code) {
      case 'config':
        return 'Client ID が設定されていません。.env の VITE_SPOTIFY_CLIENT_ID を確認してください';
      case 'denied':
        return 'Spotify へのアクセスが許可されませんでした';
      case 'state_mismatch':
        return 'ログインの続きを確認できませんでした。もう一度ログインしてください';
      case 'network':
        return 'Spotify に接続できませんでした。通信状態を確認してもう一度お試しください';
      case 'reauth':
        return '再ログインが必要です(Spotify の認可は 6 か月ごとに更新が必要です)';
    }
  }
  return e instanceof Error ? e.message : String(e);
}

export function useAuth(auth: AuthManager): { state: AuthUiState; login: () => Promise<void>; logout: () => void } {
  const [state, setState] = useState<AuthUiState>({ kind: 'booting' });

  useEffect(() => {
    const unsubscribe = auth.subscribe((s) => {
      setState(
        s === 'signed-out'
          ? { kind: 'signed-out', message: null }
          : { kind: 'signed-in', status: s },
      );
    });
    if (redirectHandled === null) {
      redirectHandled = auth
        .handleRedirect(window.location.search)
        .then((outcome) => {
          if (outcome === 'exchanged' || window.location.search !== '') {
            window.history.replaceState(null, '', window.location.pathname);
          }
          return null;
        })
        .catch((e: unknown) => {
          window.history.replaceState(null, '', window.location.pathname);
          return describeAuthError(e);
        });
    }
    let cancelled = false;
    void redirectHandled.then((message) => {
      if (cancelled) return;
      const s = auth.status();
      setState(
        s === 'signed-out'
          ? { kind: 'signed-out', message }
          : { kind: 'signed-in', status: s },
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [auth]);

  const login = useCallback(async () => {
    try {
      await auth.login();
    } catch (e) {
      setState({ kind: 'signed-out', message: describeAuthError(e) });
    }
  }, [auth]);

  const logout = useCallback(() => auth.logout(), [auth]);

  return { state, login, logout };
}
