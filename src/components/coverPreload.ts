import type { FeedItem } from '../core/feed/types';
import { pickImage } from '../core/spotify/types';

const preloaded = new Set<string>();

/** index の次とその次のカバー画像を先に取っておく(DOM は変えない)。向かう先が分かった時点で呼ぶ */
export function preloadCovers(items: readonly FeedItem[], index: number): void {
  for (const i of [index + 1, index + 2]) {
    const item = items[i];
    const url = item !== undefined ? pickImage(item.track.album.images, 640)?.url : undefined;
    if (url === undefined || preloaded.has(url)) continue;
    preloaded.add(url);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
  }
}
