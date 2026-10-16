// A seeded PRNG for the role-eval fixtures: the same seed string gives the same sequence on every host, so the same seed
// gives the same generated tree (and tree hash). sha256 of the seed seeds a mulberry32 stream.
import { createHash } from 'node:crypto';

export type Rng = Readonly<{
  /** Uniform in [0, 1). */
  next: () => number;
  /** Uniform integer in [0, n). */
  int: (n: number) => number;
  /** Uniform integer in [lo, hi]. */
  range: (lo: number, hi: number) => number;
  pick: <T>(xs: readonly T[]) => T;
  shuffle: <T>(xs: readonly T[]) => T[];
}>;

export function rng(seed: string): Rng {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`rng.int: ${n} is not a positive integer`);
    return Math.floor(next() * n);
  };
  return {
    next,
    int,
    range: (lo, hi) => lo + int(hi - lo + 1),
    pick: (xs) => {
      if (xs.length === 0) throw new Error('rng.pick: an empty list');
      return xs[int(xs.length)]!;
    },
    shuffle: (xs) => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}
