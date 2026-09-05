import type { FeedItem } from '../core/feed/types';
import type { ControllerSnapshot } from '../core/playback/controller';
import { pickImage } from '../core/spotify/types';
import { useCoverPalette } from '../hooks/useCoverPalette';
import { CardShell } from './CardShell';
import { TrackCard } from './TrackCard';

interface Props {
  containerRef: React.RefObject<HTMLDivElement | null>;
  items: readonly FeedItem[];
  active: number;
  pending: number;
  snapshot: ControllerSnapshot;
  likedIds: ReadonlySet<string>;
  likeBusyId: string | null;
  isMobile: boolean;
  loading: boolean;
  exhausted: boolean;
  full: boolean;
  error: string | null;
  onTogglePause: () => void;
  onLike: (item: FeedItem) => void;
  onAddToPlaylist: (item: FeedItem) => void;
  onRestart: () => void;
  onRetry: () => void;
}

const RENDER_WINDOW = 2;

export function Feed(props: Props) {
  const { containerRef, items, active, pending } = props;
  return (
    <div className="feed" ref={containerRef} role="feed" aria-busy={props.loading}>
      {items.map((item, i) => {
        const render = Math.abs(i - active) <= RENDER_WINDOW || Math.abs(i - pending) <= 1;
        return (
          <FeedCard key={item.id} {...props} item={item} index={i} render={render} />
        );
      })}
      <article className="card card-tail" aria-live="polite">
        {props.full ? (
          <TailMessage title="ここまでで 500 曲" body="続きは新しいフィードで。履歴は残ります。" action="続きを読み込む" onAction={props.onRestart} />
        ) : props.error !== null ? (
          <TailMessage title="読み込めませんでした" body={props.error} action="もう一度" onAction={props.onRetry} />
        ) : props.exhausted ? (
          <TailMessage title="次の曲が見つかりません" body="設定で発見度を上げるか、履歴を消すと続きが出てきます。" action="もう一度探す" onAction={props.onRetry} />
        ) : (
          <TailMessage title={items.length === 0 ? 'あなたの曲を集めています' : '次の曲を探しています'} body="" action={null} onAction={() => {}} />
        )}
      </article>
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
          liked={props.likedIds.has(item.id)}
          likeBusy={props.likeBusyId === item.id}
          isMobile={props.isMobile}
          eager={Math.abs(index - active) <= 1}
          onTogglePause={props.onTogglePause}
          onLike={() => props.onLike(item)}
          onAddToPlaylist={() => props.onAddToPlaylist(item)}
        />
      ) : null}
    </CardShell>
  );
}
