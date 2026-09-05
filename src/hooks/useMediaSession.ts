import { useEffect } from 'react';
import type { FeedItem } from '../core/feed/types';
import { formatArtists } from '../core/format';

interface Handlers {
  togglePause: () => void;
  next: () => void;
  previous: () => void;
}

/** ロック画面・通知にいま流れている曲を出す(対応ブラウザのみ) */
export function useMediaSession(item: FeedItem | undefined, paused: boolean, handlers: Handlers): void {
  useEffect(() => {
    if (!('mediaSession' in navigator) || item === undefined) return;
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({
      title: item.track.name,
      artist: formatArtists(item.track),
      album: item.track.album.name,
      artwork: item.track.album.images.map((img) => ({
        src: img.url,
        sizes: img.width !== null && img.height !== null ? `${img.width}x${img.height}` : '',
        type: 'image/jpeg',
      })),
    });
    const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', handlers.togglePause],
      ['pause', handlers.togglePause],
      ['nexttrack', handlers.next],
      ['previoustrack', handlers.previous],
    ];
    for (const [action, handler] of actions) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // 未対応のアクションは無視
      }
    }
    return () => {
      for (const [action] of actions) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
    };
  }, [item, handlers]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
  }, [paused]);
}
