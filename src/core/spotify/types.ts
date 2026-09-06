/** Spotify Web API のうち、このアプリが使うフィールドだけを持つ型。
 *  2026-02 の開発モード変更で削除された popularity / preview_url / available_markets などは持たない */

export interface Image {
  url: string;
  width: number | null;
  height: number | null;
}

export interface ArtistRef {
  id: string;
  name: string;
  uri: string;
}

export interface Artist extends ArtistRef {
  /** deprecated 表示。返らない前提で optional */
  genres?: string[];
  images?: Image[];
}

export type AlbumGroup = 'album' | 'single' | 'appears_on' | 'compilation';

export interface AlbumRef {
  id: string;
  name: string;
  uri: string;
  images: Image[];
  artists?: ArtistRef[];
  album_type?: string;
  album_group?: AlbumGroup;
  release_date?: string;
  release_date_precision?: 'year' | 'month' | 'day';
  total_tracks?: number;
}

export interface SimplifiedTrack {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  artists: ArtistRef[];
  explicit?: boolean;
  is_playable?: boolean;
  is_local?: boolean;
  type?: string;
  disc_number?: number;
  track_number?: number;
  restrictions?: { reason?: string };
}

export interface Track extends SimplifiedTrack {
  album: AlbumRef;
  external_urls?: { spotify?: string };
  /** ISRC など。2026-03 に削除が撤回され引き続き返る(MusicBrainz の録音引きに使う) */
  external_ids?: { isrc?: string; ean?: string; upc?: string };
}

export interface Paging<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
}

export interface Album extends AlbumRef {
  tracks: Paging<SimplifiedTrack>;
}

export interface SavedTrackItem {
  added_at: string;
  track: Track;
}

export interface PlayHistoryItem {
  played_at: string;
  track: Track;
}

export interface Playlist {
  id: string;
  name: string;
  uri: string;
  owner: { id: string; display_name?: string | null };
  collaborative: boolean;
  public?: boolean | null;
  images: Image[] | null;
  /** 2026-02 以降は tracks → items にリネーム。移行期のため両方 optional */
  items?: { total: number };
  tracks?: { total: number };
}

/** GET /playlists/{id}/items の要素。所有していないプレイリストでは item が無い */
export interface PlaylistItem {
  added_at?: string | null;
  item?: (Track & { type?: string }) | null;
  /** 旧形式との互換 */
  track?: (Track & { type?: string }) | null;
}

export interface Device {
  id: string | null;
  is_active: boolean;
  is_restricted: boolean;
  name: string;
  type: string;
  volume_percent: number | null;
}

export interface PlayerState {
  device: Device;
  is_playing: boolean;
  progress_ms: number | null;
  item: Track | null;
  timestamp: number;
  currently_playing_type?: string;
}

export interface CurrentUser {
  id: string;
  display_name: string | null;
  images?: Image[];
  uri?: string;
}

export interface SearchResponse {
  tracks?: Paging<Track>;
  albums?: Paging<AlbumRef>;
  artists?: Paging<Artist>;
}

export interface FollowedArtists {
  artists: {
    items: Artist[];
    next: string | null;
    cursors: { after: string | null };
    total: number;
  };
}

export type TopTimeRange = 'short_term' | 'medium_term' | 'long_term';

/** カード表示用にカバー画像を選ぶ(300px 前後を優先) */
export function pickImage(images: Image[] | null | undefined, preferredWidth = 640): Image | undefined {
  if (!images || images.length === 0) return undefined;
  const sorted = images
    .slice()
    .sort((a, b) => Math.abs((a.width ?? 0) - preferredWidth) - Math.abs((b.width ?? 0) - preferredWidth));
  return sorted[0];
}

export function trackIdFromUri(uri: string): string | null {
  const m = /^spotify:track:([A-Za-z0-9]+)$/.exec(uri);
  return m?.[1] ?? null;
}
