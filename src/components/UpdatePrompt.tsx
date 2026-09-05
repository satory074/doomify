import { useRegisterSW } from 'virtual:pwa-register/react';

/** 新しいバージョンの適用は曲の切れ目にユーザーが決める(autoUpdate は再生中にリロードしてしまう) */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <div className="update-banner" role="status">
      <span>新しいバージョンがあります</span>
      <button type="button" className="toast-action" onClick={() => void updateServiceWorker(true)}>
        今すぐ更新
      </button>
      <button type="button" className="toast-action" onClick={() => setNeedRefresh(false)}>
        あとで
      </button>
    </div>
  );
}
