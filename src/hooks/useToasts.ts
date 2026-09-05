import { useCallback, useRef, useState } from 'react';

export interface ToastItem {
  id: number;
  text: string;
  action?: { label: string; onClick: () => void };
  /** ms。0 なら手動で閉じるまで残す */
  duration: number;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const show = useCallback((text: string, opts: { action?: ToastItem['action']; duration?: number } = {}) => {
    const id = ++seq.current;
    setToasts((ts) => [...ts.filter((t) => t.text !== text), { id, text, action: opts.action, duration: opts.duration ?? 3500 }]);
    return id;
  }, []);
  return { toasts, show, dismiss };
}
