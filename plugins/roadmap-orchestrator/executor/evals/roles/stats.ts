// Small statistics for role-eval aggregation: Wilson score intervals for rates, medians and nearest-rank percentiles.

export type Interval = Readonly<{ k: number; n: number; rate: number | null; low: number | null; high: number | null }>;

/** The Wilson score interval of k successes in n trials (95%: z 1.96); every field null-rate when n is 0. */
export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n === 0) return { k, n, rate: null, low: null, high: null };
  const p = k / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { k, n, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** The nearest-rank `q` quantile (0 < q <= 1) of `xs`; null when empty. */
export function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

/** The median (mean of the middle two for an even count); null when empty. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export const fmtRate = (i: Interval): string =>
  i.rate === null ? `-/0` : `${i.k}/${i.n} ${(i.rate * 100).toFixed(0)}% [${((i.low ?? 0) * 100).toFixed(0)}–${((i.high ?? 0) * 100).toFixed(0)}%]`;
