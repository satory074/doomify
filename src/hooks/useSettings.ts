import { useCallback, useEffect, useState } from 'react';
import type { FeedSettings } from '../core/feed/feedEngine';
import type { PlaybackSettings } from '../core/playback/controller';

export type AdvanceMode = 'full' | 60 | 30;

export interface Settings {
  startPosition: 'beginning' | 'hook';
  advance: AdvanceMode;
  /** 発見度 0..1 */
  discovery: number;
  genres: string[];
  /** MusicBrainz / ListenBrainz で類似アーティストとタグを探す(アーティスト名と ISRC が送られる) */
  externalSources: boolean;
  /** 自動検出したジャンルのうち使わないもの */
  excludedTags: string[];
  playbackTarget: 'sdk' | 'connect';
  connectDeviceId: string | null;
  connectDeviceName: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  startPosition: 'hook',
  advance: 60,
  discovery: 0.5,
  genres: [],
  externalSources: true,
  excludedTags: [],
  playbackTarget: 'sdk',
  connectDeviceId: null,
  connectDeviceName: null,
};

const STORAGE_KEY = 'doomify:settings:v1';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(parsed as Partial<Settings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function toPlaybackSettings(s: Settings): PlaybackSettings {
  return {
    startPosition: s.startPosition,
    hookRatio: 0.3,
    advanceAfterMs: s.advance === 'full' ? null : s.advance * 1000,
  };
}

export function toFeedSettings(s: Settings): FeedSettings {
  return { discovery: s.discovery, genres: s.genres, externalSources: s.externalSources, excludedTags: s.excludedTags };
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // 保存できなくても既定値で動作を続ける
    }
  }, [settings]);

  const update = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);
  return [settings, update];
}
