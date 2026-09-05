/** カバーアートから配色を作る純粋ロジック。
 *  アート自体は無加工で表示し、抽出した色はカードの地(暗く沈めた色)と光(明るい色)に使う */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export interface CardPalette {
  /** カードの背景色 */
  bg: string;
  /** アートの後ろのにじみ */
  glow: string;
  /** 主色(ライク時のアクセントなどに) */
  accent: string;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

export function hslCss({ h, s, l }: Hsl, alpha = 1): string {
  const hh = Math.round(h);
  const ss = Math.round(Math.max(0, Math.min(1, s)) * 100);
  const ll = Math.round(Math.max(0, Math.min(1, l)) * 100);
  return alpha >= 1 ? `hsl(${hh} ${ss}% ${ll}%)` : `hsl(${hh} ${ss}% ${ll}% / ${Math.round(alpha * 100)}%)`;
}

export interface ColorBin {
  color: Rgb;
  count: number;
}

/** RGBA ピクセル列を 3bit/ch のビンに量子化して、出現数の多い色を返す */
export function quantize(data: ArrayLike<number>, maxBins = 8): ColorBin[] {
  const sums = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a < 128) continue;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bin = sums.get(key);
    if (bin) {
      bin.r += r;
      bin.g += g;
      bin.b += b;
      bin.n++;
    } else {
      sums.set(key, { r, g, b, n: 1 });
    }
  }
  return [...sums.values()]
    .map((s) => ({ color: { r: Math.round(s.r / s.n), g: Math.round(s.g / s.n), b: Math.round(s.b / s.n) }, count: s.n }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxBins);
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** 色ビンから配色を決める。彩度のある色を優先し、白黒に近いビンは地味な既定色に寄せる */
export function cardPalette(bins: readonly ColorBin[]): CardPalette {
  const scored = bins
    .map((b) => {
      const hsl = rgbToHsl(b.color);
      // 暗すぎ・明るすぎ・無彩色は主役になりにくい
      const vivid = hsl.s * (1 - Math.abs(hsl.l - 0.5) * 1.6);
      return { hsl, score: b.count * (0.15 + Math.max(0, vivid)) };
    })
    .sort((a, b) => b.score - a.score);
  const primary = scored[0]?.hsl ?? { h: 250, s: 0.3, l: 0.4 };
  const secondary = scored.find((c) => hueDistance(c.hsl.h, primary.h) > 40 && c.hsl.s > 0.15)?.hsl ?? {
    h: (primary.h + 30) % 360,
    s: primary.s,
    l: primary.l,
  };
  const muted = primary.s < 0.12;
  return {
    bg: hslCss({ h: primary.h, s: muted ? 0.12 : Math.min(0.55, primary.s * 0.8 + 0.1), l: 0.15 }),
    glow: hslCss({ h: secondary.h, s: muted ? 0.2 : Math.max(0.45, secondary.s), l: 0.5 }, 0.5),
    accent: hslCss({ h: primary.h, s: muted ? 0.25 : Math.max(0.5, primary.s), l: 0.75 }),
  };
}

export const FALLBACK_PALETTE: CardPalette = {
  bg: 'hsl(250 22% 15%)',
  glow: 'hsl(262 45% 50% / 45%)',
  accent: 'hsl(250 60% 78%)',
};
