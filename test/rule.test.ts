import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateR7, validateFeature } from '../server/rule.ts';
import { parseInput } from '../server/config.ts';

test('R7 uses the highest tier and keeps UNKNOWN outside the known-result denominator', () => {
  for (const [passed, failed, unknown, score] of [
    [80, 20, 30, 0], [70, 30, 0, 10], [100, 100, 500, 25],
    [75, 300, 0, 50], [1, 299, 0, 25], [1200, 300, 0, 10],
  ]) {
    const result = evaluateR7(passed, failed, unknown);
    assert.equal(result.anomalyScore, score);
    assert.equal(result.suspicionScore, 0);
    assert.equal(result.known, passed + failed);
    assert.equal(result.failureRatio, failed / (passed + failed));
  }
});

test('unknown, insufficient samples and missing video mapping are unavailable rather than safe', () => {
  assert.equal(evaluateR7(0, 0, 100).anomalyScore, null);
  assert.equal(evaluateR7(0, 99, 0).reason, 'INSUFFICIENT_KNOWN_RESULTS');
  assert.equal(evaluateR7(100, 300, 0, '').reason, 'MISSING_VIDEO_MAPPING');
  assert.throws(() => evaluateR7(50, -1, 0));
  assert.throws(() => evaluateR7(50, 0.2, 0));
});

test('upstream counts, ratios and SQL scores must agree before an alert is accepted', () => {
  const row = { video_id: 'v1', scenario_id: 'failure_burst', source: 'SIMULATOR', event_type: 'TS_VALIDATE',
    dataset_kinds: ['SYNTHETIC'], observed: 200, passed: 50, failed: 150, unknown: 0, known: 200,
    failure_ratio: 0.75, anomaly_score: 25 };
  assert.equal(validateFeature(row).anomalyScore, 25);
  for (const change of [{ anomaly_score: 50 }, { observed: 201 }, { failure_ratio: 'invalid' }, { failure_ratio: null }, { known: 201 }]) {
    assert.throws(() => validateFeature({ ...row, ...change }));
  }
});

test('window boundaries use explicit Shanghai time and cannot escape the validation range', () => {
  assert.deepEqual(parseInput({ scenario: 'failure_burst', windowStart: '2026-10-23T14:00' }), {
    scenario: 'failure_burst', windowStart: '2026-10-23 14:00:00.000', windowEnd: '2026-10-23 14:10:00.000',
  });
  assert.equal(parseInput({ scenario: 'normal', windowStart: '2026-10-23T23:50' }).windowEnd, '2026-10-24 00:00:00.000');
  for (const start of ['2026-10-23T23:51', '2026-10-23T25:00', '2026-10-24T00:00', '2026-10-15T14:00', 'not-a-date']) {
    assert.throws(() => parseInput({ scenario: 'failure_burst', windowStart: start }));
  }
  assert.throws(() => parseInput({ scenario: 'arbitrary', windowStart: '2026-10-23T14:00' }));
});
