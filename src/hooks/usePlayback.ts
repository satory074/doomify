import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createConnectTarget } from '../core/playback/connectTarget';
import {
  createPlaybackController,
  type ControllerErrorCode,
  type ControllerSnapshot,
  type LeaveInfo,
  type PlaybackController,
  type PlaybackSettings,
} from '../core/playback/controller';
import { createSdkTarget } from '../core/playback/sdkTarget';
import type { PlaybackTarget } from '../core/playback/types';
import type { ValueStore } from '../core/valueStore';
import type { Services } from '../services';
import type { Settings } from './useSettings';

export interface PlaybackError {
  code: ControllerErrorCode;
  message: string;
  at: number;
}

export interface PlaybackHandle {
  target: PlaybackTarget;
  controller: PlaybackController;
  snapshot: ControllerSnapshot;
  /** 最初のタップ(または再開のタップ)が必要 */
  needsGesture: boolean;
  started: boolean;
  initError: string | null;
  lastError: PlaybackError | null;
  /** タップハンドラ内で同期的に呼ぶ。activate → 現在の曲を即再生 */
  startFromGesture(track: { uri: string; durationMs: number }, index: number): void;
}

export interface PlaybackCallbacks {
  onAdvance: (fromIndex: number) => void;
  onLeave: (info: LeaveInfo) => void;
  onError: (code: ControllerErrorCode, message: string) => void;
  /** 連続した再生失敗の回数(再生先の切替提案に使う) */
  onFailureStreak: (streak: number, targetKind: PlaybackTarget['kind']) => void;
}

interface UiState {
  target: PlaybackTarget;
  snapshot: ControllerSnapshot;
  needsGesture: boolean;
  initError: string | null;
  lastError: PlaybackError | null;
}

const EMPTY_SNAPSHOT: ControllerSnapshot = {
  intent: null,
  playingUri: null,
  positionMs: 0,
  durationMs: 0,
  paused: true,
  requesting: false,
  startedAt: null,
  ready: false,
};

const initialState = (target: PlaybackTarget): UiState => ({
  target,
  snapshot: { ...EMPTY_SNAPSHOT, ready: target.deviceId !== null },
  // Connect は音がブラウザで鳴らないのでタップ不要
  needsGesture: target.kind === 'sdk',
  initError: null,
  lastError: null,
});

const isFailure = (code: ControllerErrorCode) => code === 'needs_gesture' || code === 'unknown' || code === 'no_device';

export function usePlayback(
  services: Services,
  settings: Settings,
  playbackSettings: ValueStore<PlaybackSettings>,
  callbacks: PlaybackCallbacks,
): PlaybackHandle {
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  const { playbackTarget, connectDeviceId, connectDeviceName } = settings;
  const target = useMemo<PlaybackTarget>(() => {
    if (playbackTarget === 'connect' && connectDeviceId !== null) {
      return createConnectTarget({
        player: services.api.player,
        deviceId: connectDeviceId,
        label: connectDeviceName ?? 'Spotify アプリ',
      });
    }
    return createSdkTarget({ getOAuthToken: () => services.auth.getAccessToken(), player: services.api.player });
  }, [services, playbackTarget, connectDeviceId, connectDeviceName]);

  const controller = useMemo(
    () => createPlaybackController({ target, settings: playbackSettings.get }),
    [target, playbackSettings],
  );

  const [state, setState] = useState<UiState>(() => initialState(target));
  const [started, setStarted] = useState(false);
  const wasPlayingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    let streak = 0;
    const update = (fn: (s: UiState) => UiState) => {
      if (!alive) return;
      setState((s) => fn(s.target === target ? s : initialState(target)));
    };

    const unsubs = [
      controller.subscribe((snapshot) => {
        const playing = snapshot.playingUri !== null && !snapshot.paused;
        if (playing) {
          wasPlayingRef.current = true;
          streak = 0;
        }
        update((s) => ({ ...s, snapshot, needsGesture: playing ? false : s.needsGesture }));
      }),
      controller.onAdvance((from) => callbacksRef.current.onAdvance(from)),
      controller.onLeave((info) => callbacksRef.current.onLeave(info)),
      controller.onError((code, message) => {
        update((s) => ({
          ...s,
          lastError: { code, message, at: Date.now() },
          needsGesture: code === 'needs_gesture' ? true : s.needsGesture,
        }));
        callbacksRef.current.onError(code, message);
        if (isFailure(code)) {
          streak++;
          callbacksRef.current.onFailureStreak(streak, target.kind);
        }
      }),
    ];
    target.init().catch((e: unknown) => update((s) => ({ ...s, initError: e instanceof Error ? e.message : String(e) })));

    return () => {
      alive = false;
      for (const u of unsubs) u();
      controller.dispose();
      target.dispose();
    };
  }, [controller, target]);

  // 画面ロック等で SDK が止まったら、復帰時にタップを求める
  useEffect(() => {
    if (target.kind !== 'sdk') return;
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt === null || Date.now() - hiddenAt < 3000) return;
      hiddenAt = null;
      void target.getState().then((s) => {
        if (s === null && wasPlayingRef.current) {
          setState((prev) => (prev.target === target ? { ...prev, needsGesture: true } : prev));
        }
      });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [target]);

  const startFromGesture = useCallback(
    (track: { uri: string; durationMs: number }, index: number) => {
      // activateElement はユーザー操作の同期コンテキストで呼ぶ必要がある
      void target.activate().catch(() => {});
      setStarted(true);
      setState((prev) => (prev.target === target ? { ...prev, needsGesture: false, lastError: null } : prev));
      controller.setActiveTrack(track, index);
      controller.retryCurrent();
    },
    [controller, target],
  );

  const current = state.target === target ? state : initialState(target);
  return {
    target,
    controller,
    snapshot: current.snapshot,
    needsGesture: current.needsGesture,
    started,
    initError: current.initError,
    lastError: current.lastError,
    startFromGesture,
  };
}
