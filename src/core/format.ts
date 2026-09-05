import type { AlbumRef, Track } from './spotify/types';

export function formatArtists(track: Pick<Track, 'artists'>): string {
  return track.artists.map((a) => a.name).join(', ');
}

export function yearOf(album: Pick<AlbumRef, 'release_date'> | undefined): string | null {
  const d = album?.release_date;
  if (!d) return null;
  const m = /^(\d{4})/.exec(d);
  return m?.[1] ?? null;
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function primaryArtistId(track: Pick<Track, 'artists'>): string | null {
  return track.artists[0]?.id ?? null;
}
