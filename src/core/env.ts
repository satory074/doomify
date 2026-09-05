/** 実行環境の判定。navigator 等は触らず、収集済みの値を受け取る純関数(mahjong-ime から移植) */

export interface EnvInput {
  userAgent: string;
  /** navigator.platform(iPadOS は UA が Macintosh になるため判定に必要) */
  platform: string;
  maxTouchPoints: number;
  /** matchMedia('(display-mode: standalone)').matches */
  displayModeStandalone: boolean;
  /** iOS Safari 独自の navigator.standalone === true */
  iosStandalone: boolean;
}

export interface AppEnvironment {
  isStandalone: boolean;
  isIos: boolean;
  isAndroid: boolean;
  isMobile: boolean;
}

export function detectEnvironment(input: EnvInput): AppEnvironment {
  const isStandalone = input.displayModeStandalone || input.iosStandalone;
  const isIos =
    /iPhone|iPad|iPod/.test(input.userAgent) ||
    // iPadOS は UA が Macintosh を名乗るため、タッチ対応 Mac で判定する
    (input.platform === 'MacIntel' && input.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(input.userAgent);
  return { isStandalone, isIos, isAndroid, isMobile: isIos || isAndroid };
}

export function readEnvironment(): AppEnvironment {
  if (typeof navigator === 'undefined') {
    return { isStandalone: false, isIos: false, isAndroid: false, isMobile: false };
  }
  return detectEnvironment({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    displayModeStandalone: typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches,
    iosStandalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
  });
}
