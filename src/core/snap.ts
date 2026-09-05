/** スクロールスナップの幾何。カードは全て同じ高さ(コンテナの clientHeight)という前提 */

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index));
}

/** scrollTop から「いちばん近いカード」の index を求める */
export function indexFromScroll(scrollTop: number, itemHeight: number, count: number): number {
  if (itemHeight <= 0 || !Number.isFinite(scrollTop)) return 0;
  return clampIndex(Math.round(scrollTop / itemHeight), count);
}

export function offsetForIndex(index: number, itemHeight: number): number {
  return Math.max(0, index) * itemHeight;
}

/** スナップ点にほぼ止まっているか(高さの 2% 以内) */
export function isSettled(scrollTop: number, itemHeight: number, toleranceRatio = 0.02): boolean {
  if (itemHeight <= 0) return true;
  const nearest = Math.round(scrollTop / itemHeight) * itemHeight;
  return Math.abs(scrollTop - nearest) <= itemHeight * toleranceRatio;
}
