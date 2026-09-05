/** Web Playback SDK をブラウザ内の Spotify Connect デバイスとして使う PlaybackTarget。
 *  - SDK スクリプトはログイン後にオンデマンドで注入する(未ログイン者に読ませない)
 *  - 再生開始は Web API の PUT /me/player/play?device_id= で行う(SDK 自体に「この URI を再生」は無い)
 *  - iOS Safari では activate()(= activateElement)をタップ内で呼ばないと自動再生が止められる */
import { ApiError } from '../spotify/apiClient';
import type { SpotifyApi } from '../spotify/endpoints';
import type { PlaybackState, PlaybackTarget, TargetEvent } from './types';

export const SDK_SCRIPT_URL = 'https://sdk.scdn.co/spotify-player.js';

let sdkLoading: Promise<void> | null = null;

export function loadSdkScript(doc: Document = document): Promise<void> {
  if (typeof window !== 'undefined' && window.Spotify !== undefined) return Promise.resolve();
  if (sdkLoading !== null) return sdkLoading;
  sdkLoading = new Promise<void>((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = doc.createElement('script');
    script.src = SDK_SCRIPT_URL;
    script.async = true;
    script.onerror = () => {
      sdkLoading = null;
      script.remove();
      reject(new Error('Spotify の再生モジュールを読み込めませんでした'));
    };
    doc.head.appendChild(script);
  });
  return sdkLoading;
}

export interface SdkTargetDeps {
  getOAuthToken: () => Promise<string>;
  player: SpotifyApi['player'];
  name?: string;
  volume?: number;
  now?: () => number;
  loadScript?: () => Promise<void>;
  /** ready が来ないときの打ち切り(既定 20 秒) */
  readyTimeoutMs?: number;
}

export function createSdkTarget(deps: SdkTargetDeps): PlaybackTarget {
  const now = deps.now ?? (() => Date.now());
  const loadScript = deps.loadScript ?? (() => loadSdkScript());
  const readyTimeoutMs = deps.readyTimeoutMs ?? 20_000;
  const listeners = new Set<(e: TargetEvent) => void>();
  let player: Spotify.Player | null = null;
  let deviceId: string | null = null;
  let initPromise: Promise<void> | null = null;

  const emit = (e: TargetEvent) => {
    for (const l of listeners) l(e);
  };

  const toState = (s: Spotify.PlaybackState | null): PlaybackState | null =>
    s === null
      ? null
      : {
          uri: s.track_window.current_track?.uri ?? null,
          positionMs: s.position,
          durationMs: s.duration,
          paused: s.paused,
          updatedAt: now(),
        };

  const requirePlayer = (): Spotify.Player => {
    if (player === null) throw new Error('再生モジュールが初期化されていません');
    return player;
  };

  const doInit = async () => {
    await loadScript();
    const p = new window.Spotify.Player({
      name: deps.name ?? 'doomify',
      volume: deps.volume ?? 0.8,
      getOAuthToken: (cb) => {
        deps
          .getOAuthToken()
          .then(cb)
          .catch((e: unknown) => emit({ type: 'error', code: 'auth', message: e instanceof Error ? e.message : String(e) }));
      },
    });
    player = p;

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('再生デバイスの準備に時間がかかっています')), readyTimeoutMs);
      p.addListener('ready', ({ device_id }) => {
        clearTimeout(timer);
        deviceId = device_id;
        emit({ type: 'ready', deviceId: device_id });
        resolve();
      });
      p.addListener('initialization_error', ({ message }) => {
        clearTimeout(timer);
        emit({ type: 'error', code: 'init', message });
        reject(new Error(message));
      });
      p.addListener('authentication_error', ({ message }) => {
        clearTimeout(timer);
        emit({ type: 'error', code: 'auth', message });
        reject(new Error(message));
      });
      p.addListener('account_error', ({ message }) => {
        clearTimeout(timer);
        emit({ type: 'error', code: 'premium_required', message });
        reject(new Error(message));
      });
    });
    p.addListener('not_ready', () => {
      emit({ type: 'not_ready' });
    });
    p.addListener('player_state_changed', (s) => {
      const state = toState(s);
      if (state !== null) emit({ type: 'state', state });
    });
    p.addListener('playback_error', ({ message }) => {
      emit({ type: 'error', code: 'playback', message });
    });
    p.addListener('autoplay_failed', () => {
      emit({ type: 'autoplay_blocked' });
    });

    const connected = await p.connect();
    if (!connected) throw new Error('Spotify に接続できませんでした');
    await ready;
  };

  return {
    kind: 'sdk',
    label: 'このブラウザ',
    get deviceId() {
      return deviceId;
    },

    init() {
      if (initPromise === null) {
        initPromise = doInit().catch((e: unknown) => {
          player?.disconnect();
          player = null;
          deviceId = null;
          initPromise = null;
          throw e;
        });
      }
      return initPromise;
    },

    async activate() {
      if (player === null) return;
      await player.activateElement();
    },

    async play(uri, positionMs, signal) {
      if (deviceId === null) {
        throw new ApiError('not_found', 404, '再生デバイスが準備できていません', 'NO_ACTIVE_DEVICE');
      }
      await deps.player.play(deviceId, { uris: [uri], positionMs, signal });
    },

    pause: () => requirePlayer().pause(),
    resume: () => requirePlayer().resume(),
    seek: (positionMs) => requirePlayer().seek(Math.max(0, Math.floor(positionMs))),

    async getState() {
      if (player === null) return null;
      return toState(await player.getCurrentState());
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      player?.disconnect();
      player = null;
      deviceId = null;
      initPromise = null;
      listeners.clear();
    },
  };
}
