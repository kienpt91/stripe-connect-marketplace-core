/** A small seeded generator (mulberry32): property tests that fail can be repeated from the seed that is printed with them. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function int(next: () => number, min: number, max: number): number {
  return min + Math.floor(next() * (max - min + 1));
}

export function shuffle<T>(next: () => number, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(next, 0, i);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** `total` cut into `parts` positive whole numbers (parts <= total). */
export function partition(next: () => number, total: number, parts: number): number[] {
  const cuts = new Set<number>();
  while (cuts.size < parts - 1) cuts.add(int(next, 1, total - 1));
  const sorted = [0, ...[...cuts].sort((a, b) => a - b), total];
  return sorted.slice(1).map((v, i) => v - (sorted[i] as number));
}
