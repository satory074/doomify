import { FEED_CONSTANTS } from '../core/feed/feedEngine';
import type { FeedItem } from '../core/feed/types';
import type { ControllerSnapshot } from '../core/playback/controller';
import { pickImage } from '../core/spotify/types';
import { useCoverPalette } from '../hooks/useCoverPalette';
import { CardShell } from './CardShell';
import { TrackCard, type FeedbackMark } from './TrackCard';

interface Props {
  containerRef: React.RefObject<HTMLDivElement | null>;
  items: readonly FeedItem[];
  active: number;
  snapshot: ControllerSnapshot;
  isLiked: (item: FeedItem) => boolean;
  markOf: (item: FeedItem) => FeedbackMark | null;
  likeBusyId: string | null;
  isMobile: boolean;
  loading: boolean;
  exhausted: boolean;
  full: boolean;
  error: string | null;
  onTogglePause: () => void;
  onLike: (item: FeedItem) => void;
  onAddToPlaylist: (item: FeedItem) => void;
  onShare: (item: FeedItem) => void;
  onOpen: (item: FeedItem) => void;
  onMore: (item: FeedItem) => void;
  onLess: (item: FeedItem) => void;
  onRestart: () => void;
  onRetry: () => void;
}

const RENDER_WINDOW = 2;

export function Feed(props: Props) {
  const { containerRef, items, active } = props;
  // 最初の種を待つ間は、実カードと同じ寸法のスケルトンを 1 枚だけ出す(届いたらその場で items に置き換わる)
  const waitingForFirst = items.length === 0 && props.error === null && !props.exhausted && !props.full;
  return (
    <div className="feed" ref={containerRef} role="feed" aria-busy={props.loading}>
      {items.map((item, i) => (
        <FeedCard key={item.id} {...props} item={item} index={i} render={Math.abs(i - active) <= RENDER_WINDOW} />
      ))}
      {waitingForFirst ? (
        <SkeletonCard />
      ) : (
        <article className="card card-tail" aria-live="polite">
          {props.full ? (
            <TailMessage
              title={`ここまでで ${FEED_CONSTANTS.maxItems} 曲`}
              body="続きは新しいフィードで。履歴は残ります。"
              action="続きを読み込む"
              onAction={props.onRestart}
            />
          ) : props.error !== null ? (
            <TailMessage title="読み込めませんでした" body={props.error} action="もう一度" onAction={props.onRetry} />
          ) : props.exhausted ? (
            <TailMessage title="次の曲が見つかりません" body="設定で発見度を上げるか、履歴を消すと続きが出てきます。" action="もう一度探す" onAction={props.onRetry} />
          ) : (
            <TailMessage title="次の曲を探しています" body="" action={null} onAction={() => {}} />
          )}
        </article>
      )}
    </div>
  );
}

function TailMessage({ title, body, action, onAction }: { title: string; body: string; action: string | null; onAction: () => void }) {
  return (
    <div className="tail">
      <p className="tail-title">{title}</p>
      {body !== '' ? <p className="muted">{body}</p> : null}
      {action !== null ? (
        <button type="button" className="btn" onClick={onAction}>
          {action}
        </button>
      ) : (
        <span className="spinner" aria-hidden="true" />
      )}
    </div>
  );
}

/** 最初の種を待つ間のカード。アートも曲名も出さない中立の形だけで、実カードと同じレイアウト(切り替え時にずれない) */
function SkeletonCard() {
  return (
    <article className="card card-skeleton" aria-busy="true" aria-label="あなたの曲を集めています">
      <div className="card-content">
        <div className="card-art-wrap">
          <div className="skeleton-art" aria-hidden="true" />
        </div>
        <div className="card-body" aria-hidden="true">
          <span className="skeleton-line skeleton-reason" />
          <span className="skeleton-line skeleton-title" />
          <span className="skeleton-line skeleton-artist" />
          <span className="skeleton-line skeleton-album" />
          <p className="skeleton-caption">あなたの曲を集めています</p>
        </div>
      </div>
    </article>
  );
}

function FeedCard(props: Props & { item: FeedItem; index: number; render: boolean }) {
  const { item, index, render, active } = props;
  const isActive = index === active;
  const image = render ? pickImage(item.track.album.images, 300) : undefined;
  const palette = useCoverPalette(image?.url);
  return (
    <CardShell index={index} active={isActive} palette={render ? palette : null}>
      {render ? (
        <TrackCard
          item={item}
          active={isActive}
          snapshot={isActive ? props.snapshot : null}
          liked={props.isLiked(item)}
          likeBusy={props.likeBusyId === item.id}
          mark={props.markOf(item)}
          isMobile={props.isMobile}
          eager={Math.abs(index - active) <= 1}
          onTogglePause={props.onTogglePause}
          onLike={() => props.onLike(item)}
          onAddToPlaylist={() => props.onAddToPlaylist(item)}
          onShare={() => props.onShare(item)}
          onOpen={() => props.onOpen(item)}
          onMore={() => props.onMore(item)}
          onLess={() => props.onLess(item)}
        />
      ) : null}
    </CardShell>
  );
}
