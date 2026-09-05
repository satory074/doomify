import { FeedScreen } from './components/FeedScreen';
import { LoginScreen } from './components/LoginScreen';
import { useAuth } from './hooks/useAuth';
import { useSettings } from './hooks/useSettings';
import { isDemo } from './demo';
import { getServices } from './services';

export default function App() {
  const services = getServices();
  const { state, login, logout } = useAuth(services.auth);
  const [settings, updateSettings] = useSettings();

  if (isDemo()) {
    return <FeedScreen services={services} settings={settings} updateSettings={updateSettings} authStatus="ok" onLogout={() => {}} />;
  }
  if (state.kind === 'booting') {
    return (
      <main className="login" aria-busy="true">
        <span className="spinner" aria-label="読み込み中" />
      </main>
    );
  }
  if (state.kind === 'signed-out') {
    return <LoginScreen state={state} onLogin={() => void login()} />;
  }
  return (
    <FeedScreen
      services={services}
      settings={settings}
      updateSettings={updateSettings}
      authStatus={state.status}
      onLogout={logout}
    />
  );
}
