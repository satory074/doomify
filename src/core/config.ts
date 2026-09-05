/** アプリ全体の定数。React 非依存 */

/** PKCE のため Client ID は公開値(シークレットは存在しない) */
export const CLIENT_ID: string = (import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined) ?? '';

/** 要求スコープ。Web Playback SDK は streaming + user-read-email + user-read-private を要求する */
export const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-library-read',
  'user-library-modify',
  'user-top-read',
  'user-follow-read',
  'user-read-recently-played',
  'playlist-read-private',
  'playlist-modify-private',
  'playlist-modify-public',
] as const;

export const SCOPE_STRING: string = SCOPES.join(' ');

/** Redirect URI はアプリのルート(例: https://satory074.github.io/doomify/ , http://127.0.0.1:5173/doomify/)。
 *  Spotify 側の登録値と完全一致させる必要があるため、末尾スラッシュを必ず付ける */
export function redirectUri(origin: string, base: string): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${origin}${normalizedBase}`;
}

export const SPOTIFY_TRACK_URL = (id: string): string => `https://open.spotify.com/track/${id}`;
export const SPOTIFY_TRACK_DEEPLINK = (id: string): string => `spotify:track:${id}`;
