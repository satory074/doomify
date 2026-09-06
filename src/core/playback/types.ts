/** 再生先(ブラウザ内 SDK / Spotify Connect 遠隔)の共通インターフェース */

export interface PlaybackState {
  uri: string | null;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  /** SDK がバッファ中でまだ音が出ていない。SDK 以外の再生先は常に false */
  loading: boolean;
  /** この状態を観測した時刻(epoch ms)。位置の補間に使う */
  updatedAt: number;
}

export type TargetErrorCode =
  | 'premium_required'
  | 'auth'
  | 'init'
  | 'playback'
  | 'no_device'
  | 'network'
  | 'rate_limited'
  | 'unknown';

export type TargetEvent =
  | { type: 'ready'; deviceId: string }
  | { type: 'not_ready' }
  /** ブラウザの自動再生制限で再生が始まらなかった。ユーザーのタップが必要 */
  | { type: 'autoplay_blocked' }
  | { type: 'state'; state: PlaybackState }
  | { type: 'error'; code: TargetErrorCode; message: string };

export interface PlaybackTarget {
  readonly kind: 'sdk' | 'connect';
  /** UI 表示名(例: このブラウザ / iPhone) */
  readonly label: string;
  readonly deviceId: string | null;
  /** SDK のロード+接続 / Connect の初期状態取得 */
  init(): Promise<void>;
  /** ユーザー操作(タップ)ハンドラ内で同期的に呼ぶ。SDK では activateElement() */
  activate(): Promise<void>;
  play(uri: string, positionMs: number, signal?: AbortSignal): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  getState(): Promise<PlaybackState | null>;
  subscribe(listener: (event: TargetEvent) => void): () => void;
  dispose(): void;
}
