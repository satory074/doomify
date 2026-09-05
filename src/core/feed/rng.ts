/** シード可能な乱数(テストの決定性のため)。本番は Math.random を包む */

export type Rng = () => number;

export const mathRandom: Rng = () => Math.random();

/** mulberry32 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [min, max) の整数 */
export function randomInt(rng: Rng, minInclusive: number, maxExclusive: number): number {
  if (maxExclusive <= minInclusive) return minInclusive;
  return minInclusive + Math.floor(rng() * (maxExclusive - minInclusive));
}

export function pickOne<T>(rng: Rng, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[randomInt(rng, 0, items.length)];
}

/** 重み付き抽選。重みが全て 0 以下なら undefined */
export function pickWeighted<T>(rng: Rng, items: readonly T[], weight: (item: T) => number): T | undefined {
  let total = 0;
  const weights = items.map((it) => {
    const w = Math.max(0, weight(it));
    total += w;
    return w;
  });
  if (total <= 0) return undefined;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i] ?? 0;
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

/** Fisher–Yates(非破壊) */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(rng, 0, i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}
