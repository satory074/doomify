/** アプリ全体で 1 つずつ持つサービス群(認証・API・永続ストア・履歴)。React 外で生成する */
import { createAuthManager, type AuthManager } from './core/auth/authManager';
import { CLIENT_ID, redirectUri, SCOPE_STRING } from './core/config';
import { createHistory, type History } from './core/feed/history';
import { createApiClient, type ApiClient } from './core/spotify/apiClient';
import { createIdbStore, type KeyValueStore } from './core/spotify/cache';
import type { PlaybackTarget } from './core/playback/types';
import { createSpotifyApi, type SpotifyApi } from './core/spotify/endpoints';
import { createDemoServices, isDemo } from './demo';

export interface Services {
  auth: AuthManager;
  client: ApiClient;
  api: SpotifyApi;
  store: KeyValueStore;
  history: History;
  redirectUri: string;
  /** デモモードのときだけ。usePlayback がこれを使う */
  demoTarget?: PlaybackTarget;
}

let services: Services | null = null;

export function getServices(): Services {
  if (services !== null) return services;
  if (isDemo()) {
    services = createDemoServices();
    return services;
  }
  const uri = redirectUri(window.location.origin, import.meta.env.BASE_URL);
  const auth = createAuthManager({
    clientId: CLIENT_ID,
    redirectUri: uri,
    scope: SCOPE_STRING,
    storage: window.localStorage,
    navigate: (url) => window.location.assign(url),
  });
  const client = createApiClient({ getAccessToken: (o) => auth.getAccessToken(o) });
  const api = createSpotifyApi(client);
  const store = createIdbStore();
  const history = createHistory(store);
  services = { auth, client, api, store, history, redirectUri: uri };
  return services;
}
