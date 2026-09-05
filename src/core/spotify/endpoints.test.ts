import { describe, expect, it } from 'vitest';
import type { ApiClient, ApiRequest } from './apiClient';
import { createSpotifyApi, LIMITS } from './endpoints';

function fakeClient(respond: (req: ApiRequest) => unknown = () => ({})): { client: ApiClient; requests: ApiRequest[] } {
  const requests: ApiRequest[] = [];
  const client: ApiClient = {
    request: async <T>(req: ApiRequest) => {
      requests.push(req);
      return respond(req) as T;
    },
    onRateLimit: () => () => {},
    rateLimitedUntil: () => null,
    stats: () => ({ requests: 0, cacheHits: 0, rateLimits: 0 }),
  };
  return { client, requests };
}

describe('createSpotifyApi', () => {
  it('search は limit を 10 に丸め、offset を 1000 で止める', async () => {
    const { client, requests } = fakeClient();
    const api = createSpotifyApi(client);
    await api.search('genre:"shoegaze"', ['track'], { limit: 50, offset: 5000 });
    expect(requests[0]?.path).toBe('/search');
    expect(requests[0]?.query).toMatchObject({ q: 'genre:"shoegaze"', type: 'track', limit: LIMITS.search, offset: LIMITS.searchMaxOffset });
    expect(requests[0]?.cacheTtlMs).toBeGreaterThan(0);
  });

  it('artistAlbums は include_groups を結合し limit ≤ 10', async () => {
    const { client, requests } = fakeClient();
    await createSpotifyApi(client).artistAlbums('a1', ['appears_on', 'compilation'], 20, 3);
    expect(requests[0]?.path).toBe('/artists/a1/albums');
    expect(requests[0]?.query).toMatchObject({ include_groups: 'appears_on,compilation', limit: 10, offset: 3 });
  });

  it('ライブラリ操作は URI をカンマ区切りクエリで送り、40 件ずつに分割する', async () => {
    const { client, requests } = fakeClient((req) => (req.path === '/me/library/contains' ? [true, false] : undefined));
    const api = createSpotifyApi(client);
    const uris = Array.from({ length: 45 }, (_, i) => `spotify:track:${i}`);
    await api.saveToLibrary(uris);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.path).toBe('/me/library');
    expect(String(requests[0]?.query?.uris).split(',')).toHaveLength(40);
    expect(requests[0]?.priority).toBe('action');
    const res = await api.libraryContains(['spotify:track:a', 'spotify:track:b']);
    expect(res).toEqual([true, false]);
  });

  it('player.play は device_id クエリと uris/position_ms ボディを送る。state の 204 は null', async () => {
    const { client, requests } = fakeClient(() => undefined);
    const api = createSpotifyApi(client);
    await api.player.play('dev1', { uris: ['spotify:track:x'], positionMs: 12345.6 });
    expect(requests[0]).toMatchObject({
      method: 'PUT',
      path: '/me/player/play',
      query: { device_id: 'dev1' },
      body: { uris: ['spotify:track:x'], position_ms: 12345 },
      priority: 'playback',
    });
    expect(await api.player.state()).toBeNull();
  });

  it('プレイリスト追加は /playlists/{id}/items に uris ボディ', async () => {
    const { client, requests } = fakeClient(() => ({ snapshot_id: 's' }));
    await createSpotifyApi(client).addToPlaylist('pl', ['spotify:track:x']);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/playlists/pl/items', body: { uris: ['spotify:track:x'] } });
  });
});
