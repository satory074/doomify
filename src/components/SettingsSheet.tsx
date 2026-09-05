import { DEFAULT_GENRES } from '../core/feed/genres';
import type { AdvanceMode, Settings } from '../hooks/useSettings';
import { Modal } from './Modal';
import { SpotifyAttribution } from './SpotifyMark';

interface Props {
  open: boolean;
  settings: Settings;
  authNote: string | null;
  onUpdate: (patch: Partial<Settings>) => void;
  onResetHistory: () => void;
  onLogout: () => void;
  onClose: () => void;
}

const ADVANCE_OPTIONS: { value: AdvanceMode; label: string }[] = [
  { value: 'full', label: '曲の終わりまで' },
  { value: 60, label: '60 秒で次へ' },
  { value: 30, label: '30 秒で次へ' },
];

export function SettingsSheet({ open, settings, authNote, onUpdate, onResetHistory, onLogout, onClose }: Props) {
  const toggleGenre = (g: string) => {
    const has = settings.genres.includes(g);
    onUpdate({ genres: has ? settings.genres.filter((x) => x !== g) : [...settings.genres, g] });
  };
  return (
    <Modal open={open} onClose={onClose} title="設定">
      {authNote !== null ? <div className="notice">{authNote}</div> : null}

      <fieldset className="field">
        <legend>曲のどこから流すか</legend>
        <div className="segmented" role="radiogroup">
          <button type="button" role="radio" aria-checked={settings.startPosition === 'hook'} onClick={() => onUpdate({ startPosition: 'hook' })}>
            サビ寄り(約 30% 地点)
          </button>
          <button type="button" role="radio" aria-checked={settings.startPosition === 'beginning'} onClick={() => onUpdate({ startPosition: 'beginning' })}>
            冒頭から
          </button>
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>自動で次の曲へ</legend>
        <div className="segmented" role="radiogroup">
          {ADVANCE_OPTIONS.map((o) => (
            <button key={String(o.value)} type="button" role="radio" aria-checked={settings.advance === o.value} onClick={() => onUpdate({ advance: o.value })}>
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>
          発見度 <output>{Math.round(settings.discovery * 100)}%</output>
        </legend>
        <div className="slider-row">
          <span>なじみ</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.discovery}
            onChange={(e) => onUpdate({ discovery: Number(e.target.value) })}
            aria-label="発見度"
          />
          <span>発見</span>
        </div>
        <p className="muted">低いと保存曲・よく聴く曲が中心。高いと参加作品・ジャンル検索・新譜が増えます。</p>
      </fieldset>

      <fieldset className="field">
        <legend>好きなジャンル(発見の種になります)</legend>
        <div className="chips">
          {DEFAULT_GENRES.map((g) => (
            <button key={g} type="button" className="chip chip-toggle" aria-pressed={settings.genres.includes(g)} onClick={() => toggleGenre(g)}>
              {g}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="field field-actions">
        <button type="button" className="btn" onClick={onResetHistory}>
          見た曲の履歴を消す
        </button>
        <button type="button" className="btn btn-quiet" onClick={onLogout}>
          ログアウト
        </button>
      </div>

      <div className="about">
        <SpotifyAttribution />
        <p className="muted">
          doomify は Spotify の非公式アプリです。Spotify Premium が必要で、認可は 6 か月ごとに更新が必要です。
        </p>
      </div>
    </Modal>
  );
}
