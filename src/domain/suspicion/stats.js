// Small, dependency-free statistics toolkit for the suspicion detectors.

export const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** 0 at or below `from`, 1 at or above `to`, linear in between. */
export const ramp = (x, from, to) => clamp01((x - from) / (to - from));

/**
 * Converts a p-value into a 0..1 strength: p = 1% starts to count, p = one in
 * a million (or smaller) counts fully. Thresholds this strict keep ordinary
 * party noise from lighting up the report.
 */
export const pStrength = (p, from = 2, to = 6) => ramp(-Math.log10(Math.max(p, 1e-300)), from, to);

export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation: a spread measure that a few extreme values can't distort. */
export function mad(values, center = median(values)) {
  return median(values.map((v) => Math.abs(v - center)));
}

/**
 * Modified z-score (Iglewicz & Hoaglin): distance from the median in robust
 * standard deviations. Values above ~3.5 are classic outliers. A cheater can't
 * "hide" an extreme value by also inflating the mean, as they could with a plain z-score.
 * `minScale` stops a group of identical values from turning any difference into infinity.
 */
export function robustZ(x, values, minScale = 1) {
  const center = median(values);
  const scale = Math.max(1.4826 * mad(values, center), minScale);
  return (x - center) / scale;
}

const logFactorials = [0, 0];
function logFactorial(n) {
  for (let i = logFactorials.length; i <= n; i++) logFactorials[i] = logFactorials[i - 1] + Math.log(i);
  return logFactorials[n];
}

/** P(X ≥ k) for X ~ Binomial(n, p), computed exactly in log space. */
export function binomialUpperTail(k, n, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let total = 0;
  for (let i = k; i <= n; i++) {
    total += Math.exp(logFactorial(n) - logFactorial(i) - logFactorial(n - i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, total);
}

/** P(X ≥ k) for X ~ Poisson(mu). */
export function poissonUpperTail(k, mu) {
  if (k <= 0) return 1;
  if (mu <= 0) return 0;
  let below = 0;
  for (let i = 0; i < k; i++) below += Math.exp(-mu + i * Math.log(mu) - logFactorial(i));
  return clamp01(1 - below);
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7). */
export function normalCdf(z) {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * Mann–Whitney U test: do values in `a` tend to be larger than values in `b`?
 * Rank-based, so it doesn't assume any distribution. Returns the one-sided p-value.
 */
export function mannWhitneyGreater(a, b) {
  if (a.length === 0 || b.length === 0) return 1;
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const n = all.length;
  let rankSumA = 0;
  let tieTerm = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && all[j + 1].v === all[i].v) j++;
    const avgRank = (i + j) / 2 + 1;
    const ties = j - i + 1;
    tieTerm += ties ** 3 - ties;
    for (let x = i; x <= j; x++) if (all[x].g === 0) rankSumA += avgRank;
    i = j + 1;
  }
  const n1 = a.length;
  const n2 = b.length;
  const u = rankSumA - (n1 * (n1 + 1)) / 2;
  const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)));
  if (variance <= 0) return 1;
  const z = (u - (n1 * n2) / 2 - 0.5) / Math.sqrt(variance); // continuity correction
  return 1 - normalCdf(z);
}

/** Edit distance, giving up early (returning max + 1) once it exceeds `max`. */
export function levenshtein(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

export function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

export const sumBy = (items, valueOf) => items.reduce((total, item) => total + valueOf(item), 0);
