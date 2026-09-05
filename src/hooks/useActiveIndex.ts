import { useCallback, useEffect, useRef, useState } from 'react';
import { indexFromScroll, offsetForIndex } from '../core/snap';

export interface ActiveIndex {
  active: number;
  /** スワイプ中に向かっている先(画像の先読み用) */
  pending: number;
  scrollToIndex: (index: number, behavior?: ScrollBehavior) => void;
}

const SCROLL_IDLE_MS = 120;

/** scroll-snap コンテナのアクティブカードを求める。
 *  主経路は scrollend(Safari 26.2 以降で全ブラウザ対応)、無ければ scroll のアイドル検出 */
export function useActiveIndex(containerRef: React.RefObject<HTMLElement | null>, count: number): ActiveIndex {
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(0);
  const activeRef = useRef(0);
  const countRef = useRef(count);
  useEffect(() => {
    countRef.current = count;
  }, [count]);

  const commit = useCallback(() => {
    const el = containerRef.current;
    if (el === null) return;
    const next = indexFromScroll(el.scrollTop, el.clientHeight, countRef.current);
    if (next !== activeRef.current) {
      activeRef.current = next;
      setActive(next);
    }
    setPending(next);
  }, [containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const supportsScrollEnd = 'onscrollend' in window;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const onScroll = () => {
      setPending(indexFromScroll(el.scrollTop, el.clientHeight, countRef.current));
      if (supportsScrollEnd) return;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(commit, SCROLL_IDLE_MS);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    if (supportsScrollEnd) el.addEventListener('scrollend', commit);

    // 回転・ツールバー変化で高さが変わったら、アクティブカードの位置へ即時に揃え直す
    const ro = new ResizeObserver(() => {
      el.scrollTo({ top: offsetForIndex(activeRef.current, el.clientHeight), behavior: 'instant' });
    });
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', onScroll);
      if (supportsScrollEnd) el.removeEventListener('scrollend', commit);
      if (idleTimer !== null) clearTimeout(idleTimer);
      ro.disconnect();
    };
  }, [containerRef, commit]);

  const scrollToIndex = useCallback(
    (index: number, behavior: ScrollBehavior = 'smooth') => {
      const el = containerRef.current;
      if (el === null) return;
      const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollTo({ top: offsetForIndex(index, el.clientHeight), behavior: reduced ? 'instant' : behavior });
      // scrollend が無いブラウザでも確実に確定させる
      if (!('onscrollend' in window)) setTimeout(commit, behavior === 'smooth' ? 600 : 50);
    },
    [containerRef, commit],
  );

  return { active, pending, scrollToIndex };
}
