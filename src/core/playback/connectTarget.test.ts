import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpotifyApi } from '../spotify/endpoints';
import type { PlayerState } from '../spotify/types';
import { createConnectTarget, toPlaybackState } from './connectTarget';
import type { TargetEvent } from './types';

function fakePlayerApi(stateImpl: () => PlayerState | null) {
  const calls: string[] = [];
  const api: SpotifyApi['player'] = {
    state: async () => {
      calls.push('state');
      return stateImpl();
    },
    devices: async () => [],
    transfer: async () => {},
    play: async (deviceId, opts) => {
      calls.push(`play:${deviceId}:${opts.uris.join(',')}:${opts.positionMs ?? ''}`);
    },
    pause: async () => {
      calls.push('pause');
    },
    resume: async () => {
      calls.push('resume');
    },
    seek: async () => {
      calls.push('seek');
    },
  };
  return { api, calls };
}

const playing: PlayerState = {
  device: { id: 'phone', is_active: true, is_restricted: false, name: 'iPhone', type: 'Smartphone', volume_percent: 50 },
  is_playing: true,
  progress_ms: 12_000,
  timestamp: 0,
  item: {
    id: 'x',
    uri: 'spotify:track:x',
    name: 'X',
    duration_ms: 180_000,
    artists: [],
    album: { id: 'al', name: 'AL', uri: 'spotify:album:al', images: [] },
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(5_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('toPlaybackState', () => {
  it('null は停止状態、再生中は item から uri/duration を取る', () => {
    expect(toPlaybackState(null, 1)).toEqual({ uri: null, positionMs: 0, durationMs: 0, paused: true, updatedAt: 1 });
    expect(toPlaybackState(playing, 2)).toEqual({ uri: 'spotify:track:x', positionMs: 12_000, durationMs: 180_000, paused: false, updatedAt: 2 });
  });
});

describe('createConnectTarget', () => {
  it('play は device_id 付きで要求し、楽観的状態 → 確認ポーリング → 再生中は 10 秒間隔で継続', async () => {
    const { api, calls } = fakePlayerApi(() => playing);
    const target = createConnectTarget({ player: api, deviceId: 'phone', label: 'iPhone', isVisible: () => true });
    const events: TargetEvent[] = [];
    target.subscribe((e) => events.push(e));

    await target.play('spotify:track:x', 54_000);
    expect(calls).toEqual(['play:phone:spotify:track:x:54000']);
    expect(events[0]).toMatchObject({ type: 'state', state: { uri: 'spotify:track:x', positionMs: 54_000, paused: false } });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls.filter((c) => c === 'state')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.filter((c) => c === 'state')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.filter((c) => c === 'state')).toHaveLength(3);
    target.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.filter((c) => c === 'state')).toHaveLength(3);
  });

  it('停止中はポーリングを続けない、非表示中はポーリングしない', async () => {
    const stopped: PlayerState = { ...playing, is_playing: false };
    let visible = false;
    const { api, calls } = fakePlayerApi(() => stopped);
    const target = createConnectTarget({ player: api, deviceId: 'phone', label: 'iPhone', isVisible: () => visible });
    await target.play('spotify:track:x', 0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls.filter((c) => c === 'state')).toHaveLength(0); // 非表示なので確認ポーリングもスキップ
    visible = true;
    await target.resume();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls.filter((c) => c === 'state')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.filter((c) => c === 'state')).toHaveLength(1); // 停止と分かったので継続しない
    target.dispose();
  });
});
