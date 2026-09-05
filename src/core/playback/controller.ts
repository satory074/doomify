/** 「いま鳴らしたい曲」の意図を 1 か所に集約する。
 *  - スワイプ連打はデバウンスして最後の 1 曲だけ再生要求を出す
 *  - 古い要求は AbortController + seq で捨てる
 *  - 再生開始後に target が別の曲を報告していれば 1 回だけ再送(PUT の順序逆転対策)
 *  - 自動送り(一定時間 or 曲終了)を判定して onAdvance を発火
 *  React 非依存。タイマーはグローバル setTimeout/setInterval(テストは fake timers) */
import { AuthError } from '../auth/authManager';
import { ApiError } from '../spotify/apiClient';
import type { PlaybackState, PlaybackTarget, TargetErrorCode, TargetEvent } from './types';

export interface PlaybackSettings {
  startPosition: 'beginning' | 'hook';
  /** hook のときの開始位置(曲の長さに対する比率) */
  hookRatio: number;
  /** 自動送りまでの再生時間 ms。null なら曲の終わりまで */
  advanceAfterMs: number | null;
}

export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettings = {
  startPosition: 'hook',
  hookRatio: 0.3,
  advanceAfterMs: 60_000,
};

/** hook 開始でも残りがこれ未満なら冒頭から */
export const MIN_REMAINING_MS = 20_000;

export function startPositionFor(durationMs: number, settings: PlaybackSettings): number {
  if (settings.startPosition !== 'hook' || durationMs <= 0) return 0;
  const start = Math.floor(durationMs * settings.hookRatio);
  return durationMs - start < MIN_REMAINING_MS ? 0 : start;
}

export type ControllerErrorCode =
  | 'needs_gesture'
  | 'no_device'
  | 'premium_required'
  | 'rate_limited'
  | 'network'
  | 'auth'
  | 'unknown';

export interface TrackIntent {
  uri: string;
  durationMs: number;
  index: number;
}

export interface ControllerSnapshot {
  intent: TrackIntent | null;
  /** target が報告している曲。intent と違う間は切替中 */
  playingUri: string | null;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  requesting: boolean;
  /** この intent の曲が鳴り始めた時刻 */
  startedAt: number | null;
  ready: boolean;
}

export interface LeaveInfo {
  intent: TrackIntent;
  /** この曲が実際に鳴っていた時間 ms */
  playedMs: number;
}

export interface PlaybackController {
  /** アクティブカードが変わるたびに呼ぶ。null はカード無し */
  setActiveTrack(track: { uri: string; durationMs: number } | null, index: number): void;
  /** ユーザー操作直後に現在の意図を即時再送する(デバウンス無し) */
  retryCurrent(): void;
  togglePause(): Promise<void>;
  snapshot(): ControllerSnapshot;
  subscribe(listener: (s: ControllerSnapshot) => void): () => void;
  onAdvance(cb: (fromIndex: number) => void): () => void;
  onLeave(cb: (info: LeaveInfo) => void): () => void;
  onError(cb: (code: ControllerErrorCode, message: string) => void): () => void;
  dispose(): void;
}

export interface ControllerDeps {
  target: PlaybackTarget;
  settings: () => PlaybackSettings;
  now?: () => number;
  /** スワイプ確定から再生要求までの待ち(既定 250ms) */
  debounceMs?: number;
  /** 再生要求後、target が別の曲を報告し続けていたら再送するまでの待ち(既定 1500ms) */
  reconcileMs?: number;
  /** 位置補間と自動送り判定の周期(既定 500ms) */
  tickMs?: number;
  /** 曲終了とみなす末尾の余白(既定 600ms) */
  endToleranceMs?: number;
}

export function mapPlayError(e: unknown): { code: ControllerErrorCode; message: string } {
  if (e instanceof ApiError) {
    if (e.code === 'not_found' || e.reason === 'NO_ACTIVE_DEVICE') {
      return { code: 'no_device', message: '再生先が見つかりません' };
    }
    if (e.reason === 'PREMIUM_REQUIRED') return { code: 'premium_required', message: 'Spotify Premium が必要です' };
    if (e.code === 'rate_limited') return { code: 'rate_limited', message: '混雑しています。少し待ってください' };
    if (e.code === 'network') return { code: 'network', message: 'ネットワークに接続できません' };
    if (e.code === 'unauthorized') return { code: 'auth', message: 'ログインが切れました' };
    return { code: 'unknown', message: e.message };
  }
  if (e instanceof AuthError) return { code: 'auth', message: e.message };
  if (e instanceof Error && e.name === 'AbortError') return { code: 'unknown', message: 'aborted' };
  return { code: 'unknown', message: e instanceof Error ? e.message : String(e) };
}

function mapTargetError(code: TargetErrorCode): ControllerErrorCode {
  switch (code) {
    case 'premium_required':
      return 'premium_required';
    case 'auth':
      return 'auth';
    case 'no_device':
      return 'no_device';
    case 'network':
      return 'network';
    case 'rate_limited':
      return 'rate_limited';
    case 'init':
    case 'playback':
    case 'unknown':
      return 'unknown';
  }
}

export function createPlaybackController(deps: ControllerDeps): PlaybackController {
  const now = deps.now ?? (() => Date.now());
  const debounceMs = deps.debounceMs ?? 250;
  const reconcileMs = deps.reconcileMs ?? 1500;
  const tickMs = deps.tickMs ?? 500;
  const endToleranceMs = deps.endToleranceMs ?? 600;

  let intent: TrackIntent | null = null;
  let seq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  let lastState: PlaybackState | null = null;
  let requesting = false;
  let startedAt: number | null = null;
  let startMs = 0;
  let advanced = false;
  let reconciled = false;
  let wasPlaying = false;
  let lastObservedPos = 0;
  let ready = deps.target.deviceId !== null;
  let disposed = false;

  const snapshotListeners = new Set<(s: ControllerSnapshot) => void>();
  const advanceCbs = new Set<(fromIndex: number) => void>();
  const leaveCbs = new Set<(info: LeaveInfo) => void>();
  const errorCbs = new Set<(code: ControllerErrorCode, message: string) => void>();

  const currentDuration = (): number =>
    lastState !== null && lastState.durationMs > 0 ? lastState.durationMs : (intent?.durationMs ?? 0);

  const interpolatedPosition = (): number => {
    if (lastState === null) return 0;
    if (lastState.paused) return lastState.positionMs;
    const dur = currentDuration();
    const pos = lastState.positionMs + (now() - lastState.updatedAt);
    return dur > 0 ? Math.min(dur, pos) : pos;
  };

  const snapshot = (): ControllerSnapshot => ({
    intent,
    playingUri: lastState?.uri ?? null,
    positionMs: interpolatedPosition(),
    durationMs: currentDuration(),
    paused: lastState?.paused ?? true,
    requesting,
    startedAt,
    ready,
  });

  const emitSnapshot = () => {
    const s = snapshot();
    for (const l of snapshotListeners) l(s);
  };

  const emitError = (code: ControllerErrorCode, message: string) => {
    for (const cb of errorCbs) cb(code, message);
  };

  const advance = () => {
    if (intent === null || advanced) return;
    advanced = true;
    const from = intent.index;
    for (const cb of advanceCbs) cb(from);
  };

  const checkAdvance = () => {
    if (intent === null || advanced || lastState === null || lastState.uri !== intent.uri) return;
    const settings = deps.settings();
    const dur = currentDuration();
    if (!lastState.paused) {
      const pos = interpolatedPosition();
      wasPlaying = true;
      lastObservedPos = pos;
      if (startedAt === null) startedAt = now();
      if (settings.advanceAfterMs !== null && pos - startMs >= settings.advanceAfterMs) {
        advance();
        return;
      }
      if (dur > 0 && pos >= dur - endToleranceMs) advance();
      return;
    }
    // SDK は曲が終わると paused かつ position 0 に戻る
    if (wasPlaying && lastState.positionMs === 0 && dur > 0 && lastObservedPos > dur * 0.5) advance();
  };

  const clearTimers = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (reconcileTimer !== null) {
      clearTimeout(reconcileTimer);
      reconcileTimer = null;
    }
  };

  const issuePlay = async (target: TrackIntent, isRetry: boolean) => {
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    const mySeq = ++seq;
    startMs = startPositionFor(target.durationMs, deps.settings());
    requesting = true;
    emitSnapshot();
    try {
      await deps.target.play(target.uri, startMs, controller.signal);
      if (mySeq !== seq || disposed) return;
      requesting = false;
      if (!isRetry) {
        reconcileTimer = setTimeout(() => {
          reconcileTimer = null;
          if (intent === target && !reconciled && lastState?.uri !== target.uri) {
            reconciled = true;
            void issuePlay(target, true);
          }
        }, reconcileMs);
      }
      emitSnapshot();
    } catch (e) {
      if (mySeq !== seq || disposed) return;
      requesting = false;
      if (e instanceof ApiError && e.code === 'aborted') return;
      const mapped = mapPlayError(e);
      emitError(mapped.code, mapped.message);
      emitSnapshot();
    }
  };

  const onEvent = (e: TargetEvent) => {
    if (disposed) return;
    switch (e.type) {
      case 'ready':
        ready = true;
        emitSnapshot();
        break;
      case 'not_ready':
        ready = false;
        emitSnapshot();
        break;
      case 'state':
        lastState = e.state;
        checkAdvance();
        emitSnapshot();
        break;
      case 'autoplay_blocked':
        emitError('needs_gesture', 'タップして再生を開始してください');
        break;
      case 'error':
        emitError(mapTargetError(e.code), e.message);
        break;
    }
  };

  const unsubscribeTarget = deps.target.subscribe(onEvent);
  const ticker = setInterval(() => {
    if (disposed || lastState === null || lastState.paused) return;
    checkAdvance();
    emitSnapshot();
  }, tickMs);

  return {
    setActiveTrack(track, index) {
      if (track !== null && intent !== null && intent.uri === track.uri && intent.index === index) return;
      if (intent !== null) {
        const playedMs = startedAt === null ? 0 : Math.max(0, now() - startedAt);
        const leaving = intent;
        for (const cb of leaveCbs) cb({ intent: leaving, playedMs });
      }
      clearTimers();
      abort?.abort();
      abort = null;
      seq++;
      intent = track === null ? null : { uri: track.uri, durationMs: track.durationMs, index };
      startedAt = null;
      advanced = false;
      reconciled = false;
      wasPlaying = false;
      lastObservedPos = 0;
      requesting = false;
      emitSnapshot();
      if (intent !== null) {
        const target = intent;
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void issuePlay(target, false);
        }, debounceMs);
      }
    },

    retryCurrent() {
      if (intent === null) return;
      clearTimers();
      reconciled = false;
      void issuePlay(intent, false);
    },

    async togglePause() {
      if (lastState === null) return;
      try {
        if (lastState.paused) await deps.target.resume();
        else await deps.target.pause();
      } catch (e) {
        const mapped = mapPlayError(e);
        emitError(mapped.code, mapped.message);
      }
    },

    snapshot,

    subscribe(listener) {
      snapshotListeners.add(listener);
      return () => {
        snapshotListeners.delete(listener);
      };
    },
    onAdvance(cb) {
      advanceCbs.add(cb);
      return () => {
        advanceCbs.delete(cb);
      };
    },
    onLeave(cb) {
      leaveCbs.add(cb);
      return () => {
        leaveCbs.delete(cb);
      };
    },
    onError(cb) {
      errorCbs.add(cb);
      return () => {
        errorCbs.delete(cb);
      };
    },

    dispose() {
      disposed = true;
      clearTimers();
      clearInterval(ticker);
      abort?.abort();
      unsubscribeTarget();
      snapshotListeners.clear();
      advanceCbs.clear();
      leaveCbs.clear();
      errorCbs.clear();
    },
  };
}
