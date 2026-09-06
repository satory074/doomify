import { useCallback, useEffect, useRef, useState } from 'react';
import { indexFromScroll, offsetForIndex, parseCardIndex } from '../core/snap';

/** 意図(向かっている先)の出どころ。snap: scrollsnapchanging、geometry: 最寄りカードの切替、programmatic: scrollToIndex、commit: 確定時の補正 */
export type IntentSource = 'snap' | 'geometry' | 'programmatic' | 'commit';

export interface ActiveIndexOptions {
  /** 「向かっている先」が分かった瞬間に同期的に呼ばれる(React state を経由しない)。再生要求の先行に使う */
  onIntent?: (index: number, source: IntentSource) => void;
}

export interface ActiveIndex {
  active: number;
  scrollToIndex: (index: number, behavior?: ScrollBehavior) => void;
}

/** scroll イベントが止まってから確定までの待ち。scrollend が発火するブラウザではそちらが先に確定する */
const SCROLL_IDLE_MS = 150;
/** プログラムスクロール中に scroll イベントが来なかった場合の保険 */
const PROGRAMMATIC_TIMEOUT_MS = 1500;

/** scroll-snap コンテナのアクティブカードを求める。
 *  - 意図(向かう先)はスナップ完了を待たずに通知する: scrollsnapchanging(Chrome 129+。指が触れている間に最終目標が分かる)、
 *    無いブラウザでは scroll 中に最寄りカードが変わった瞬間(50% 越え)、プログラム移動は scrollTo の前
 *  - 確定は scrollend(対応ブラウザ)と scroll のアイドル検出の両方で行う(Chrome はプログラムスクロールで scrollend を出さない)。
 *    確定が意図と食い違えば(途中で戻った等)確定側の index を意図として通知し直す
 *  - プログラムからのスムーズスクロール中はスナップを一時的に外す(DOM 変化時のスナップ再整列で中断されるため) */
export function useActiveIndex(
  containerRef: React.RefObject<HTMLElement | null>,
  count: number,
  options: ActiveIndexOptions = {},
): ActiveIndex {
  const [active, setActive] = useState(0);
  const activeRef = useRef(0);
  const intentRef = useRef(0);
  const countRef = useRef(count);
  useEffect(() => {
    countRef.current = count;
  }, [count]);
  const onIntentRef = useRef(options.onIntent);
  useEffect(() => {
    onIntentRef.current = options.onIntent;
  }, [options.onIntent]);
  const programmaticRef = useRef<{ restore: () => void; timer: ReturnType<typeof setTimeout> } | null>(null);

  const emitIntent = useCallback((index: number, source: IntentSource) => {
    if (index === intentRef.current) return;
    intentRef.current = index;
    onIntentRef.current?.(index, source);
  }, []);

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
    emitIntent(next, 'commit');
    if (next !== activeRef.current) {
      activeRef.current = next;
      setActive(next);
    }
  }, [containerRef, finishProgrammatic, emitIntent]);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    let idle: ReturnType<typeof setTimeout> | null = null;
    // 対応ブラウザではブラウザが決めたスナップ先を使い、幾何による推定はしない(二重の意図を出さない)
    const snapEvents = 'onscrollsnapchanging' in el;
    const onScroll = () => {
      if (!snapEvents && programmaticRef.current === null) {
        emitIntent(indexFromScroll(el.scrollTop, el.clientHeight, countRef.current), 'geometry');
      }
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(commit, SCROLL_IDLE_MS);
    };
    const onSnapChanging = (e: SnapEvent) => {
      if (programmaticRef.current !== null) return;
      const target = e.snapTargetBlock;
      const index = target instanceof HTMLElement ? parseCardIndex(target.dataset.index, countRef.current) : null;
      if (index !== null) emitIntent(index, 'snap');
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
    if (snapEvents) el.addEventListener('scrollsnapchanging', onSnapChanging);

    // 回転・ツールバー変化で高さが変わったら、アクティブカードの位置へ即時に揃え直す
    const ro = new ResizeObserver(() => {
      el.scrollTo({ top: offsetForIndex(activeRef.current, el.clientHeight), behavior: 'instant' });
    });
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('scrollend', onScrollEnd);
      if (snapEvents) el.removeEventListener('scrollsnapchanging', onSnapChanging);
      if (idle !== null) clearTimeout(idle);
      ro.disconnect();
      finishProgrammatic();
    };
  }, [containerRef, commit, finishProgrammatic, emitIntent]);

  const scrollToIndex = useCallback(
    (index: number, behavior: ScrollBehavior = 'smooth') => {
      const el = containerRef.current;
      if (el === null) return;
      const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      // 非表示のタブでは rAF が止まりスムーズスクロールが進まない(裏で再生中の自動送り)ので即時に移動する
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      const target = Math.max(0, index);
      const top = offsetForIndex(target, el.clientHeight);
      if (Math.abs(el.scrollTop - top) < 1) {
        commit();
        return;
      }
      finishProgrammatic();
      // 行き先は分かっているので、スクロールを始める前に意図として通知する(スナップは外すので snap イベントは出ない)
      emitIntent(target, 'programmatic');
      const effective: ScrollBehavior = reduced || hidden ? 'instant' : behavior;
      el.style.scrollSnapType = 'none';
      programmaticRef.current = {
        restore: () => {
          el.style.scrollSnapType = '';
        },
        timer: setTimeout(() => {
          // 時間内に着いていない(途中で非表示になった等)なら即時に寄せてから確定する。元のカードに戻して曲を鳴らし直さない
          if (Math.abs(el.scrollTop - top) >= 1) el.scrollTo({ top, behavior: 'instant' });
          commit();
        }, effective === 'smooth' ? PROGRAMMATIC_TIMEOUT_MS : 200),
      };
      el.scrollTo({ top, behavior: effective });
    },
    [containerRef, commit, finishProgrammatic, emitIntent],
  );

  return { active, scrollToIndex };
}
