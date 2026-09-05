import { describe, expect, it } from 'vitest';
import { detectEnvironment } from './env';

const base = { platform: 'Win32', maxTouchPoints: 0, displayModeStandalone: false, iosStandalone: false };

describe('detectEnvironment', () => {
  it('iPhone', () => {
    const env = detectEnvironment({ ...base, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)' });
    expect(env.isIos).toBe(true);
    expect(env.isMobile).toBe(true);
    expect(env.isAndroid).toBe(false);
  });
  it('iPadOS(Macintosh UA + タッチ)', () => {
    const env = detectEnvironment({
      ...base,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    });
    expect(env.isIos).toBe(true);
  });
  it('Android + standalone', () => {
    const env = detectEnvironment({
      ...base,
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)',
      displayModeStandalone: true,
    });
    expect(env.isAndroid).toBe(true);
    expect(env.isStandalone).toBe(true);
  });
  it('デスクトップ', () => {
    const env = detectEnvironment({ ...base, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    expect(env.isMobile).toBe(false);
  });
});
