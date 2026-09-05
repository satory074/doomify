/** Spotify Connect 遠隔操作の PlaybackTarget。音はスマホの Spotify アプリなど別デバイスで鳴る。
 *  自動再生制限が無くバックグラウンド再生もアプリ任せで安定する反面、
 *  進行状況は GET /me/player のポーリングが必要なのでクォータに配慮して間隔を空ける */
import type { SpotifyApi } from '../spotify/endpoints';
import type { PlayerState } from '../spotify/types';
import type { PlaybackState, PlaybackTarget, TargetEvent } from './types';

export interface ConnectTargetDeps {
  player: SpotifyApi['player'];
  deviceId: string;
  label: string;
  now?: () => number;
  /** 可視中のポーリング間隔(既定 10 秒) */
  pollIntervalMs?: number;
  /** 再生要求後、最初に状態を確認するまでの待ち(既定 1.5 秒) */
  confirmDelayMs?: number;
  isVisible?: () => boolean;
}

export function toPlaybackState(s: PlayerState | null, now: number): PlaybackState {
  if (s === null) return { uri: null, positionMs: 0, durationMs: 0, paused: true, updatedAt: now };
  return {
    uri: s.item?.uri ?? null,
    positionMs: s.progress_ms ?? 0,
    durationMs: s.item?.duration_ms ?? 0,
    paused: !s.is_playing,
    updatedAt: now,
  };
}

export function createConnectTarget(deps: ConnectTargetDeps): PlaybackTarget {
  const now = deps.now ?? (() => Date.now());
  const pollIntervalMs = deps.pollIntervalMs ?? 10_000;
  const confirmDelayMs = deps.confirmDelayMs ?? 1_500;
  const isVisible = deps.isVisible ?? (() => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'));
  const listeners = new Set<(e: TargetEvent) => void>();
  let last: PlaybackState = { uri: null, positionMs: 0, durationMs: 0, paused: true, updatedAt: now() };
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const emit = (e: TargetEvent) => {
    for (const l of listeners) l(e);
  };

  const emitState = (state: PlaybackState) => {
    last = state;
    emit({ type: 'state', state });
  };

  const stopPolling = () => {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const poll = async () => {
    try {
      const s = await deps.player.state();
      if (disposed) return;
      emitState(toPlaybackState(s, now()));
    } catch {
      // レート制限などは ApiClient 側で待つ。ここでは次回のポーリングに任せる
    }
  };

  const schedule = (delayMs: number) => {
    stopPolling();
    if (disposed) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (disposed) return;
      if (isVisible()) await poll();
      // 再生中だけ継続的にポーリングする(停止中は次の操作まで待つ)
      if (!disposed && !last.paused) schedule(pollIntervalMs);
    }, delayMs);
  };

  /** 操作直後は API 応答を待たずに楽観的に状態を更新し、少し後に実際の状態で上書きする */
  const optimistic = (patch: Partial<PlaybackState>) => {
    emitState({ ...last, ...patch, updatedAt: now() });
    schedule(confirmDelayMs);
  };

  return {
    kind: 'connect',
    label: deps.label,
    deviceId: deps.deviceId,

    async init() {
      disposed = false;
      await poll();
    },

    async activate() {
      // 遠隔デバイスでは不要
    },

    async play(uri, positionMs, signal) {
      await deps.player.play(deps.deviceId, { uris: [uri], positionMs, signal });
      optimistic({ uri, positionMs, durationMs: 0, paused: false });
    },

    async pause() {
      await deps.player.pause(deps.deviceId);
      optimistic({ paused: true, positionMs: last.paused ? last.positionMs : last.positionMs + (now() - last.updatedAt) });
    },

    async resume() {
      await deps.player.resume(deps.deviceId);
      optimistic({ paused: false });
    },

    async seek(positionMs) {
      await deps.player.seek(positionMs, deps.deviceId);
      optimistic({ positionMs });
    },

    async getState() {
      const s = await deps.player.state();
      return toPlaybackState(s, now());
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      stopPolling();
      listeners.clear();
    },
  };
}
