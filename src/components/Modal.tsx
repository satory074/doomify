import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/** <dialog> ベースの共通シート。Esc・フォーカストラップはネイティブに任せる。閉じる手段はテキストボタン */
export function Modal({ open, onClose, title, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={title}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet-inner">
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            閉じる
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </dialog>
  );
}
