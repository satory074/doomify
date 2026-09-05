import { describe, expect, it } from 'vitest';
import {
  authStatus,
  consumePending,
  loadTokens,
  MemoryStorage,
  needsRefresh,
  PENDING_TTL_MS,
  REAUTH_WARNING_MS,
  REFRESH_TOKEN_LIFETIME_MS,
  savePending,
  saveTokens,
  tokensFromResponse,
  type TokenSet,
} from './tokenStore';

const base: TokenSet = {
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: 1_000_000,
  authorizedAt: 0,
  scope: 'streaming',
};

describe('tokensFromResponse', () => {
  it('初回は authorizedAt を now にし、refresh_token を保存する', () => {
    const t = tokensFromResponse(
      { access_token: 'a', token_type: 'Bearer', expires_in: 3600, refresh_token: 'r', scope: 's' },
      1000,
      null,
    );
    expect(t).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 1000 + 3_600_000, authorizedAt: 1000, scope: 's' });
  });

  it('refresh 応答に refresh_token が無ければ旧値を維持し、authorizedAt は動かさない', () => {
    const t = tokensFromResponse({ access_token: 'b', token_type: 'Bearer', expires_in: 3600 }, 5000, base);
    expect(t.refreshToken).toBe('r');
    expect(t.authorizedAt).toBe(0);
    expect(t.scope).toBe('streaming');
    expect(t.accessToken).toBe('b');
  });
});

describe('needsRefresh', () => {
  it('期限 60 秒前から true', () => {
    expect(needsRefresh(base, base.expiresAt - 61_000)).toBe(false);
    expect(needsRefresh(base, base.expiresAt - 60_000)).toBe(true);
    expect(needsRefresh(base, base.expiresAt + 1)).toBe(true);
  });
});

describe('authStatus', () => {
  it('6 か月の 2 週間前から expiring-soon、6 か月で reauth-required', () => {
    expect(authStatus(base, 1)).toBe('ok');
    expect(authStatus(base, REFRESH_TOKEN_LIFETIME_MS - REAUTH_WARNING_MS)).toBe('expiring-soon');
    expect(authStatus(base, REFRESH_TOKEN_LIFETIME_MS)).toBe('reauth-required');
  });
});

describe('load/save tokens', () => {
  it('往復できる。壊れたデータは null', () => {
    const s = new MemoryStorage();
    expect(loadTokens(s)).toBeNull();
    saveTokens(s, base);
    expect(loadTokens(s)).toEqual(base);
    s.setItem('doomify:auth:v1', '{"accessToken": 1}');
    expect(loadTokens(s)).toBeNull();
    s.setItem('doomify:auth:v1', 'not json');
    expect(loadTokens(s)).toBeNull();
  });
});

describe('pending', () => {
  it('1 回だけ読める', () => {
    const s = new MemoryStorage();
    savePending(s, { verifier: 'v', state: 'st', createdAt: 100 });
    expect(consumePending(s, 200)).toEqual({ verifier: 'v', state: 'st', createdAt: 100 });
    expect(consumePending(s, 200)).toBeNull();
  });
  it('TTL を超えたら null', () => {
    const s = new MemoryStorage();
    savePending(s, { verifier: 'v', state: 'st', createdAt: 100 });
    expect(consumePending(s, 100 + PENDING_TTL_MS + 1)).toBeNull();
  });
});
