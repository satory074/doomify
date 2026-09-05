import type { ControllerSnapshot } from './core/playback/controller';

declare global {
  interface Window {
    /** 開発時のみ設定されるデバッグ用ハンドル */
    __doomify?: {
      goTo: (index: number) => void;
      scrollToIndex: (index: number, behavior?: ScrollBehavior) => void;
      snapshot: () => ControllerSnapshot;
    };
  }
}

export {};
