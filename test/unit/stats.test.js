import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  binomialUpperTail,
  clamp01,
  groupBy,
  levenshtein,
  mad,
  mannWhitneyGreater,
  median,
  normalCdf,
  poissonUpperTail,
  pStrength,
  ramp,
  robustZ,
  sumBy,
} from '../../src/domain/suspicion/stats.js';

const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);

describe('basic statistics', () => {
  test('clamp, ramp and p-value strength', () => {
    assert.equal(clamp01(-1), 0);
    assert.equal(clamp01(2), 1);
    assert.equal(ramp(5, 0, 10), 0.5);
    assert.equal(ramp(-5, 0, 10), 0);
    assert.equal(ramp(50, 0, 10), 1);
    assert.equal(pStrength(0.5), 0);
    assert.equal(pStrength(0.01), 0);
    close(pStrength(1e-4), 0.5);
    assert.equal(pStrength(1e-9), 1);
    assert.equal(pStrength(0), 1);
  });

  test('median and MAD', () => {
    assert.equal(median([]), 0);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(mad([1, 2, 3, 4, 100]), 1);
  });

  test('robust z ignores the outlier it is measuring', () => {
    const values = [10, 10, 12, 9, 11, 10, 1000];
    assert.ok(robustZ(1000, values) > 100);
    assert.ok(Math.abs(robustZ(11, values)) < 2);
    assert.equal(robustZ(10, [10, 10, 10]), 0);
    assert.equal(robustZ(15, [10, 10, 10], 1), 5, 'minScale prevents infinity when all peers are equal');
  });

  test('groupBy and sumBy', () => {
    const groups = groupBy([1, 2, 3, 4], (x) => x % 2);
    assert.deepEqual([...groups.get(0)], [2, 4]);
    assert.equal(sumBy([{ a: 2 }, { a: 3 }], (x) => x.a), 5);
  });
});

describe('probability tails', () => {
  test('binomial tail matches exact values', () => {
    close(binomialUpperTail(1, 1, 0.5), 0.5);
    close(binomialUpperTail(2, 2, 0.5), 0.25);
    close(binomialUpperTail(8, 10, 0.5), 56 / 1024);
    close(binomialUpperTail(0, 10, 0.3), 1);
    assert.equal(binomialUpperTail(11, 10, 0.3), 0);
    assert.equal(binomialUpperTail(3, 10, 0), 0);
    assert.equal(binomialUpperTail(3, 10, 1), 1);
  });

  test('binomial tail stays accurate for large n (log space)', () => {
    const p = binomialUpperTail(700, 1000, 0.5);
    assert.ok(p > 0 && p < 1e-35, String(p));
    close(binomialUpperTail(500, 1000, 0.5), 0.5126, 1e-3);
  });

  test('poisson tail', () => {
    close(poissonUpperTail(1, 2), 1 - Math.exp(-2));
    close(poissonUpperTail(3, 1), 1 - Math.exp(-1) * (1 + 1 + 0.5));
    assert.equal(poissonUpperTail(0, 5), 1);
    assert.equal(poissonUpperTail(2, 0), 0);
  });

  test('normal CDF', () => {
    close(normalCdf(0), 0.5, 1e-7);
    close(normalCdf(1.96), 0.975, 1e-4);
    close(normalCdf(-1.96), 0.025, 1e-4);
  });

  test('Mann–Whitney detects a shifted group and not an identical one', () => {
    const low = [1, 2, 3, 4, 5, 6, 7, 8];
    const high = [11, 12, 13, 14, 15, 16, 17, 18];
    assert.ok(mannWhitneyGreater(high, low) < 0.001);
    assert.ok(mannWhitneyGreater(low, high) > 0.99);
    assert.ok(mannWhitneyGreater([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]) > 0.4);
    assert.equal(mannWhitneyGreater([5, 5, 5], [5, 5, 5]), 1, 'all ties: no variance');
    assert.equal(mannWhitneyGreater([], [1, 2]), 1);
  });
});

describe('edit distance', () => {
  test('classic cases', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3);
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('same', 'same'), 0);
    assert.equal(levenshtein('kovacs peter', 'kovacs petr'), 1);
  });

  test('gives up early past the maximum', () => {
    assert.equal(levenshtein('abcdef', 'uvwxyz', 1), 2);
    assert.equal(levenshtein('a', 'abcdef', 2), 3);
  });
});
