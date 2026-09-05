import { useEffect, useState } from 'react';
import type { Playlist, Track } from '../core/spotify/types';
import type { Services } from '../services';
import { Modal } from './Modal';

interface Props {
  open: boolean;
  services: Services;
  track: Track | null;
  onDone: (message: string) => void;
  onClose: () => void;
}

const NEW_PLAYLIST_NAME = 'doomify picks';

export function PlaylistPicker({ open, onClose, ...rest }: Props) {
  return (
    <Modal open={open} onClose={onClose} title="プレイリストに追加">
      {open ? <PlaylistList {...rest} /> : null}
    </Modal>
  );
}

type Loaded = { playlists: Playlist[] } | { error: string };

function PlaylistList({ services, track, onDone }: Omit<Props, 'open' | 'onClose'>) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([services.api.me(), services.api.myPlaylists(50, 0)])
      .then(([me, page]) => {
        if (!cancelled) setLoaded({ playlists: page.items.filter((p) => p.owner.id === me.id || p.collaborative) });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoaded({ error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [services]);

  const playlists = loaded !== null && 'playlists' in loaded ? loaded.playlists : [];
  const loadError = loaded !== null && 'error' in loaded ? loaded.error : null;

  const add = async (playlist: Playlist | null) => {
    if (track === null) return;
    setBusy(true);
    setActionError(null);
    try {
      const target =
        playlist ?? (await services.api.createPlaylist({ name: NEW_PLAYLIST_NAME, description: 'doomify で見つけた曲', isPublic: false }));
      await services.api.addToPlaylist(target.id, [track.uri]);
      onDone(`「${target.name}」に追加しました`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {track !== null ? <p className="muted">{track.name}</p> : null}
      <ul className="device-list">
        <li>
          <button type="button" className="device" onClick={() => void add(null)} disabled={busy}>
            <span className="device-name">新しく「{NEW_PLAYLIST_NAME}」を作って追加</span>
            <span className="device-meta">非公開のプレイリストになります</span>
          </button>
        </li>
        {playlists.map((p) => (
          <li key={p.id}>
            <button type="button" className="device" onClick={() => void add(p)} disabled={busy}>
              <span className="device-name">{p.name}</span>
              <span className="device-meta">{p.items?.total ?? p.tracks?.total ?? 0} 曲</span>
            </button>
          </li>
        ))}
      </ul>
      {loaded === null ? <p className="muted">読み込んでいます…</p> : null}
      {loadError !== null ? <p className="notice notice-error">{loadError}</p> : null}
      {actionError !== null ? <p className="notice notice-error">{actionError}</p> : null}
    </>
  );
}
