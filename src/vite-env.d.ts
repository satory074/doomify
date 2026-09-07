import type { FeedStats, SessionStats } from './core/feed/feedEngine';
import type { ControllerSnapshot } from './core/playback/controller';

declare global {
  interface Window {
    /** 開発時のみ設定されるデバッグ用ハンドル */
    __doomify?: {
      goTo: (index: number) => void;
      scrollToIndex: (index: number, behavior?: ScrollBehavior) => void;
      snapshot: () => ControllerSnapshot;
      /** 直近の意図についての遅延の内訳(ms) */
      timing: () => Record<string, number | string | null>;
      /** フィードの学習状態(戦略の当たり率・探索量・外部データ) */
      feedStats: () => FeedStats;
      /** items の要約(理由・戦略・種・枠・期待値・予測) */
      items: () => Record<string, string | number | boolean | null>[];
      /** このセッションの様子(枚数・分・確信度・興味) */
      session: () => SessionStats;
    };
  }
}

export {};
