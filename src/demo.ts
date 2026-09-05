/** `?demo=1` で開くと、Spotify にログインせずダミーデータでフィード UI を触れる(音は出ない)。
 *  レイアウト確認と、Client ID を設定する前の動作イメージ用 */
import { createAuthManager } from './core/auth/authManager';
import { MemoryStorage } from './core/auth/tokenStore';
import { createHistory } from './core/feed/history';
import { createFakeApi } from './core/feed/testApi';
import type { PlaybackState, PlaybackTarget, TargetEvent } from './core/playback/types';
import type { ApiClient } from './core/spotify/apiClient';
import { MemoryStore } from './core/spotify/cache';
import type { Services } from './services';

const DEMO_AT_LOAD = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1';

/** ページ読み込み時のクエリで判定し、以後は固定(認証処理が URL を掃除しても変わらない) */
export function isDemo(): boolean {
  return DEMO_AT_LOAD;
}

const DEMO_DURATION_MS = 200_000;

export function createDemoTarget(): PlaybackTarget {
  const listeners = new Set<(e: TargetEvent) => void>();
  let state: PlaybackState = { uri: null, positionMs: 0, durationMs: 0, paused: true, updatedAt: Date.now() };
  let timer: ReturnType<typeof setInterval> | null = null;
  const emit = (e: TargetEvent) => {
    for (const l of listeners) l(e);
  };
  const setState = (patch: Partial<PlaybackState>) => {
    state = { ...state, ...patch, updatedAt: Date.now() };
    emit({ type: 'state', state });
  };
  const tick = () => {
    if (state.paused || state.uri === null) return;
    const pos = state.positionMs + 1000;
    if (pos >= state.durationMs) setState({ positionMs: 0, paused: true });
    else setState({ positionMs: pos });
  };
  return {
    kind: 'sdk',
    label: 'デモ(音は出ません)',
    deviceId: 'demo',
    async init() {
      emit({ type: 'ready', deviceId: 'demo' });
      if (timer === null) timer = setInterval(tick, 1000);
    },
    async activate() {},
    async play(uri, positionMs) {
      await new Promise((r) => setTimeout(r, 300));
      setState({ uri, positionMs, durationMs: DEMO_DURATION_MS, paused: false });
    },
    async pause() {
      setState({ paused: true });
    },
    async resume() {
      setState({ paused: false });
    },
    async seek(positionMs) {
      setState({ positionMs });
    },
    async getState() {
      return state;
    },
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    dispose() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      listeners.clear();
    },
  };
}

export function createDemoServices(): Services {
  const { api } = createFakeApi();
  const store = new MemoryStore();
  const client: ApiClient = {
    request: async () => {
      throw new Error('demo');
    },
    onRateLimit: () => () => {},
    rateLimitedUntil: () => null,
    stats: () => ({ requests: 0, cacheHits: 0, rateLimits: 0 }),
  };
  return {
    auth: createAuthManager({ clientId: 'demo', redirectUri: '', scope: '', storage: new MemoryStorage(), navigate: () => {} }),
    client,
    api,
    store,
    history: createHistory(store),
    redirectUri: '',
    demoTarget: createDemoTarget(),
  };
}
