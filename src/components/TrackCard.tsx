import { useRef } from 'react';
import { reasonLabel, type FeedItem } from '../core/feed/types';
import { formatArtists, yearOf } from '../core/format';
import type { ControllerSnapshot } from '../core/playback/controller';
import { pickImage } from '../core/spotify/types';
import { CardActions } from './CardActions';
import { ProgressBar } from './ProgressBar';

interface Props {
  item: FeedItem;
  active: boolean;
  snapshot: ControllerSnapshot | null;
  liked: boolean;
  likeBusy: boolean;
  isMobile: boolean;
  eager: boolean;
  onTogglePause: () => void;
  onLike: () => void;
  onAddToPlaylist: () => void;
}

const DOUBLE_TAP_MS = 280;

export function TrackCard({ item, active, snapshot, liked, likeBusy, isMobile, eager, onTogglePause, onLike, onAddToPlaylist }: Props) {
  const { track } = item;
  const image = pickImage(track.album.images, 640);
  const year = yearOf(track.album);
  const lastTap = useRef(0);
  const singleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const burstRef = useRef<HTMLSpanElement>(null);

  const showState = active && snapshot !== null && snapshot.playingUri === track.uri;
  const pendingState = active && snapshot !== null && snapshot.playingUri !== track.uri;

  const onArtTap = () => {
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      if (singleTimer.current !== null) {
        clearTimeout(singleTimer.current);
        singleTimer.current = null;
      }
      if (!liked) onLike();
      const el = burstRef.current;
      if (el !== null) {
        el.classList.remove('is-burst');
        void el.offsetWidth;
        el.classList.add('is-burst');
      }
      return;
    }
    lastTap.current = now;
    singleTimer.current = setTimeout(() => {
      singleTimer.current = null;
      if (active) onTogglePause();
    }, DOUBLE_TAP_MS);
  };

  return (
    <div className="card-content">
      <div className="card-art-wrap">
        <button type="button" className="card-art-button" onClick={onArtTap} aria-label={active ? '一時停止・再開(2 回タップで保存)' : 'このカードへ'}>
          {image !== undefined ? (
            <img
              className="card-art"
              src={image.url}
              alt={`${track.album.name} のカバーアート`}
              crossOrigin="anonymous"
              loading={eager ? 'eager' : 'lazy'}
              decoding="async"
              draggable={false}
            />
          ) : (
            <span className="card-art card-art-empty" aria-hidden="true" />
          )}
          <span ref={burstRef} className="heart-burst" aria-hidden="true">
            ♥
          </span>
          {showState && snapshot.paused ? (
            <span className="paused-badge" aria-hidden="true">
              一時停止
            </span>
          ) : null}
        </button>
      </div>
      <div className="card-body">
        <p className="card-reason">{reasonLabel(item)}</p>
        <h2 className="card-title">{track.name}</h2>
        <p className="card-artist">{formatArtists(track)}</p>
        <p className="card-album">
          {track.album.name}
          {year !== null ? <span className="card-year"> {year}</span> : null}
        </p>
        {active ? (
          <ProgressBar
            positionMs={showState ? snapshot.positionMs : 0}
            durationMs={showState && snapshot.durationMs > 0 ? snapshot.durationMs : track.duration_ms}
            pending={pendingState}
            paused={showState ? snapshot.paused : false}
          />
        ) : (
          <div className="progress progress-placeholder" aria-hidden="true" />
        )}
        <CardActions track={track} liked={liked} busy={likeBusy} isMobile={isMobile} onLike={onLike} onAddToPlaylist={onAddToPlaylist} />
      </div>
    </div>
  );
}
