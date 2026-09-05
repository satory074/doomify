import { formatTime } from '../core/format';

interface Props {
  positionMs: number;
  durationMs: number;
  /** 切替中(まだこの曲の状態が来ていない) */
  pending: boolean;
  paused: boolean;
}

export function ProgressBar({ positionMs, durationMs, pending, paused }: Props) {
  const ratio = durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;
  return (
    <div className={`progress${pending ? ' is-pending' : ''}`} aria-hidden="true">
      <div className="progress-track">
        <i style={{ width: `${(ratio * 100).toFixed(2)}%` }} />
      </div>
      <div className="progress-time">
        <span>{pending ? '…' : formatTime(positionMs)}</span>
        <span>{paused && !pending ? '一時停止中' : ''}</span>
        <span>{durationMs > 0 ? formatTime(durationMs) : ''}</span>
      </div>
    </div>
  );
}
