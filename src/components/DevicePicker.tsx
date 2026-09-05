import { useEffect, useState } from 'react';
import type { Device } from '../core/spotify/types';
import type { Services } from '../services';
import { Modal } from './Modal';

export type DeviceChoice = { kind: 'sdk' } | { kind: 'connect'; device: Device };

interface Props {
  open: boolean;
  services: Services;
  current: { kind: 'sdk' | 'connect'; deviceId: string | null };
  isIos: boolean;
  suggestConnect: boolean;
  onChoose: (choice: DeviceChoice) => void;
  onClose: () => void;
}

export function DevicePicker({ open, onClose, ...rest }: Props) {
  return (
    <Modal open={open} onClose={onClose} title="再生先を選ぶ">
      {open ? <DeviceList {...rest} /> : null}
    </Modal>
  );
}

type Result = { devices: Device[] } | { error: string };

function DeviceList({ services, current, isIos, suggestConnect, onChoose }: Omit<Props, 'open' | 'onClose'>) {
  const [generation, setGeneration] = useState(0);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    let cancelled = false;
    services.api.player
      .devices()
      .then((list) => {
        if (cancelled) return;
        setResult({ devices: list.filter((d) => d.id !== null && !d.is_restricted && d.name !== 'doomify') });
      })
      .catch((e: unknown) => {
        if (!cancelled) setResult({ error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [services, generation]);

  const loading = result === null;
  const devices = result !== null && 'devices' in result ? result.devices : [];
  const error = result !== null && 'error' in result ? result.error : null;
  const refresh = () => {
    setResult(null);
    setGeneration((g) => g + 1);
  };

  return (
    <>
      {suggestConnect ? (
        <div className="notice">このブラウザでの再生がうまく始まりません。Spotify アプリで再生すると、画面を閉じても音が続きます。</div>
      ) : null}
      <ul className="device-list">
        <li>
          <button type="button" className={`device${current.kind === 'sdk' ? ' is-current' : ''}`} onClick={() => onChoose({ kind: 'sdk' })}>
            <span className="device-name">このブラウザ</span>
            <span className="device-meta">音はこの端末で鳴ります。画面ロック中は止まります</span>
          </button>
        </li>
        {devices.map((d) => (
          <li key={d.id ?? d.name}>
            <button
              type="button"
              className={`device${current.kind === 'connect' && current.deviceId === d.id ? ' is-current' : ''}`}
              onClick={() => onChoose({ kind: 'connect', device: d })}
            >
              <span className="device-name">{d.name}</span>
              <span className="device-meta">
                {d.type}
                {d.is_active ? ' / 再生中' : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {loading ? <p className="muted">探しています…</p> : null}
      {!loading && error === null && devices.length === 0 ? (
        <p className="muted">
          ほかの再生先が見つかりません。
          {isIos ? 'iPhone の Spotify アプリを一度開いて何か再生し、ここへ戻ってから' : 'Spotify アプリを開いてから'}
          「もう一度探す」を押してください。
        </p>
      ) : null}
      {error !== null ? <p className="notice notice-error">{error}</p> : null}
      <button type="button" className="btn" onClick={refresh} disabled={loading}>
        もう一度探す
      </button>
    </>
  );
}
