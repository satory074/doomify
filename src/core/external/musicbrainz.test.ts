import { describe, expect, it } from 'vitest';
import { fakeFetch } from './http';
import { artistQuery, createMusicBrainzClient, spotifyArtistIdFromUrl } from './musicbrainz';

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';

function client(handler: (url: string) => { status: number; body: unknown }) {
  const urls: string[] = [];
  const fetchFn = fakeFetch((url) => {
    urls.push(url);
    return handler(url);
  });
  return { mb: createMusicBrainzClient({ fetchFn, minSpacingMs: 0, backoffMs: 0 }), urls };
}

describe('musicbrainz', () => {
  it('検索は artist:"…" と fmt=json を付け、id/name/score を返す', async () => {
    const { mb, urls } = client(() => ({
      status: 200,
      body: { artists: [{ id: RADIOHEAD, name: 'Radiohead', score: 100, type: 'Group', country: 'GB' }, { name: 'no id' }] },
    }));
    const hits = await mb.searchArtist('Radio"head');
    expect(hits).toEqual([{ mbid: RADIOHEAD, name: 'Radiohead', score: 100, type: 'Group', country: 'GB', disambiguation: undefined }]);
    expect(urls[0]).toContain('/artist/?query=artist%3A%22Radio+head%22');
    expect(urls[0]).toContain('fmt=json');
    expect(artistQuery('  a  b ')).toBe('artist:"a b"');
    expect(await mb.searchArtist('   ')).toEqual([]);
  });

  it('artist は url-rels から Spotify ID を取り、ジャンルを count 順に返す', async () => {
    const { mb, urls } = client(() => ({
      status: 200,
      body: {
        id: RADIOHEAD,
        name: 'Radiohead',
        relations: [{ type: 'streaming', url: { resource: 'https://www.qobuz.com/x' } }, { type: 'free streaming', url: { resource: 'https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb' } }],
        genres: [{ name: 'art rock', count: 29 }, { name: 'alternative rock', count: 42 }],
      },
    }));
    const a = await mb.artist(RADIOHEAD);
    expect(a?.spotifyArtistId).toBe('4Z8W4fKeB5YxbusRsdQVPb');
    expect(a?.genres.map((g) => g.name)).toEqual(['alternative rock', 'art rock']);
    expect(urls[0]).toContain(`/artist/${RADIOHEAD}?inc=url-rels%2Bgenres&fmt=json`);
    expect(spotifyArtistIdFromUrl('https://example.com')).toBeNull();
  });

  it('ISRC → 録音とアーティスト MBID。失敗は空・null で、503 はバックオフを数える', async () => {
    const { mb } = client((url) =>
      url.includes('/isrc/')
        ? { status: 200, body: { recordings: [{ id: 'r1', title: 'Yellow Submarine', 'artist-credit': [{ artist: { id: 'b1', name: 'The Beatles' } }, { name: 'junk' }] }] } }
        : { status: 503, body: {} },
    );
    expect(await mb.recordingsByIsrc('gbaye-0601498')).toEqual([{ mbid: 'r1', title: 'Yellow Submarine', artists: [{ mbid: 'b1', name: 'The Beatles' }] }]);
    expect(await mb.artist('x')).toBeNull();
    expect(await mb.searchArtist('y')).toEqual([]);
    expect(mb.stats()).toEqual({ requests: 3, failures: 2, backoffs: 2 });
  });
});
