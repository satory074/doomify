interface Props {
  /** 初回か、止まった再生の再開か */
  mode: 'start' | 'resume';
  disabled: boolean;
  hint: string | null;
  onTap: () => void;
  onChooseDevice: () => void;
}

/** 音を出すには最初のタップが必要(ブラウザの自動再生制限)。SDK の activateElement もここで呼ぶ */
export function TapToStartGate({ mode, disabled, hint, onTap, onChooseDevice }: Props) {
  return (
    <div className="gate">
      <button type="button" className="gate-button" onClick={onTap} disabled={disabled} aria-label={mode === 'start' ? '再生を始める' : '再生を再開する'}>
        <span className="gate-circle">
          <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M8 5v14l11-7z" />
          </svg>
        </span>
        <span className="gate-label">{disabled ? '準備しています…' : mode === 'start' ? 'タップして再生を始める' : 'タップして再生を再開する'}</span>
      </button>
      {hint !== null ? <p className="gate-hint">{hint}</p> : null}
      <button type="button" className="btn btn-quiet gate-alt" onClick={onChooseDevice}>
        Spotify アプリなど別の再生先を選ぶ
      </button>
    </div>
  );
}
