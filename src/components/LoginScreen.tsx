import { CLIENT_ID } from '../core/config';
import type { AuthUiState } from '../hooks/useAuth';
import { SpotifyAttribution, SpotifyIcon } from './SpotifyMark';

interface Props {
  state: Extract<AuthUiState, { kind: 'signed-out' }>;
  onLogin: () => void;
}

export function LoginScreen({ state, onLogin }: Props) {
  const missingClientId = CLIENT_ID === '';
  return (
    <main className="login">
      <div className="login-stack" aria-hidden="true">
        <span className="sleeve sleeve-back" />
        <span className="sleeve sleeve-mid" />
        <span className="sleeve sleeve-front" />
      </div>
      <h1 className="login-title">
        スワイプで、
        <br />
        次の曲へ。
      </h1>
      <p className="login-lead">
        Spotify の保存曲やよく聴く曲を種に、参加作品・ジャンル・新譜へと広がる曲を、上下のスワイプだけで聴き流せます。
      </p>
      {missingClientId ? (
        <div className="notice notice-error">
          <strong>Client ID が設定されていません。</strong>
          <span>
            Spotify Developer Dashboard でアプリを作り、<code>.env</code> の <code>VITE_SPOTIFY_CLIENT_ID</code> に Client ID を入れてください。
          </span>
        </div>
      ) : null}
      {state.message !== null ? <div className="notice notice-error">{state.message}</div> : null}
      <button type="button" className="btn btn-primary btn-login" onClick={onLogin} disabled={missingClientId}>
        <SpotifyIcon size={22} color="#0b0b12" />
        Spotify でログイン
      </button>
      <ul className="login-notes">
        <li>曲をフルで再生するため Spotify Premium が必要です。</li>
        <li>開発モードのアプリなので、使えるのは登録した最大 5 人です。</li>
        <li>ログインは 6 か月ごとに更新が必要です。</li>
      </ul>
      <SpotifyAttribution />
    </main>
  );
}
