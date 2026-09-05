import { useEffect } from 'react';

interface KeyHandlers {
  next: () => void;
  previous: () => void;
  togglePause: () => void;
  like: () => void;
}

/** デスクトップ用: ↑↓/PageUp/PageDown で移動、Space で一時停止、L で保存 */
export function useKeyboardNav(handlers: KeyHandlers, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.closest('dialog') !== null)) return;
      switch (e.key) {
        case 'ArrowDown':
        case 'PageDown':
        case 'j':
          e.preventDefault();
          handlers.next();
          break;
        case 'ArrowUp':
        case 'PageUp':
        case 'k':
          e.preventDefault();
          handlers.previous();
          break;
        case ' ':
          e.preventDefault();
          handlers.togglePause();
          break;
        case 'l':
          handlers.like();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers, enabled]);
}
