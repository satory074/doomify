import { describe, expect, it } from 'vitest';
import { fakeFetch } from './http';
import { createListenBrainzClient, SIMILAR_ARTISTS_ALGORITHM, TAGS_BATCH } from './listenbrainz';

function client(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchFn = fakeFetch((url, init) => {
    calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return handler(url, init);
  });
  return { lb: createListenBrainzClient({ fetchFn, minSpacingMs: 0, backoffMs: 0 }), calls };
}

describe('listenbrainz', () => {
  it('similarArtists は POST で複数の種をまとめ、reference ごとに score 降順、null は捨てる', async () => {
    const { lb, calls } = client(() => ({
      status: 200,
      body: [
        { artist_mbid: 'x', name: 'X', score: 10, reference_mbid: 'a' },
        { artist_mbid: 'y', name: 'Y', score: 50, reference_mbid: 'a' },
        { artist_mbid: 'z', name: 'Z', score: 5, reference_mbid: 'b' },
        { artist_mbid: 'n', name: 'N', score: 99, reference_mbid: null },
        { artist_mbid: null, name: 'M', score: 1, reference_mbid: 'a' },
      ],
    }));
    const m = await lb.similarArtists(['a', 'b', 'a', '']);
    expect(m.get('a')?.map((s) => s.mbid)).toEqual(['y', 'x']);
    expect(m.get('b')).toEqual([{ mbid: 'z', name: 'Z', score: 5 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://labs.api.listenbrainz.org/similar-artists/json');
    expect(calls[0]?.body).toEqual([{ artist_mbids: ['a', 'b'], algorithm: SIMILAR_ARTISTS_ALGORITHM }]);
    expect((await lb.similarArtists([])).size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('similarRecordings は録音名・アーティスト名・MBID を返す', async () => {
    const { lb } = client(() => ({
      status: 200,
      body: [{ recording_mbid: 'r2', recording_name: "Wouldn't It Be Nice", artist_credit_name: 'The Beach Boys', artist_credit_mbids: null, release_name: 'Pet Sounds', score: 116, reference_mbid: 'r1' }],
    }));
    const m = await lb.similarRecordings(['r1']);
    expect(m.get('r1')).toEqual([{ mbid: 'r2', name: "Wouldn't It Be Nice", artistName: 'The Beach Boys', artistMbids: [], releaseName: 'Pet Sounds', score: 116 }]);
  });

  it('artistTags は 25 件ずつ GET し、タグを小文字・count 降順で返す。失敗は空', async () => {
    const { lb, calls } = client((url) =>
      url.includes('metadata/artist')
        ? { status: 200, body: [{ artist_mbid: 'a', name: 'A', tag: { artist: [{ tag: 'Indie Rock', count: 4 }, { tag: 'art rock', count: 29 }, { tag: 'bad' }] } }] }
        : { status: 429, body: {} },
    );
    const ids = Array.from({ length: TAGS_BATCH + 1 }, (_, i) => `m${i}`);
    const m = await lb.artistTags(ids);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('/1/metadata/artist/?artist_mbids=m0%2Cm1');
    expect(calls[0]?.url).toContain('inc=tag');
    expect(m.get('a')).toEqual([{ tag: 'art rock', count: 29 }, { tag: 'indie rock', count: 4 }]);
    const { lb: failing } = client(() => ({ status: 429, body: {} }));
    expect((await failing.similarArtists(['a'])).size).toBe(0);
    expect(failing.stats().backoffs).toBe(1);
  });
});
