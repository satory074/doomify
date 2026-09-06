import { describe, expect, it } from 'vitest';
import type { MbArtist, MbArtistHit, MbRecording, MusicBrainzClient } from '../external/musicbrainz';
import { MemoryStore } from '../spotify/cache';
import { createIdentity } from './identity';

function fakeMb(over: Partial<MusicBrainzClient> = {}): { mb: MusicBrainzClient; calls: string[] } {
  const calls: string[] = [];
  const hits: Record<string, MbArtistHit[]> = {
    Unique: [{ mbid: 'm-unique', name: 'Unique', score: 100 }],
    Common: [
      { mbid: 'm-c1', name: 'Common', score: 100 },
      { mbid: 'm-c2', name: 'Common', score: 100 },
    ],
    Weak: [{ mbid: 'm-w', name: 'Weakish', score: 60 }],
  };
  const artists: Record<string, MbArtist> = {
    'm-c1': { mbid: 'm-c1', name: 'Common', spotifyArtistId: 'sp-other', genres: [] },
    'm-c2': { mbid: 'm-c2', name: 'Common', spotifyArtistId: 'sp-common', genres: [{ name: 'j-pop', count: 3 }] },
  };
  const mb: MusicBrainzClient = {
    async searchArtist(name) {
      calls.push(`search:${name}`);
      return hits[name] ?? [];
    },
    async artist(mbid) {
      calls.push(`artist:${mbid}`);
      return artists[mbid] ?? null;
    },
    async recordingsByIsrc(isrc) {
      calls.push(`isrc:${isrc}`);
      const rec: MbRecording = { mbid: 'rec-1', title: 'Song', artists: [{ mbid: 'm-unique', name: 'Unique' }] };
      return isrc === 'JPX000000001' ? [rec] : [];
    },
    stats: () => ({ requests: calls.length, failures: 0, backoffs: 0 }),
    ...over,
  };
  return { mb, calls };
}

describe('identity', () => {
  it('高スコアが 1 件だけなら検索 1 回で採用し、キャッシュされる', async () => {
    const { mb, calls } = fakeMb();
    const id = createIdentity({ mb, store: new MemoryStore(), now: () => 1 });
    expect(await id.resolveArtist({ id: 'sp-u', name: 'Unique' })).toBe('m-unique');
    expect(await id.resolveArtist({ id: 'sp-u', name: 'Unique' })).toBe('m-unique');
    expect(calls).toEqual(['search:Unique']);
    expect(await id.spotifyIdOf('m-unique')).toBe('sp-u');
    expect(calls).toEqual(['search:Unique']);
  });

  it('拮抗するときは url-rels の Spotify ID で本人を選ぶ', async () => {
    const { mb, calls } = fakeMb();
    const id = createIdentity({ mb, store: new MemoryStore(), now: () => 1 });
    expect(await id.resolveArtist({ id: 'sp-common', name: 'Common' })).toBe('m-c2');
    expect(calls).toEqual(['search:Common', 'artist:m-c1', 'artist:m-c2']);
  });

  it('見つからなければ null を短期キャッシュ', async () => {
    const { mb, calls } = fakeMb();
    const id = createIdentity({ mb, store: new MemoryStore(), now: () => 1 });
    expect(await id.resolveArtist({ id: 'sp-w', name: 'Weak' })).toBeNull();
    expect(await id.resolveArtist({ id: 'sp-w', name: 'Weak' })).toBeNull();
    expect(calls).toEqual(['search:Weak']);
    expect(await id.resolveArtist({ id: 'sp-n', name: 'Nobody' })).toBeNull();
  });

  it('ISRC → 録音 MBID とアーティスト MBID。ISRC が無ければ null', async () => {
    const { mb, calls } = fakeMb();
    const id = createIdentity({ mb, store: new MemoryStore(), now: () => 1 });
    expect(await id.resolveRecording({ id: 't1', external_ids: { isrc: 'jpx00-000000-1' } })).toEqual({ recordingMbid: 'rec-1', artistMbids: ['m-unique'] });
    expect(await id.resolveRecording({ id: 't1', external_ids: { isrc: 'JPX000000001' } })).toEqual({ recordingMbid: 'rec-1', artistMbids: ['m-unique'] });
    expect(calls).toEqual(['isrc:JPX000000001']);
    expect(await id.resolveRecording({ id: 't2' })).toBeNull();
    expect(await id.resolveRecording({ id: 't3', external_ids: { isrc: 'NOPE' } })).toBeNull();
  });
});
