import { SPOTIFY_TRACK_DEEPLINK, SPOTIFY_TRACK_URL } from '../core/config';
import type { Track } from '../core/spotify/types';
import { SpotifyIcon } from './SpotifyMark';

interface Props {
  track: Track;
  liked: boolean;
  busy: boolean;
  isMobile: boolean;
  onLike: () => void;
  onAddToPlaylist: () => void;
  /** 「Spotify で開く」を押した(強い正のフィードバック) */
  onOpen: () => void;
}

export function CardActions({ track, liked, busy, isMobile, onLike, onAddToPlaylist, onOpen }: Props) {
  const openUrl = SPOTIFY_TRACK_URL(track.id);
  return (
    <div className="actions">
      <button type="button" className="btn" aria-pressed={liked} onClick={onLike} disabled={busy}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill={liked ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
            d="M12 21s-7.5-4.6-9.5-9A5.4 5.4 0 0 1 12 6.3 5.4 5.4 0 0 1 21.5 12c-2 4.4-9.5 9-9.5 9z"
          />
        </svg>
        {liked ? '保存済み' : '保存'}
      </button>
      <button type="button" className="btn" onClick={onAddToPlaylist}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M3 6h12v2H3zm0 4h12v2H3zm0 4h8v2H3zm14 0v-3h2v3h3v2h-3v3h-2v-3h-3v-2z" />
        </svg>
        プレイリストへ
      </button>
      <a
        className="btn btn-spotify"
        href={openUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          onOpen();
          if (!isMobile) return;
          // スマホではまずアプリを開く。失敗しても href の Web 版へ
          e.preventDefault();
          const fallback = setTimeout(() => window.open(openUrl, '_blank', 'noopener'), 700);
          window.addEventListener('pagehide', () => clearTimeout(fallback), { once: true });
          window.location.href = SPOTIFY_TRACK_DEEPLINK(track.id);
        }}
      >
        <SpotifyIcon size={21} />
        Spotify で開く
      </a>
    </div>
  );
}
