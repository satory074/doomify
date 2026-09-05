import { describe, expect, it } from 'vitest';
import { cardPalette, hslCss, quantize, rgbToHsl } from './palette';

describe('rgbToHsl / hslCss', () => {
  it('純色と無彩色', () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, l: 0.5 });
    expect(rgbToHsl({ r: 0, g: 255, b: 0 }).h).toBe(120);
    expect(rgbToHsl({ r: 128, g: 128, b: 128 }).s).toBe(0);
    expect(hslCss({ h: 10.4, s: 0.5, l: 0.15 })).toBe('hsl(10 50% 15%)');
    expect(hslCss({ h: 10, s: 0.5, l: 0.15 }, 0.5)).toBe('hsl(10 50% 15% / 50%)');
  });
});

describe('quantize', () => {
  it('透明を無視し、多い色から返す', () => {
    const px: number[] = [];
    for (let i = 0; i < 30; i++) px.push(200, 40, 40, 255);
    for (let i = 0; i < 10; i++) px.push(40, 40, 200, 255);
    for (let i = 0; i < 50; i++) px.push(0, 0, 0, 0);
    const bins = quantize(px);
    expect(bins).toHaveLength(2);
    expect(bins[0]?.count).toBe(30);
    expect(bins[0]?.color).toEqual({ r: 200, g: 40, b: 40 });
  });
});

describe('cardPalette', () => {
  it('彩度のある色を主色に選び、暗い地と明るい光を返す', () => {
    const p = cardPalette([
      { color: { r: 30, g: 30, b: 30 }, count: 500 },
      { color: { r: 220, g: 60, b: 30 }, count: 120 },
      { color: { r: 40, g: 80, b: 200 }, count: 60 },
    ]);
    expect(p.bg).toMatch(/^hsl\((9|1[0-9]) /);
    expect(p.bg).toMatch(/ 15%\)$/);
    expect(p.glow).toMatch(/^hsl\(2[0-9]{2} /);
    expect(p.glow).toMatch(/\/ 50%\)$/);
  });
  it('ビンが無くても既定色を返す', () => {
    expect(cardPalette([]).bg).toMatch(/^hsl\(/);
  });
});
