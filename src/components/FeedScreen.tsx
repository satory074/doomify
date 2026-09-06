import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthState } from '../core/auth/authManager';
import { readEnvironment } from '../core/env';
import type { FeedItem } from '../core/feed/types';
import type { LeaveInfo } from '../core/playback/controller';
import { trackIdFromUri } from '../core/spotify/types';
import { createValueStore } from '../core/valueStore';
import { useActiveIndex, type IntentSource } from '../hooks/useActiveIndex';
import { useFeed } from '../hooks/useFeed';
import { useKeyboardNav } from '../hooks/useKeyboardNav';
import { useMediaSession } from '../hooks/useMediaSession';
import { usePlayback, type PlaybackCallbacks } from '../hooks/usePlayback';
import { toFeedSettings, toPlaybackSettings, type Settings } from '../hooks/useSettings';
import { useToasts } from '../hooks/useToasts';
import type { Services } from '../services';
import { DevicePicker, type DeviceChoice } from './DevicePicker';
import { Feed } from './Feed';
import { PlaylistPicker } from './PlaylistPicker';
import { SettingsSheet } from './SettingsSheet';
import { preloadCovers } from './coverPreload';
import { TapToStartGate } from './TapToStartGate';
import { ToastStack } from './Toast';
import { TopBar } from './TopBar';
import type { FeedbackMark } from './TrackCard';
import { UpdatePrompt } from './UpdatePrompt';

interface Props {
  services: Services;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  authStatus: Exclude<AuthState, 'signed-out'>;
  onLogout: () => void;
}

/** 連続でこの回数失敗したら Spotify アプリでの再生を提案する */
const SUGGEST_CONNECT_AFTER = 2;

export function FeedScreen({ services, settings, updateSettings, authStatus, onLogout }: Props) {
  const [env] = useState(readEnvironment);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 設定はエンジン/コントローラに「最新値を読む箱」で渡す(再生成を避ける)
  const [feedSettingsStore] = useState(() => createValueStore(toFeedSettings(settings)));
  const [playbackSettingsStore] = useState(() => createValueStore(toPlaybackSettings(settings)));
  useEffect(() => {
    feedSettingsStore.set(toFeedSettings(settings));
    playbackSettingsStore.set(toPlaybackSettings(settings));
  }, [settings, feedSettingsStore, playbackSettingsStore]);

  const { engine, items, status } = useFeed(services, feedSettingsStore);
  // 意図(向かっている先)は usePlayback より前に必要になるので、実体は後で差し替えるトランポリン経由で受ける
  const intentHandlerRef = useRef<(index: number, source: IntentSource) => void>(() => {});
  const onIntent = useCallback((index: number, source: IntentSource) => intentHandlerRef.current(index, source), []);
  const { active, scrollToIndex } = useActiveIndex(containerRef, items.length, { onIntent });
  const { toasts, show: toast, dismiss } = useToasts();

  const itemsRef = useRef(items);
  const activeRef = useRef(active);
  const settingsRef = useRef(settings);
  useEffect(() => {
    itemsRef.current = items;
    activeRef.current = active;
    settingsRef.current = settings;
  }, [items, active, settings]);

  const [deviceOpen, setDeviceOpen] = useState(false);
  const [suggestConnect, setSuggestConnect] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [playlistTarget, setPlaylistTarget] = useState<FeedItem | null>(null);

  const goTo = useCallback(
    (index: number) => {
      const list = itemsRef.current;
      if (index < 0) return;
      if (index >= list.length) {
        void engine.ensureAhead(list.length - 1).then(() => {
          if (itemsRef.current.length > index) scrollToIndex(index);
        });
        return;
      }
      scrollToIndex(index);
    },
    [engine, scrollToIndex],
  );

  const callbacks = useMemo<PlaybackCallbacks>(
    () => ({
      onAdvance: (from) => goTo(from + 1),
      onLeave: (info: LeaveInfo) => {
        const id = trackIdFromUri(info.intent.uri);
        if (id === null) return;
        const advance = settingsRef.current.advance;
        engine.markLeft(id, {
          playedMs: info.playedMs,
          durationMs: info.intent.durationMs,
          cause: info.cause,
          advanceAfterMs: advance === 'full' ? null : advance * 1000,
        });
      },
      onError: (code, message) => {
        switch (code) {
          case 'needs_gesture':
            break;
          case 'no_device':
            toast('再生先が見つかりません', { action: { label: '再生先を選ぶ', onClick: () => setDeviceOpen(true) }, duration: 6000 });
            break;
          case 'premium_required':
            toast('フル再生には Spotify Premium が必要です', { duration: 0 });
            break;
          case 'rate_limited':
            toast('Spotify が混雑しています。少し待ってください', { duration: 5000 });
            break;
          case 'network':
            toast('ネットワークに接続できません', { duration: 4000 });
            break;
          case 'auth':
            toast('ログインが切れました。もう一度ログインしてください', { action: { label: 'ログイン画面へ', onClick: onLogout }, duration: 0 });
            break;
          default:
            toast(`再生できませんでした: ${message}`, { duration: 5000 });
        }
      },
      onFailureStreak: (streak, kind) => {
        if (kind === 'sdk' && streak >= SUGGEST_CONNECT_AFTER) {
          setSuggestConnect(true);
          setDeviceOpen(true);
        }
      },
    }),
    [goTo, engine, toast, onLogout],
  );

  const playback = usePlayback(services, settings, playbackSettingsStore, callbacks);
  const { controller, target, snapshot } = playback;

  const startedRef = useRef(playback.started);
  useEffect(() => {
    startedRef.current = playback.started;
  }, [playback.started]);

  // 向かう先が分かった瞬間(スナップ完了前)に再生要求を出す。React state を経由しないので描画を待たない
  const lastIntentSourceRef = useRef<IntentSource | null>(null);
  useEffect(() => {
    intentHandlerRef.current = (index, source) => {
      lastIntentSourceRef.current = source;
      const item = itemsRef.current[index];
      if (item !== undefined && startedRef.current) {
        controller.setActiveTrack({ uri: item.track.uri, durationMs: item.track.duration_ms }, index);
      }
      preloadCovers(itemsRef.current, index);
      // 補充の GET は再生要求を積んだ後に(同じキューで再生要求の前に並ばないように)
      void engine.ensureAhead(index);
    };
  }, [controller, engine]);

  // アクティブカードの確定。通常は意図と同じ曲なので controller 側で no-op。items が増えたときの先読みと補充もここで
  const commitAtRef = useRef<number | null>(null);
  const prevActiveRef = useRef(active);
  useEffect(() => {
    commitAtRef.current = Date.now();
    // 前のカードに戻ってきたら、その曲への正のフィードバック
    if (active < prevActiveRef.current) {
      const item = itemsRef.current[active];
      if (item !== undefined) engine.markReturned(item.id);
    }
    prevActiveRef.current = active;
  }, [active, engine]);
  useEffect(() => {
    const item = items[active];
    if (item !== undefined && playback.started) {
      controller.setActiveTrack({ uri: item.track.uri, durationMs: item.track.duration_ms }, active);
    }
    preloadCovers(items, active);
    void engine.ensureAhead(active);
  }, [active, items, engine, controller, playback.started]);

  // 開発時のみ: ブラウザのコンソールから移動を試せるようにする(自動テスト用)と、スワイプ → 発音の遅延の内訳
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const diff = (from: number | null, to: number | null) => (from === null || to === null ? null : to - from);
    const timing = () => {
      const s = controller.snapshot();
      return {
        index: s.intent?.index ?? null,
        source: lastIntentSourceRef.current,
        intentAt: s.intentAt,
        issuedAt: s.issuedAt,
        resolvedAt: s.resolvedAt,
        startedAt: s.startedAt,
        commitAt: commitAtRef.current,
        intentToIssueMs: diff(s.intentAt, s.issuedAt),
        intentToResolveMs: diff(s.intentAt, s.resolvedAt),
        intentToStartMs: diff(s.intentAt, s.startedAt),
        intentToCommitMs: commitAtRef.current !== null && s.intentAt !== null && commitAtRef.current >= s.intentAt ? commitAtRef.current - s.intentAt : null,
      };
    };
    window.__doomify = {
      goTo,
      scrollToIndex,
      snapshot: () => controller.snapshot(),
      timing,
      feedStats: () => engine.feedStats(),
      items: () => engine.items().map((i) => ({ id: i.id, name: i.track.name, artist: i.track.artists[0]?.name ?? '', reason: i.reason, detail: i.reasonDetail ?? null, bucket: i.bucket, strategy: i.strategy ?? null, hop: i.hop ?? null, saved: i.saved ?? null })),
    };
    let loggedFor: number | null = null;
    const unsubscribe = controller.subscribe((s) => {
      if (s.startedAt === null || s.intentAt === null || loggedFor === s.intentAt) return;
      loggedFor = s.intentAt;
      // resolvedAt は play() の解決後に入る(デモは解決前に state を出す)ので、同期の連鎖が終わってから読む
      const intentAt = s.intentAt;
      setTimeout(() => {
        const t = timing();
        if (t.intentAt !== intentAt) return;
        console.debug(
          `[doomify] #${t.index} (${t.source}) intent→issued +${t.intentToIssueMs}ms, →resolved +${t.intentToResolveMs}ms, →started +${t.intentToStartMs}ms, commit +${t.intentToCommitMs}ms`,
        );
      }, 0);
    });
    return () => {
      unsubscribe();
      delete window.__doomify;
    };
  }, [goTo, scrollToIndex, controller, engine]);

  useEffect(() => {
    return services.client.onRateLimit((info) => {
      const sec = Math.max(1, Math.round((info.untilMs - Date.now()) / 1000));
      toast(
        info.reason === 'quota' ? `利用上限に近づいています。${sec} 秒ほど新しい曲の取得を控えます` : `Spotify が混雑しています(${sec} 秒待ちます)`,
        { duration: 5000 },
      );
    });
  }, [services.client, toast]);

  // いいね: ユーザーの操作が最優先、無ければエンジンが判定した保存済みフラグ(item.saved)
  const [likeOverrides, setLikeOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map(services.history.likedIds().map((id) => [id, true])));
  const isLiked = useCallback((item: FeedItem) => likeOverrides.get(item.id) ?? item.saved === true, [likeOverrides]);
  const [likeBusyId, setLikeBusyId] = useState<string | null>(null);
  const like = useCallback(
    async (item: FeedItem) => {
      const wasLiked = isLiked(item);
      setLikeBusyId(item.id);
      try {
        if (wasLiked) {
          await services.api.removeFromLibrary([item.track.uri]);
          engine.markUnliked(item.id);
          setLikeOverrides((m) => new Map(m).set(item.id, false));
          toast('保存を取り消しました');
        } else {
          await services.api.saveToLibrary([item.track.uri]);
          engine.markLiked(item.id);
          setLikeOverrides((m) => new Map(m).set(item.id, true));
          toast('お気に入りの曲に保存しました');
        }
      } catch (e) {
        toast(`${wasLiked ? '取り消せ' : '保存でき'}ませんでした: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setLikeBusyId(null);
      }
    },
    [isLiked, services.api, engine, toast],
  );

  // 「こういうのをもっと」「これは違う」
  const [marks, setMarks] = useState<ReadonlyMap<string, FeedbackMark>>(() => new Map());
  const markOf = useCallback((item: FeedItem) => marks.get(item.id) ?? null, [marks]);
  const more = useCallback(
    (item: FeedItem) => {
      engine.markMore(item.id);
      setMarks((m) => new Map(m).set(item.id, 'more'));
      toast('こういう曲を増やします');
    },
    [engine, toast],
  );
  const less = useCallback(
    (item: FeedItem) => {
      engine.markLess(item.id);
      setMarks((m) => new Map(m).set(item.id, 'less'));
      toast('このアーティストはしばらく出しません');
      const index = itemsRef.current.indexOf(item);
      if (index !== -1 && index === activeRef.current) goTo(index + 1);
    },
    [engine, toast, goTo],
  );
  const open = useCallback((item: FeedItem) => engine.markOpened(item.id), [engine]);

  const activeItem = items[active];
  const togglePause = useCallback(() => void controller.togglePause(), [controller]);
  const keyHandlers = useMemo(
    () => ({
      next: () => goTo(activeRef.current + 1),
      previous: () => goTo(activeRef.current - 1),
      togglePause,
      like: () => {
        const item = itemsRef.current[activeRef.current];
        if (item !== undefined) void like(item);
      },
    }),
    [goTo, togglePause, like],
  );
  useKeyboardNav(keyHandlers, !settingsOpen && !deviceOpen && playlistTarget === null);
  useMediaSession(activeItem, snapshot.paused, keyHandlers);

  const chooseDevice = (choice: DeviceChoice) => {
    setDeviceOpen(false);
    setSuggestConnect(false);
    if (choice.kind === 'sdk') {
      updateSettings({ playbackTarget: 'sdk', connectDeviceId: null, connectDeviceName: null });
      return;
    }
    updateSettings({ playbackTarget: 'connect', connectDeviceId: choice.device.id, connectDeviceName: choice.device.name });
    toast(`${choice.device.name} で再生します`);
  };

  // 再生先を Connect に切り替えた直後は、いまのカードを新しい再生先で鳴らす
  const startFromGesture = playback.startFromGesture;
  useEffect(() => {
    if (target.kind !== 'connect') return;
    const item = itemsRef.current[activeRef.current];
    if (item === undefined) return;
    startFromGesture({ uri: item.track.uri, durationMs: item.track.duration_ms }, activeRef.current);
  }, [target, startFromGesture]);

  const authNote =
    authStatus === 'expiring-soon'
      ? 'まもなく Spotify の認可が切れます(6 か月ごと)。ログアウトして再ログインすると更新されます。'
      : authStatus === 'reauth-required'
        ? 'Spotify の認可期限(6 か月)を過ぎている可能性があります。再生できなくなったら再ログインしてください。'
        : null;

  const gateVisible = target.kind === 'sdk' && (!playback.started || playback.needsGesture) && items.length > 0;
  const gateMode: 'start' | 'resume' = playback.started ? 'resume' : 'start';
  const gateDisabled = !snapshot.ready && playback.initError === null;
  const gateHint =
    playback.initError !== null
      ? `このブラウザでは再生を準備できませんでした: ${playback.initError}`
      : playback.needsGesture && playback.started
        ? '画面を閉じていた間に再生が止まりました'
        : null;

  return (
    <div className="screen">
      <Feed
        containerRef={containerRef}
        items={items}
        active={active}
        snapshot={snapshot}
        isLiked={isLiked}
        markOf={markOf}
        likeBusyId={likeBusyId}
        isMobile={env.isMobile}
        loading={status.loading}
        exhausted={status.exhausted}
        full={status.full}
        error={status.error}
        onTogglePause={togglePause}
        onLike={(item) => void like(item)}
        onAddToPlaylist={setPlaylistTarget}
        onOpen={open}
        onMore={more}
        onLess={less}
        onRestart={() => {
          void engine.restart().then(() => scrollToIndex(0, 'instant'));
        }}
        onRetry={() => void engine.ensureAhead(active)}
      />
      <TopBar targetLabel={target.label} onChooseDevice={() => setDeviceOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
      {gateVisible ? (
        <TapToStartGate
          mode={gateMode}
          disabled={gateDisabled}
          hint={gateHint}
          onTap={() => {
            const item = itemsRef.current[activeRef.current];
            if (item === undefined) return;
            startFromGesture({ uri: item.track.uri, durationMs: item.track.duration_ms }, activeRef.current);
          }}
          onChooseDevice={() => setDeviceOpen(true)}
        />
      ) : null}
      <DevicePicker
        open={deviceOpen}
        services={services}
        current={{ kind: target.kind, deviceId: settings.connectDeviceId }}
        isIos={env.isIos}
        suggestConnect={suggestConnect}
        onChoose={chooseDevice}
        onClose={() => setDeviceOpen(false)}
      />
      <PlaylistPicker
        open={playlistTarget !== null}
        services={services}
        track={playlistTarget?.track ?? null}
        onDone={(message) => {
          if (playlistTarget !== null) engine.markAddedToPlaylist(playlistTarget.id);
          setPlaylistTarget(null);
          toast(message);
        }}
        onClose={() => setPlaylistTarget(null)}
      />
      <SettingsSheet
        open={settingsOpen}
        settings={settings}
        authNote={authNote}
        stats={settingsOpen ? engine.feedStats() : null}
        onUpdate={updateSettings}
        onResetHistory={() => {
          setSettingsOpen(false);
          void engine.reset().then(() => {
            setLikeOverrides(new Map());
            setMarks(new Map());
            scrollToIndex(0, 'instant');
            toast('履歴を消して、フィードを作り直しました');
          });
        }}
        onLogout={onLogout}
        onClose={() => setSettingsOpen(false)}
      />
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      <UpdatePrompt />
    </div>
  );
}
