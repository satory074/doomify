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
  /** 共有した(共有シート / リンクのコピー。最重要シグナルの 1 つ) */
  onShare: () => void;
  /** 「Spotify で開く」を押した(強い正のフィードバック) */
  onOpen: () => void;
}

/** 操作行。保存 / 追加 / 共有はアイコン + 小ラベル(幅 48px)、「Spotify で開く」はロゴと文言のまま残りの幅いっぱい */
export function CardActions({ track, liked, busy, isMobile, onLike, onAddToPlaylist, onShare, onOpen }: Props) {
  const openUrl = SPOTIFY_TRACK_URL(track.id);
  return (
    <div className="actions">
      {/* トグルは状態でラベルを変えない(幅も読み上げ名も一定)。状態は aria-pressed と塗りのハートで示す */}
      <button type="button" className="btn btn-action" aria-pressed={liked} onClick={onLike} disabled={busy}>
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill={liked ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
            d="M12 21s-7.5-4.6-9.5-9A5.4 5.4 0 0 1 12 6.3 5.4 5.4 0 0 1 21.5 12c-2 4.4-9.5 9-9.5 9z"
          />
        </svg>
        <span>保存</span>
      </button>
      <button type="button" className="btn btn-action" aria-label="プレイリストに追加" onClick={onAddToPlaylist}>
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M3 6h12v2H3zm0 4h12v2H3zm0 4h8v2H3zm14 0v-3h2v3h3v2h-3v3h-2v-3h-3v-2z" />
        </svg>
        <span>追加</span>
      </button>
      <button type="button" className="btn btn-action" onClick={onShare}>
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 3v12M7 8l5-5 5 5M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
        </svg>
        <span>共有</span>
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
        <SpotifyIcon size={21} decorative />
        <span>Spotify で開く</span>
      </a>
    </div>
  );
}
