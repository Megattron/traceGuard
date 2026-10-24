import test from 'node:test';
import assert from 'node:assert/strict';
import { demoEvidence, at, type RawEvent } from '../server/features.ts';
import { deriveAdvanced, deriveSustained, sourceCovered, snapshotLookup, type Snapshot } from '../server/advanced-features.ts';
import { clone, definition, evaluateConfigured, validateConfiguration } from '../server/rules.ts';
import { parseInput } from '../server/config.ts';
import { ruleWindow, stamp, withinBatch } from '../server/windows.ts';
import type { RuleId } from '../server/types.ts';
import { FeatureSource } from '../server/source.ts';
import type { Config } from '../server/config.ts';

const input = parseInput({ scenario: 'rapid_pull', windowStart: '2026-10-23T12:00' });
const evidence = demoEvidence(input);
const config = (id: RuleId) => ({ ...clone(definition(id).defaults!), enabled: true });
const snapshot: Snapshot = { token_ref: evidence.events[0].token_ref, effective_at: '2026-10-23 00:00:00.000', expires_at: '2026-10-24 00:00:00.000', revoked: 0, allowed_video_ids: ['demo-video-001'], original_issued_at: '2026-10-23 00:00:00.000', policy_version: 'TEST' };
const event = (i: number, fields: Partial<RawEvent> = {}): RawEvent => ({ ...evidence.events[(i % evidence.events.length + evidence.events.length) % evidence.events.length], event_id: `test-${i}`, request_ref: `request-${i}`, event_time_ms: at(input.windowStart) + i * 1000, ...fields });
const run = (id: RuleId, rows: RawEvent[], snapshots = [snapshot], history: RawEvent[] = [], c = config(id)) => deriveAdvanced(rows, evidence.media, evidence.coverage, snapshots, input, c, history);

test('R4A dedups request stages and chooses the event-time snapshot before validity checks', () => {
  const rows = [event(1, { video_id: 'outside' }), event(2, { video_id: 'outside', event_type: 'CDN_MEDIA_ACCESS', request_ref: 'request-1', auth_result: -1, http_status: 200, response_bytes: 10 })];
  const [f] = run('R4A', rows);
  assert.equal(f.metrics!.outsideAttempts, 1); assert.equal(f.metrics!.outsideSuccesses, 1);
  assert.equal(f.anomalyScore, 50); assert.equal(f.suspicionScore, 50); assert.equal(f.subjectType, 'TOKEN'); assert.equal(f.videoId, '');
  assert.deepEqual(f.relatedVideoIds, ['outside']);
  const later = { ...snapshot, effective_at: '2026-10-23 12:00:01.500', allowed_video_ids: ['outside'] };
  assert.equal(snapshotLookup([snapshot, later])(rows[0])!.allowed_video_ids[0], 'demo-video-001');
  assert.equal(snapshotLookup([snapshot, later])(rows[1])!.allowed_video_ids[0], 'outside');
  assert.equal(run('R4A', [event(1, { video_id: 'outside' })], [snapshot, { ...snapshot, allowed_video_ids: ['outside'] }])[0].anomalyScore, null);
  assert.equal(run('R4A', [event(1)], [])[0].anomalyScore, null);
});

test('R4A low/medium require denied attempts; unknown response is not denied and success dominates', () => {
  const rows = Array.from({ length: 30 }, (_, i) => event(i, { video_id: `outside-${i % 5}`, auth_result: 0 }));
  assert.equal(run('R4A', rows)[0].anomalyScore, 25);
  const unknown = [...rows, event(40, { video_id: 'outside', auth_result: -1 })];
  assert.equal(run('R4A', unknown)[0].anomalyScore, null);
  assert.equal(run('R4A', [...unknown, event(41, { video_id: 'outside', auth_result: 1 })])[0].anomalyScore, 50);
  const revoked = { ...snapshot, effective_at: '2026-10-23 11:00:00.000', revoked: 1 };
  assert.equal(snapshotLookup([snapshot, revoked])(rows[0])!.revoked, 1);
});

test('R4B jointly checks one pair within its overlap and excludes expired token and unknown environments', () => {
  const rows = Array.from({ length: 40 }, (_, i) => event(i * 5, { request_ip: i % 2 ? '198.51.100.2' : '198.51.100.1', user_agent: i % 2 ? 'Mozilla/5.0 iPhone' : 'Mozilla/5.0 Android' }));
  const [high] = run('R4B', rows);
  assert.equal(high.metrics!.highPairs, 1); assert.equal(high.anomalyScore, 50); assert.equal(high.suspicionScore, null);
  const sameIp = rows.map(e => ({ ...e, request_ip: '198.51.100.1' }));
  assert.equal(run('R4B', sameIp)[0].anomalyScore, 25);
  const separate = rows.map((e, i) => ({ ...e, event_time_ms: at(input.windowStart) + (i % 2 ? 300000 + i * 1000 : i * 1000) }));
  assert.equal(run('R4B', separate)[0].anomalyScore, 10);
  const expired = { ...snapshot, expires_at: '2026-10-23 11:00:00.000' };
  assert.equal(run('R4B', rows, [expired])[0].anomalyScore, 0);
  assert.equal(run('R4B', rows.map(e => ({ ...e, ip_basis: 'SERVER_SOURCE' })))[0].anomalyScore, null);
  assert.equal(run('R4B', rows, [])[0].anomalyScore, null);
  const c = config('R4B'); c.parameters.highPasses = 100;
  assert.equal(run('R4B', rows, [snapshot], [], c)[0].anomalyScore, 25);
});

test('R4B cannot combine pair span and environment counts from different pairs', () => {
  const rows = Array.from({ length: 20 }, (_, i) => event(i * 5, { request_ip: i % 2 ? '198.51.100.2' : '198.51.100.1', user_agent: i % 2 ? 'Mozilla iPhone' : 'Mozilla Android' }));
  const brief = Array.from({ length: 10 }, (_, i) => event(200+i, { request_ip: '198.51.100.3', user_agent: 'Mozilla Windows' }));
  const [f] = run('R4B', [...rows, ...brief]);
  assert.equal(f.metrics!.highPairs, 0); assert.equal(f.anomalyScore, 25);
  const tied = rows.map(e => ({ ...e, event_time_ms: at(input.windowStart) + Math.floor((e.event_time_ms-at(input.windowStart))/10000)*10000, native_sequence: null }));
  assert.equal(run('R4B', tied)[0].metrics!.attentionPairs, 0);
});

test('R5 normalizes SDK versions, excludes proxies/backend, and keeps credential identity separate', () => {
  const rows = Array.from({ length: 32 }, (_, i) => event(i, { request_ip: `198.51.100.${i%8+1}`, user_agent: ['Mozilla Android', 'Mozilla iPhone', 'Mozilla Windows', 'Mozilla Macintosh'][i%4] }));
  assert.equal(run('R5', rows)[0].anomalyScore, 15);
  assert.equal(run('R5', rows.map(e => ({ ...e, user_agent: 'Mozilla Android TraceGuardSDK/1.' + e.event_id })))[0].metrics!.uaCount, 1);
  const proxy = rows.map(e => ({ ...e, ip_basis: 'VERIFIED_PROXY' }));
  assert.equal(run('R5', proxy)[0].reason, 'INSUFFICIENT_VALID_EVENTS');
  const bound = rows.map(e => ({ ...e, event_id: 'bound-' + e.event_id, identity_basis: 'TOKEN_BOUND_VIEWER' }));
  const result = run('R5', [...rows, ...bound, event(400, { event_type: 'TOKEN_CREATE' })]);
  assert.equal(result.length, 2); assert.equal(result.find(f => f.computeStatus === 'AVAILABLE')!.observed, 32);
  assert.equal(result.find(f => f.computeStatus === 'UNAVAILABLE')!.reason, 'IDENTITY_UNVERIFIED');
  assert.equal(run('R5', rows.slice(0, 10))[0].anomalyScore, null);
});

test('R3 requires one persistent subset, merges heartbeats and includes valid pre-window state', () => {
  const start = at(input.windowStart);
  const state = (i: number, video: string, offset: number, end: number) => event(i, { event_type: 'PLAYBACK_STATE', video_id: video, session_ref: video, trusted_state: 1, state: 'PLAYING', event_time_ms: start + offset * 1000, state_valid_until: stamp(start + end * 1000) });
  const rows = [state(1,'v1',-10,90), state(2,'v2',0,30), state(3,'v2',30,100), state(4,'v3',10,80), state(5,'v4',15,85)];
  const [f] = run('R3', rows);
  assert.equal(f.metrics!.concurrentVideos, 4); assert.equal(f.anomalyScore, 50);
  const switching = [state(1,'v1',0,100), state(2,'v2',0,40), state(3,'v3',40,80)];
  assert.equal(run('R3', switching)[0].anomalyScore, 0);
  const stopped = [...rows, { ...state(6, 'v4', 20, 20), state: 'STOPPED' }];
  assert.equal(run('R3', stopped)[0].metrics!.concurrentVideos, 3);
  assert.equal(run('R3', rows.map(e => ({ ...e, state_valid_until: null })))[0].anomalyScore, null);
  assert.equal(run('R3', rows.map(e => ({ ...e, trusted_state: 0 })))[0].anomalyScore, null);
  assert.equal(run('R3', [event(0)])[0].reason, 'MISSING_TRUSTED_STATE');
  assert.equal(run('R3', [state(99, 'expired', -120, -60)]).length, 0);
});

test('R1 missing-step counts are unique fragments and joint evidence is on the same request', () => {
  const rows = evidence.events.slice(0, 120);
  const [f] = run('R1', rows);
  assert.equal(f.anomalyScore, 25); assert.equal(f.metrics!.missingOneSegments, 120);
  assert.equal(f.metrics!.missingTokenKeySegments, 0); assert.equal(f.suspicionScore, null);
  const [revoked] = run('R1', rows, [{ ...snapshot, revoked: 1 }]);
  assert.equal(revoked.anomalyScore, 50); assert.equal(revoked.metrics!.missingTokenKeySegments, 120);
  const retries = Array.from({length:120}, (_,i) => ({ ...rows[0], event_id:'retry-'+i }));
  assert.equal(run('R1', retries)[0].metrics!.missingOneSegments, 1);
  const key = event(-5, { event_type: 'KEY_RESPONSE', http_status: 200, response_completed: 1, key_valid_until: '2026-10-23 13:00:00.000' });
  const manifest = event(-4, { event_type: 'MANIFEST_REQUEST', http_status: 200 });
  assert.equal(run('R1', rows, [snapshot], [key, manifest])[0].anomalyScore, 0);
  const noCoverage = deriveAdvanced(rows, evidence.media, [], [snapshot], input, config('R1'))[0];
  assert.equal(noCoverage.anomalyScore, null);
  assert.equal(f.limitations!.length, 1);
});

test('R8 uses the whole day, minute sets and unique media union rather than request sums', () => {
  const window = ruleWindow(input, 'R8');
  const rows = Array.from({ length: 960 }, (_, i) => event(i, { event_time_ms: at(window.windowStart) + i * 60000, request_url: `/long/${i}.ts` }));
  const media = rows.map((e,i) => ({ ...evidence.media[0], object_path: e.request_url, segment_index: i, media_start_s: i*60, media_end_s: (i+1)*60, total_segments:960 }));
  const f = deriveSustained(rows, media, evidence.coverage, window, config('R8'))[0];
  assert.equal(f.metrics!.activeMinutes,960); assert.equal(f.metrics!.contentSeconds,57600); assert.equal(f.anomalyScore,15);
  const retry = rows.map(e => ({...e, event_id:'retry-'+e.event_id}));
  assert.equal(deriveSustained([...rows,...retry],media,evidence.coverage,window,config('R8'))[0].metrics!.contentSeconds,57600);
  assert.equal(deriveSustained(rows,media,[],window,config('R8'))[0].anomalyScore,null);
  assert.equal(deriveSustained(rows,media,evidence.coverage,input,config('R8'))[0]?.anomalyScore ?? null,null);
});

test('windows share their end, enforce batch boundaries, and independent rules survive an unavailable long window', async () => {
  assert.equal(ruleWindow(input,'R3').windowStart,'2026-10-23 12:05:00.000');
  assert.equal(ruleWindow(input,'R4A').windowStart,'2026-10-23 11:40:00.000');
  assert.equal(ruleWindow(input,'R5').windowStart,'2026-10-23 11:10:00.000');
  assert.equal(ruleWindow(input,'R8').windowStart,'2026-10-22 12:10:00.000');
  const early = parseInput({scenario:'rapid_pull',windowStart:'2026-10-16T12:00'});
  assert.equal(withinBatch(ruleWindow(early,'R8')),false);
  const cfg: Config = {mode:'demo',host:'127.0.0.1',port:0,tenantId:'test',runId:'test',sqlitePath:'',clickhouse:{url:'',user:'',password:'',database:'da'}};
  const features = await new FeatureSource(cfg).extract(early,[config('R2'),config('R8')]);
  assert.equal(features.find(f=>f.ruleId==='R2')!.anomalyScore,50);
  assert.equal(features.find(f=>f.ruleId==='R8')!.reason,'WINDOW_OUTSIDE_BATCH');
});

test('branch validation rejects executable or altered structures; OR is evaluated without scoring all branches', () => {
  const c = config('R4B');
  assert.equal(validateConfiguration('R4B',c).tiers[1].alternatives!.length,1);
  assert.equal(evaluateConfigured(c,{generalEnvironments:2,attentionEnvironments:2,attentionPairs:1,highPairs:0}).anomalyScore,25);
  const invalid = clone(c); invalid.tiers[1].alternatives![0][0].field='sql';
  assert.throws(()=>validateConfiguration('R4B',invalid));
  const removed = clone(c); delete removed.tiers[1].alternatives;
  assert.throws(()=>validateConfiguration('R4B',removed));
  const inverted = clone(c); inverted.parameters.generalPasses=100;
  assert.throws(()=>validateConfiguration('R4B',inverted));
  assert.equal(sourceCovered(evidence.coverage,'TS_VALIDATE',at(input.windowStart),at(input.windowEnd)),true);
});
