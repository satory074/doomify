import { useEffect, useState } from 'react';
import { cardPalette, FALLBACK_PALETTE, quantize, type CardPalette } from '../core/palette';

const cache = new Map<string, CardPalette>();

function extract(img: HTMLImageElement): CardPalette {
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) return FALLBACK_PALETTE;
  ctx.drawImage(img, 0, 0, size, size);
  return cardPalette(quantize(ctx.getImageData(0, 0, size, size).data));
}

/** カバー画像から配色を作る。i.scdn.co は CORS を許可しているので canvas で読める。失敗時は既定色 */
export function useCoverPalette(url: string | undefined): CardPalette {
  const [loaded, setLoaded] = useState<{ url: string; palette: CardPalette } | null>(null);
  const cached = url !== undefined ? cache.get(url) : undefined;

  useEffect(() => {
    if (url === undefined || cache.has(url)) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      let palette = FALLBACK_PALETTE;
      try {
        palette = extract(img);
      } catch {
        // canvas が汚染された等。既定色で続ける
      }
      cache.set(url, palette);
      if (!cancelled) setLoaded({ url, palette });
    };
    img.onerror = () => {
      cache.set(url, FALLBACK_PALETTE);
      if (!cancelled) setLoaded({ url, palette: FALLBACK_PALETTE });
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (cached !== undefined) return cached;
  if (loaded !== null && loaded.url === url) return loaded.palette;
  return FALLBACK_PALETTE;
}
