import test from 'node:test';
import assert from 'node:assert/strict';
import { demoEvidence, deriveFeatures, intervalUnion, type RawEvent } from '../server/features.ts';
import { clone, definition, evaluateConfigured, validateConfiguration } from '../server/rules.ts';
import { parseInput } from '../server/config.ts';
import type { RuleId } from '../server/types.ts';

const configuration = (id: RuleId) => ({ ...clone(definition(id).defaults!), enabled: true });
const rapid = parseInput({ scenario: 'rapid_pull', windowStart: '2026-10-23T12:00' });

test('rapid pull produces 7200 unique media seconds and separate R2/R6 contributions', () => {
  const e = demoEvidence(rapid);
  const [r2, r6] = deriveFeatures(e.events, e.media, e.coverage, rapid, [configuration('R2'), configuration('R6')]);
  assert.equal(r2.metrics!.contentSeconds, 7200); assert.equal(r2.metrics!.speedRatio, 12);
  assert.equal(r2.anomalyScore, 50); assert.equal(r2.suspicionScore, null);
  assert.equal(r6.metrics!.coverage, 1); assert.equal(r6.metrics!.monotonic, 1); assert.equal(r6.metrics!.intervalCv, 0);
  assert.equal(r6.anomalyScore, 15); assert.equal(r6.suspicionScore, 0);
});

test('interval union dedups repeats and aligned renditions/tracks but preserves content versions', () => {
  assert.equal(intervalUnion([[0, 6], [6, 12], [0, 6], [0, 6]]), 12);
  const e = demoEvidence(rapid); const rows = e.events.slice(0, 2);
  const duplicate: RawEvent = { ...rows[0], event_id: 'new-real-retry', event_time_ms: rows[1].event_time_ms + 1 };
  const [result] = deriveFeatures([...rows, duplicate], e.media, e.coverage, rapid, [configuration('R2')]);
  assert.equal(result.metrics!.contentSeconds, 20);
  assert.equal(result.observed, 3);
});

test('missing media, ambiguous mappings, sampling, coverage and identity cannot produce a confident zero', () => {
  const e = demoEvidence(rapid);
  const variants = [
    { events: e.events, media: [], coverage: e.coverage },
    { ...e, media: [...e.media, e.media[0]] },
    { ...e, coverage: [] },
    { ...e, events: e.events.map(row => ({ ...row, sampling_rate: .1 })) },
    { ...e, events: e.events.map(row => ({ ...row, identity_basis: 'TOKEN_BOUND_VIEWER' })) },
  ];
  for (const v of variants) for (const result of deriveFeatures(v.events, v.media, v.coverage, rapid, [configuration('R2'), configuration('R6')])) {
    assert.equal(result.computeStatus, 'UNAVAILABLE'); assert.equal(result.anomalyScore, null);
  }
});

test('R6 never concatenates sessions or invents order for tied timestamps', () => {
  const e = demoEvidence(rapid);
  const events = e.events.slice(0, 40).map((row, i) => ({ ...row, session_ref: i < 20 ? 'session-a' : 'session-b' }));
  const results = deriveFeatures(events, e.media, e.coverage, rapid, [configuration('R6')]);
  assert.equal(results.length, 2); assert.ok(results.every(f => f.metrics!.uniqueSegments === 20 && f.anomalyScore === 0));
  const tied = e.events.map((row, i) => ({ ...row, event_time_ms: i === 1 ? e.events[0].event_time_ms : row.event_time_ms, native_sequence: null }));
  const [result] = deriveFeatures(tied, e.media, e.coverage, rapid, [configuration('R6')]);
  assert.equal(result.reason, 'AMBIGUOUS_EVENT_ORDER'); assert.equal(result.anomalyScore, null);
});

test('credential-bound identities never merge into an authenticated viewer with the same identifier', () => {
  const e = demoEvidence(rapid);
  const bound = e.events.map(row => ({ ...row, event_id: `bound-${row.event_id}`, identity_basis: 'TOKEN_BOUND_VIEWER' }));
  for (const id of ['R2', 'R6'] as const) {
    const results = deriveFeatures([...e.events, ...bound], e.media, e.coverage, rapid, [configuration(id)]);
    assert.equal(results.length, 2);
    const verified = results.find(f => f.computeStatus === 'AVAILABLE')!;
    const unknown = results.find(f => f.computeStatus === 'UNAVAILABLE')!;
    assert.equal(verified.observed, 720); assert.equal(unknown.reason, 'IDENTITY_UNVERIFIED');
    assert.equal(unknown.anomalyScore, null);
  }
});

test('R10 separates signatures, canonicalizes stages, dedups request refs and excludes backend/legitimate tools', () => {
  const input = parseInput({ scenario: 'client_tool', windowStart: '2026-10-23T18:00' }); const e = demoEvidence(input);
  const split = e.events.map((row, i) => ({ ...row, user_agent: i < 10 ? 'curl/8' : 'python-requests/2', event_type: i % 2 ? 'MANIFEST_REQUEST' : 'TS_VALIDATE' }));
  const results = deriveFeatures(split, [], [], input, [configuration('R10')]);
  assert.equal(results.length, 2); assert.ok(results.every(r => r.metrics!.toolRequests === 10 && r.anomalyScore === 5));
  const duplicate = { ...e.events[0], event_id: 'cdn-response', event_type: 'CDN_MEDIA_ACCESS' };
  const [one] = deriveFeatures([e.events[0], duplicate, { ...e.events[0], event_type: 'TOKEN_CREATE', event_id: 'backend' }], [], [], input, [configuration('R10')]);
  assert.equal(one.metrics!.toolRequests, 1); assert.equal(one.metrics!.toolStages, 1);
  const [legitimate] = deriveFeatures(e.events.map(row => ({ ...row, source: 'HEALTH_CHECK' })), [], [], input, [configuration('R10')]);
  assert.equal(legitimate.anomalyScore, 0);
});

test('R9 supports cross-midnight hours and stays a zero-score label', () => {
  const input = parseInput({ scenario: 'sustained_access', windowStart: '2026-10-23T02:00' }); const e = demoEvidence(input);
  const [result] = deriveFeatures(e.events, [], [], input, [configuration('R9')]);
  assert.equal(result.metrics!.nightEvents, 10); assert.equal(result.labelHit, true); assert.equal(result.anomalyScore, 0);
  const mixed = e.events.map((row, i) => ({ ...row, viewer_id: i % 2 ? 'viewer-a' : 'viewer-b' }));
  const [videoTag] = deriveFeatures(mixed, [], [], input, [configuration('R9')]);
  assert.equal(videoTag.actorId, ''); assert.equal(videoTag.metrics!.nightEvents, 10);
  const rule = configuration('R9'); rule.parameters = { nightStartHour: 22, nightEndHour: 6 };
  const [cross] = deriveFeatures(e.events, [], [], input, [rule]); assert.equal(cross.labelHit, true);
});

test('configuration validation enforces immutable fields/operators, score ceilings and monotonic tiers', () => {
  for (const mutate of [
    (c: ReturnType<typeof configuration>) => { c.tiers[0].conditions[0].field = 'user_sql'; },
    (c: ReturnType<typeof configuration>) => { c.tiers[0].conditions[0].value = -1; },
    (c: ReturnType<typeof configuration>) => { c.tiers[2].score = 100; },
    (c: ReturnType<typeof configuration>) => { c.tiers[2].conditions[0].value = 1; },
    (c: ReturnType<typeof configuration>) => { c.tiers[0].conditions.pop(); },
  ]) { const c = configuration('R7'); mutate(c); assert.throws(() => validateConfiguration('R7', c)); }
  assert.throws(() => validateConfiguration('R3', { enabled: true }));
  assert.throws(() => validateConfiguration('R7', { ...configuration('R7'), sql: '1=1' }));
  assert.throws(() => validateConfiguration('R9', { ...configuration('R9'), parameters: { nightStartHour: 6, nightEndHour: 6 } }));
  assert.equal(validateConfiguration('R7', configuration('R7')).parameters.minimumKnownResults, 100);
  assert.equal(evaluateConfigured(configuration('R2'), { contentSeconds: null, speedRatio: 12 }).anomalyScore, null);
});
