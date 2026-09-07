import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../spotify/apiClient';
import {
  createPlaybackController,
  DEFAULT_PLAYBACK_SETTINGS,
  startPositionFor,
  type PlaybackController,
  type PlaybackSettings,
} from './controller';
import type { PlaybackState, PlaybackTarget, TargetEvent } from './types';

interface PlayCall {
  uri: string;
  positionMs: number;
  signal?: AbortSignal;
}

function fakeTarget() {
  const listeners = new Set<(e: TargetEvent) => void>();
  const playCalls: PlayCall[] = [];
  let playImpl: (call: PlayCall) => Promise<void> = async () => {};
  const paused = vi.fn(async () => {});
  const resumed = vi.fn(async () => {});
  const target: PlaybackTarget = {
    kind: 'sdk',
    label: 'test',
    deviceId: 'dev',
    init: async () => {},
    activate: async () => {},
    play: (uri, positionMs, signal) => {
      const call = { uri, positionMs, signal };
      playCalls.push(call);
      return playImpl(call);
    },
    pause: paused,
    resume: resumed,
    seek: async () => {},
    getState: async () => null,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    dispose: () => {},
  };
  return {
    target,
    playCalls,
    paused,
    resumed,
    setPlayImpl: (impl: typeof playImpl) => (playImpl = impl),
    emit: (e: TargetEvent) => {
      for (const l of listeners) l(e);
    },
    state: (partial: Partial<PlaybackState> & { uri: string }) =>
      ({ positionMs: 0, durationMs: 180_000, paused: false, loading: false, updatedAt: Date.now(), ...partial }) as PlaybackState,
  };
}

let settings: PlaybackSettings;
let ctl: PlaybackController | null = null;
const started = (c: PlaybackController): PlaybackController => {
  c.start();
  return c;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  settings = { ...DEFAULT_PLAYBACK_SETTINGS };
});
afterEach(() => {
  ctl?.dispose();
  ctl = null;
  vi.useRealTimers();
});

const TRACK_A = { uri: 'spotify:track:A', durationMs: 200_000 };
const TRACK_B = { uri: 'spotify:track:B', durationMs: 200_000 };

describe('startPositionFor', () => {
  it('hook は 30% 地点、残りが 20 秒未満なら 0、beginning は 0', () => {
    expect(startPositionFor(200_000, settings)).toBe(60_000);
    expect(startPositionFor(20_000, settings)).toBe(0);
    expect(startPositionFor(200_000, { ...settings, startPosition: 'beginning' })).toBe(0);
  });
});

describe('setActiveTrack', () => {
  it('スワイプ 1 回は待たずにその場で再生要求を出す(開始位置は hook)', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    ctl.setActiveTrack(TRACK_A, 0);
    expect(t.playCalls).toHaveLength(1);
    expect(t.playCalls[0]).toMatchObject({ uri: TRACK_A.uri, positionMs: 60_000 });
    expect(ctl.snapshot().requesting).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.snapshot().requesting).toBe(false);
  });

  it('連打は先頭を即時、残りは 250ms 後に最後の 1 曲だけ', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    for (let i = 0; i < 5; i++) ctl.setActiveTrack({ uri: `spotify:track:${i}`, durationMs: 200_000 }, i);
    expect(t.playCalls).toHaveLength(1);
    expect(t.playCalls[0]).toMatchObject({ uri: 'spotify:track:0' });
    await vi.advanceTimersByTimeAsync(249);
    expect(t.playCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.playCalls).toHaveLength(2);
    expect(t.playCalls[1]).toMatchObject({ uri: 'spotify:track:4', positionMs: 60_000 });
    expect(ctl.snapshot().intent?.index).toBe(4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.playCalls).toHaveLength(2);
  });

  it('前回の発行から 250ms 以上たっていれば次の意図も即時(前の要求は abort)', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(300);
    ctl.setActiveTrack(TRACK_B, 1);
    expect(t.playCalls).toHaveLength(2);
    expect(t.playCalls[0]?.signal?.aborted).toBe(true);
    expect(t.playCalls[1]).toMatchObject({ uri: TRACK_B.uri });
  });

  it('setActiveTrack 直後の retryCurrent は二重送信しない(初回タップ)。解決後は再送する(再開タップ)', async () => {
    const t = fakeTarget();
    let resolvePlay: () => void = () => {};
    t.setPlayImpl(() => new Promise<void>((r) => (resolvePlay = r)));
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    ctl.setActiveTrack(TRACK_A, 0);
    ctl.retryCurrent();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.playCalls).toHaveLength(1);
    resolvePlay();
    await vi.advanceTimersByTimeAsync(0);
    ctl.retryCurrent();
    expect(t.playCalls).toHaveLength(2);
  });

  it('間隔待ち中の意図は retryCurrent で即時に流す', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(100);
    ctl.setActiveTrack(TRACK_B, 1);
    expect(t.playCalls).toHaveLength(1);
    ctl.retryCurrent();
    expect(t.playCalls).toHaveLength(2);
    expect(t.playCalls[1]).toMatchObject({ uri: TRACK_B.uri });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.playCalls).toHaveLength(2);
  });

  it('snapshot に intentAt / issuedAt / resolvedAt が入る', async () => {
    const t = fakeTarget();
    t.setPlayImpl(() => new Promise<void>((r) => setTimeout(r, 120)));
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    ctl.setActiveTrack(TRACK_A, 0);
    expect(ctl.snapshot()).toMatchObject({ intentAt: 1_000_000, issuedAt: 1_000_000, resolvedAt: null });
    await vi.advanceTimersByTimeAsync(120);
    expect(ctl.snapshot().resolvedAt).toBe(1_000_120);
  });

  it('同じ曲・同じ index の再指定は無視する', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(300);
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(300);
    expect(t.playCalls).toHaveLength(1);
  });

  it('前の要求が遅れて解決しても、新しい意図を壊さない(abort + seq)', async () => {
    const t = fakeTarget();
    let resolveA: () => void = () => {};
    t.setPlayImpl((call) =>
      call.uri === TRACK_A.uri ? new Promise<void>((r) => (resolveA = r)) : Promise.resolve(),
    );
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(250);
    expect(t.playCalls[0]?.signal?.aborted).toBe(false);
    ctl.setActiveTrack(TRACK_B, 1);
    expect(t.playCalls[0]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(t.playCalls).toHaveLength(2);
    resolveA();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.snapshot().intent?.uri).toBe(TRACK_B.uri);
    expect(ctl.snapshot().requesting).toBe(false);
  });

  it('離れるときに onLeave で再生時間を通知する', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    const leaves: { uri: string; playedMs: number; startMs: number; positionMs: number | null }[] = [];
    ctl.onLeave((info) => leaves.push({ uri: info.intent.uri, playedMs: info.playedMs, startMs: info.startMs, positionMs: info.positionMs }));
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(250);
    expect(ctl.snapshot().startMs).toBe(60_000);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 60_000 }) });
    await vi.advanceTimersByTimeAsync(5_000);
    ctl.setActiveTrack(TRACK_B, 1);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.uri).toBe(TRACK_A.uri);
    expect(leaves[0]?.playedMs).toBe(5_000);
    // 開始位置(hook 30%)と、離れたときの補間位置も渡す(一時停止を含まない完了率に使う)
    expect(leaves[0]?.startMs).toBe(60_000);
    expect(leaves[0]?.positionMs).toBe(65_000);
    // 別の曲の状態しか無ければ位置は不明
    ctl.setActiveTrack(TRACK_A, 2);
    expect(leaves[1]?.positionMs).toBeNull();
  });
});

describe('reconcile', () => {
  it('要求の解決後に別の曲が報告されていれば 1.5 秒で 1 回だけ再送する', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    ctl.setActiveTrack(TRACK_B, 1);
    await vi.advanceTimersByTimeAsync(250);
    expect(t.playCalls).toHaveLength(1);
    // 要求は既に解決済み。そのあとで別の曲の状態が届く
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 1000 }) });
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.playCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.playCalls).toHaveLength(2);
  });

  it('解決後に何も報告が無ければ 1.5 秒では再送せず、3 秒で 1 回だけ再送する', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    ctl.setActiveTrack(TRACK_B, 1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.playCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.playCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.playCalls).toHaveLength(2);
  });

  it('要求より前の古い曲の状態しか無い場合も 3 秒まで待つ', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 1000 }) });
    await vi.advanceTimersByTimeAsync(10);
    ctl.setActiveTrack(TRACK_B, 1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.playCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.playCalls).toHaveLength(2);
  });

  it('期待の曲なら loading 中でも再送しない', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    ctl.setActiveTrack(TRACK_B, 1);
    await vi.advanceTimersByTimeAsync(100);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_B.uri, positionMs: 0, paused: true, loading: true }) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.playCalls).toHaveLength(1);
  });

  it('期待どおりの曲が報告されていれば再送しない', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    ctl.setActiveTrack(TRACK_B, 1);
    await vi.advanceTimersByTimeAsync(250);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_B.uri, positionMs: 60_000 }) });
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.playCalls).toHaveLength(1);
  });
});

describe('自動送り', () => {
  it('60 秒モード: 開始位置から 60 秒鳴ったら onAdvance(1 回だけ)', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    const advanced: number[] = [];
    ctl.onAdvance((i) => advanced.push(i));
    ctl.setActiveTrack(TRACK_A, 3);
    await vi.advanceTimersByTimeAsync(250);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 60_000 }) });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(advanced).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(advanced).toEqual([3]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(advanced).toEqual([3]);
  });

  it('一時停止中は進めない', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    const advanced: number[] = [];
    ctl.onAdvance((i) => advanced.push(i));
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(250);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 60_000 }) });
    await vi.advanceTimersByTimeAsync(30_000);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 90_000, paused: true }) });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(advanced).toEqual([]);
  });

  it('full モード: 曲の終わり(SDK が paused/position 0 に戻る)で進む', async () => {
    const t = fakeTarget();
    settings = { ...settings, advanceAfterMs: null };
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    const advanced: number[] = [];
    ctl.onAdvance((i) => advanced.push(i));
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(250);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 150_000, durationMs: 200_000 }) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(advanced).toEqual([]);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 0, durationMs: 200_000, paused: true }) });
    expect(advanced).toEqual([0]);
  });

  it('full モード: 状態更新が来なくても補間で終端に達したら進む(Connect の疎なポーリング)', async () => {
    const t = fakeTarget();
    settings = { ...settings, advanceAfterMs: null };
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    const advanced: number[] = [];
    ctl.onAdvance((i) => advanced.push(i));
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(250);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 198_000, durationMs: 200_000 }) });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(advanced).toEqual([0]);
  });

  it('startedAt は loading が解けてから立つ(playedMs は実際に鳴った時間)', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    const leaves: number[] = [];
    ctl.onLeave((info) => leaves.push(info.playedMs));
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(0);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 60_000, loading: true }) });
    expect(ctl.snapshot().startedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(700);
    expect(ctl.snapshot().startedAt).toBeNull();
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 60_700, loading: false }) });
    expect(ctl.snapshot().startedAt).toBe(1_000_700);
    await vi.advanceTimersByTimeAsync(1_000);
    ctl.setActiveTrack(TRACK_B, 1);
    expect(leaves).toEqual([1_000]);
  });

  it('別の曲の状態では進まない', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    const advanced: number[] = [];
    ctl.onAdvance((i) => advanced.push(i));
    ctl.setActiveTrack(TRACK_B, 1);
    await vi.advanceTimersByTimeAsync(250);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 199_900, durationMs: 200_000 }) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(advanced).toEqual([]);
  });
});

describe('エラーと操作', () => {
  it('NO_ACTIVE_DEVICE は no_device、autoplay_blocked は needs_gesture', async () => {
    const t = fakeTarget();
    t.setPlayImpl(async () => {
      throw new ApiError('not_found', 404, 'Device not found', 'NO_ACTIVE_DEVICE');
    });
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    const errors: string[] = [];
    ctl.onError((code) => errors.push(code));
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(250);
    expect(errors).toEqual(['no_device']);
    t.emit({ type: 'autoplay_blocked' });
    expect(errors).toEqual(['no_device', 'needs_gesture']);
    t.emit({ type: 'error', code: 'premium_required', message: 'x' });
    expect(errors[2]).toBe('premium_required');
  });

  it('abort された要求はエラーにしない', async () => {
    const t = fakeTarget();
    t.setPlayImpl(async () => {
      throw new ApiError('aborted', 0, 'aborted');
    });
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    const errors: string[] = [];
    ctl.onError((code) => errors.push(code));
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(250);
    expect(errors).toEqual([]);
  });

  it('retryCurrent は解決済みの意図を即時に再送、togglePause は状態に応じて pause/resume', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(250);
    ctl.retryCurrent();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.playCalls).toHaveLength(2);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 60_000 }) });
    await ctl.togglePause();
    expect(t.paused).toHaveBeenCalledTimes(1);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 61_000, paused: true }) });
    await ctl.togglePause();
    expect(t.resumed).toHaveBeenCalledTimes(1);
  });

  it('snapshot は位置を補間する', async () => {
    const t = fakeTarget();
    ctl = started(createPlaybackController({ target: t.target, settings: () => settings }));
    ctl.setActiveTrack(TRACK_A, 0);
    await vi.advanceTimersByTimeAsync(250);
    t.emit({ type: 'state', state: t.state({ uri: TRACK_A.uri, positionMs: 60_000, durationMs: 200_000 }) });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ctl.snapshot().positionMs).toBe(62_000);
    expect(ctl.snapshot().durationMs).toBe(200_000);
    expect(ctl.snapshot().playingUri).toBe(TRACK_A.uri);
  });
});
