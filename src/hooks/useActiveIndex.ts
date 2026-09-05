import { useCallback, useEffect, useRef, useState } from 'react';
import { indexFromScroll, offsetForIndex } from '../core/snap';

export interface ActiveIndex {
  active: number;
  /** スワイプ中に向かっている先(画像の先読み用) */
  pending: number;
  scrollToIndex: (index: number, behavior?: ScrollBehavior) => void;
}

/** scroll イベントが止まってから確定までの待ち。scrollend が発火するブラウザではそちらが先に確定する */
const SCROLL_IDLE_MS = 150;
/** プログラムスクロール中に scroll イベントが来なかった場合の保険 */
const PROGRAMMATIC_TIMEOUT_MS = 1500;

/** scroll-snap コンテナのアクティブカードを求める。
 *  - 確定は scrollend(対応ブラウザ)と scroll のアイドル検出の両方で行う(Chrome はプログラムスクロールで scrollend を出さない)
 *  - プログラムからのスムーズスクロール中はスナップを一時的に外す(DOM 変化時のスナップ再整列で中断されるため) */
export function useActiveIndex(containerRef: React.RefObject<HTMLElement | null>, count: number): ActiveIndex {
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(0);
  const activeRef = useRef(0);
  const countRef = useRef(count);
  useEffect(() => {
    countRef.current = count;
  }, [count]);
  const programmaticRef = useRef<{ restore: () => void; timer: ReturnType<typeof setTimeout> } | null>(null);

  const finishProgrammatic = useCallback(() => {
    const p = programmaticRef.current;
    if (p === null) return;
    clearTimeout(p.timer);
    p.restore();
    programmaticRef.current = null;
  }, []);

  const commit = useCallback(() => {
    const el = containerRef.current;
    if (el === null) return;
    finishProgrammatic();
    const next = indexFromScroll(el.scrollTop, el.clientHeight, countRef.current);
    if (next !== activeRef.current) {
      activeRef.current = next;
      setActive(next);
    }
    setPending(next);
  }, [containerRef, finishProgrammatic]);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      setPending(indexFromScroll(el.scrollTop, el.clientHeight, countRef.current));
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(commit, SCROLL_IDLE_MS);
    };
    const onScrollEnd = () => {
      if (idle !== null) {
        clearTimeout(idle);
        idle = null;
      }
      commit();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('scrollend', onScrollEnd);

    // 回転・ツールバー変化で高さが変わったら、アクティブカードの位置へ即時に揃え直す
    const ro = new ResizeObserver(() => {
      el.scrollTo({ top: offsetForIndex(activeRef.current, el.clientHeight), behavior: 'instant' });
    });
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('scrollend', onScrollEnd);
      if (idle !== null) clearTimeout(idle);
      ro.disconnect();
      finishProgrammatic();
    };
  }, [containerRef, commit, finishProgrammatic]);

  const scrollToIndex = useCallback(
    (index: number, behavior: ScrollBehavior = 'smooth') => {
      const el = containerRef.current;
      if (el === null) return;
      const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      const top = offsetForIndex(index, el.clientHeight);
      if (Math.abs(el.scrollTop - top) < 1) {
        commit();
        return;
      }
      finishProgrammatic();
      const effective: ScrollBehavior = reduced ? 'instant' : behavior;
      el.style.scrollSnapType = 'none';
      programmaticRef.current = {
        restore: () => {
          el.style.scrollSnapType = '';
        },
        timer: setTimeout(commit, effective === 'smooth' ? PROGRAMMATIC_TIMEOUT_MS : 200),
      };
      el.scrollTo({ top, behavior: effective });
    },
    [containerRef, commit, finishProgrammatic],
  );

  return { active, pending, scrollToIndex };
}
