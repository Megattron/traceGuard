import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { buildTimeline, type ReplayInput } from '../server/timeline.ts';
import type { RawEvent, Media } from '../server/features.ts';
import type { Snapshot } from '../server/advanced-features.ts';
import type { Config } from '../server/config.ts';

const cfg = (path: string): Config => ({ host: '127.0.0.1', port: 0, mode: 'demo', tenantId: 't', runId: 'r', sqlitePath: path, clickhouse: { url: '', database: 'da', user: 'x', password: '' } });
async function listen(server: Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`; }
async function close(server: Server) { if (!server.listening) return; const done = once(server, 'close'); server.close(); server.closeAllConnections(); await done; }
async function get(url: string, path: string) { const response = await fetch(url + path); return { status: response.status, ...(await response.json()) }; }

const T0 = Date.parse('2026-10-23T12:00:00+08:00');
const at = (seconds: number) => T0 + Math.round(seconds * 1000);
const stamp = (seconds: number) => {
  const base = new Date(T0 + 8 * 3600000 + seconds * 1000).toISOString();
  return base.slice(0, 23).replace('T', ' ');
};

let counter = 0;
function event(type: string, t: number, overrides: Partial<RawEvent> = {}): RawEvent {
  counter += 1;
  return {
    event_id: `e${counter}`, video_id: 'sim_course_01', source: 'SIMULATOR', event_type: type, dataset_kind: 'SYNTHETIC',
    auth_result: 1, viewer_id: 'viewer-a', credential_viewer_id: 'viewer-a', identity_basis: 'AUTHENTICATED_VIEWER', association_status: 'CONFIRMED',
    token_ref: 'tok-1', session_ref: 'session-1', request_ref: `req${counter}`, request_url: '/hls/0.ts',
    user_agent: 'Mozilla/5.0 (Linux; Android 10) Chrome/120', parse_status: 'OK',
    sampling_rate: 1, sampling_method: 'CENSUS', sampling_unit: 'AUTH_EVENT', native_sequence: null,
    event_time_ms: t, request_ip: '198.51.100.1', ip_basis: 'TRUSTED_REQUEST',
    ...overrides,
  };
}
function segmentMedia(count = 720, videoId = 'sim_course_01'): Media[] {
  return Array.from({ length: count }, (_, index) => ({
    object_path: `/hls/${videoId}/${index}.ts`, video_id: videoId, content_version: 'c1', resource_version: 'v1',
    playlist_ref: 'p1', rendition_ref: '1080', track_type: 'VIDEO', segment_index: index,
    media_start_s: index * 10, media_end_s: index * 10 + 10, total_segments: count, manifest_available: 1,
  }));
}
const snapshot = (ref = 'tok-1', expires = '2026-10-23 15:00:00.000'): Snapshot => ({
  token_ref: ref, effective_at: '2026-10-23 12:00:00.000', expires_at: expires, revoked: 0,
  allowed_video_ids: ['sim_course_01'], original_issued_at: '2026-10-23 12:00:00.000', policy_version: 'v1',
});
const input = (overrides: Partial<ReplayInput> = {}): ReplayInput => ({
  ruleId: 'R2', ruleName: '高速内容获取', scenario: 'rapid_pull',
  windowStart: '2026-10-23 12:00:00.000', windowEnd: '2026-10-23 12:10:00.000', videoId: 'sim_course_01', tier: '高档',
  contextId: JSON.stringify(['sim_course_01', ['VIEWER', 'viewer-a'], 'SIMULATOR']), ...overrides,
  scoring:overrides.scoring||{anomalyScore:50,suspicionScore:null,reason:'BUSINESS_DOWNLOAD_POLICY_UNVERIFIED'},
});

test('buildTimeline replays the rapid-pull shape: auth chain, 12x content, tool client, single environment', () => {
  const events: RawEvent[] = [
    event('TOKEN_CREATE', at(0.010), { viewer_id: null, credential_viewer_id: null, identity_basis: 'CREDENTIAL_ONLY', user_agent: 'customer-backend/1.0', request_url: '' }),
    event('MANIFEST_REQUEST', at(0.100), { http_status: 200, request_url: '/hls/sim_course_01/playlist.m3u8', user_agent: 'ffmpeg/7.0' }),
    event('HLS_KEY_VALIDATE', at(0.200), { http_status: 200, request_url: '/hls/sim_course_01/key', user_agent: 'ffmpeg/7.0' }),
    event('KEY_RESPONSE', at(0.300), { http_status: 200, key_valid_until: '2026-10-23 14:00:00.000', request_url: '/hls/sim_course_01/key', user_agent: 'ffmpeg/7.0' }),
  ];
  for (let index = 0; index < 720; index++) {
    events.push(event('TS_VALIDATE', at(1 + index * 0.1), { request_url: `/hls/sim_course_01/${index}.ts`, user_agent: 'ffmpeg/7.0' }));
    events.push(event('CDN_MEDIA_ACCESS', at(1.01 + index * 0.1), { request_url: `/hls/sim_course_01/${index}.ts`, user_agent: 'ffmpeg/7.0', http_status: 206, response_bytes: 250000, response_completed: 1 }));
  }
  const timeline = buildTimeline(input(), { events, media: segmentMedia(), snapshots: [snapshot()], coverage: [] });
  assert.equal(timeline.subject.kind, 'VIEWER');
  assert.equal(timeline.subject.id, 'viewer-a');
  assert.equal(timeline.content.dedupSeconds, 7200);
  assert.equal(timeline.content.speedRatio, 12);
  assert.equal(timeline.content.coverageRatio, 1);
  assert.equal(timeline.content.strictlyIncreasing, true);
  assert.equal(timeline.content.medianGapMs, 100);
  assert.equal(timeline.content.gapCv, 0);
  assert.equal(timeline.content.courses.length, 1);
  assert.equal(timeline.content.courses[0].totalSegments, 720);
  assert.deepEqual(timeline.auth.events.map(item => item.kind), ['TOKEN_CREATE', 'MANIFEST_REQUEST', 'HLS_KEY_VALIDATE', 'KEY_RESPONSE']);
  assert.equal(timeline.auth.tokens[0].expiresAt, Date.parse('2026-10-23T15:00:00+08:00'));
  assert.equal(timeline.env.environments.length, 1);
  assert.equal(timeline.env.toolUa, 'ffmpeg/7.0');
  assert.ok(timeline.sidebar.observed.some(text => text.includes('0.3') && text.includes('token')));
  assert.ok(timeline.sidebar.risk.some(text => text.includes('批量内容获取')));
  assert.ok(timeline.sidebar.unknown.some(text => text.includes('业务前提待核实')));
  assert.match(timeline.content.basis, /CDN 完整响应/);
});

test('buildTimeline separates alternating environments and reports switch counts', () => {
  const events: RawEvent[] = [event('TOKEN_CREATE', at(0.010), { viewer_id: null, credential_viewer_id: null, identity_basis: 'CREDENTIAL_ONLY', user_agent: 'customer-backend/1.0', request_url: '' })];
  for (let index = 0; index < 40; index++) {
    const android = index % 2 === 0;
    events.push(event('TS_VALIDATE', at(1 + index * 5), {
      request_url: `/hls/sim_course_01/${index}.ts`,
      request_ip: android ? '198.51.100.1' : '198.51.100.2',
      ip_basis: 'TRUSTED_REQUEST',
      user_agent: android ? 'Mozilla/5.0 (Linux; Android 10) Chrome/120' : 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0) Safari/604.1',
    }));
  }
  const timeline = buildTimeline(input({ ruleId: 'R4B', ruleName: '多环境凭证使用', subjectType: 'TOKEN', subjectId: 'tok-1', contextId: JSON.stringify(['tok-1', 'SIMULATOR']) }), { events, media: segmentMedia(), snapshots: [snapshot()], coverage: [] });
  assert.equal(timeline.subject.kind, 'TOKEN');
  assert.equal(timeline.env.environments.length, 2);
  assert.ok(timeline.env.switches >= 3);
  assert.ok(timeline.env.environments.some(item => item.label.includes('198.51.100.1') && item.label.includes('安卓') && item.label.includes('Chrome')));
  assert.ok(timeline.env.environments.some(item => item.label.includes('198.51.100.2') && item.label.includes('iPhone') && item.label.includes('Safari')));
  assert.ok(timeline.sidebar.risk.some(text => text.includes('共享')));
});

test('replay sidebars reflect the frozen positive, zero and unavailable suspicion scores',()=>{
  const evidence={events:[],media:[],snapshots:[],coverage:[]};
  for(const ruleId of ['R1','R2','R4B']) {
    const timeline=buildTimeline(input({ruleId,scoring:{anomalyScore:50,suspicionScore:50,reason:'',businessPolicyVersion:'frozen-policy-v2'}}),evidence);
    assert.ok(timeline.sidebar.observed.some(t=>t.includes('S=50')&&t.includes('frozen-policy-v2')));
    assert.equal(timeline.sidebar.unknown.some(t=>/业务前提待核实|嫌疑分暂不计算/.test(t)),false);
    assert.ok(timeline.sidebar.unknown.some(t=>/不能证明|不能断言|不构成/.test(t)));
  }
  const zero=buildTimeline(input({scoring:{anomalyScore:50,suspicionScore:0,reason:''}}),evidence);
  assert.ok(zero.sidebar.observed.some(t=>t.includes('S=0')));
  assert.equal(zero.sidebar.unknown.some(t=>t.includes('业务前提待核实')),false);
  const unknown=buildTimeline(input(),evidence);
  assert.ok(unknown.sidebar.unknown.some(t=>t.includes('告警生成时')&&t.includes('业务前提待核实')));
  const legacy=buildTimeline(input({scoring:{anomalyScore:50,suspicionScore:50,reason:''}}),evidence);
  assert.ok(legacy.sidebar.unknown.some(t=>t.includes('未保存业务策略版本')));
});

test('buildTimeline keeps only the alert subject and marks unmapped or failed requests', () => {
  const events: RawEvent[] = [
    event('TS_VALIDATE', at(5), { viewer_id: 'viewer-b', credential_viewer_id: 'viewer-b', request_url: '/hls/sim_course_01/0.ts' }),
    event('TS_VALIDATE', at(6), { viewer_id: 'viewer-c', credential_viewer_id: 'viewer-c', request_url: '/hls/sim_course_01/1.ts', auth_result: 0 }),
    event('TS_VALIDATE', at(8), { request_url: '/hls/sim_course_01/3.ts' }),
    event('TS_VALIDATE', at(9), { request_url: '/hls/unknown-path/4.ts' }),
  ];
  const timeline = buildTimeline(input(), { events, media: segmentMedia(), snapshots: [], coverage: [] });
  assert.equal(timeline.subject.id, 'viewer-a');
  assert.equal(timeline.content.requests, 2);
  assert.equal(timeline.content.courses[0].points.length, 2);
  assert.equal(timeline.content.courses[0].failedPoints.length, 0);
  assert.equal(timeline.content.dedupSeconds, 10);
  assert.ok(timeline.limitations.some(text => text.includes('缺少可映射的媒体分片')));
});

test('buildTimeline tolerates empty windows without inventing records', () => {
  const timeline = buildTimeline(input(), { events: [], media: [], snapshots: [], coverage: [] });
  assert.equal(timeline.content.requests, 0);
  assert.equal(timeline.content.courses.length, 0);
  assert.equal(timeline.content.speedRatio, null);
  assert.equal(timeline.content.strictlyIncreasing, null);
  assert.equal(timeline.env.environments.length, 0);
  assert.equal(timeline.auth.events.length, 0);
  assert.ok(timeline.sidebar.observed.length === 0 || timeline.sidebar.observed.every(text => !/\d+ 次内容请求/.test(text)));
});

test('timeline endpoint serves replay data for demo alerts end to end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traceguard-timeline-'));
  const app = createApp(cfg(join(dir, 'test.sqlite')));
  const url = await listen(app.server);
  try {
    // A fresh store ships every rule except R7 disabled; enable R2 the way the UI does.
    const rules = (await get(url, '/api/rules')).data as Array<{ id: string; configuration: { revision: number; enabled: boolean } }>;
    const r2 = rules.find(rule => rule.id === 'R2')!;
    const enable = await fetch(url + '/api/rules/R2/configurations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configuration: { ...r2.configuration, enabled: true }, expectedRevision: r2.configuration.revision, requestId: 'enable-r2-timeline', note: '测试启用' }),
    });
    assert.equal(enable.status, 200);
    const detection = await fetch(url + '/api/detections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: 'rapid_pull', windowStart: '2026-10-23T12:00' }) });
    assert.equal(detection.status, 200);
    const alerts = (await get(url, '/api/alerts')).data.items as Array<{ id: string; ruleId: string }>;
    const rapid = alerts.find(alert => alert.ruleId === 'R2');
    assert.ok(rapid, 'rapid_pull should raise an R2 alert');
    const timeline = await get(url, `/api/alerts/${rapid.id}/timeline`);
    assert.equal(timeline.status, 200);
    assert.equal(timeline.data.subject.id, 'demo-viewer');
    assert.equal(timeline.data.content.dedupSeconds, 7200);
    assert.equal(timeline.data.content.speedRatio, 12);
    assert.equal(timeline.data.content.medianGapMs, 100);
    assert.equal(timeline.data.content.strictlyIncreasing, true);
    assert.equal(timeline.data.env.environments.length, 1);
    assert.equal(timeline.data.auth.tokens.length, 1);
    assert.ok(timeline.data.sidebar.unknown.some((t:string)=>t.includes('告警生成时')&&t.includes('业务前提待核实')));
    assert.equal((await get(url, '/api/alerts/TG-000000000000/timeline')).status, 404);
  } finally {
    await close(app.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('timeline endpoint preserves alert scoring when current tenant policy changes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'traceguard-replay-policy-')),config=cfg(join(dir,'test.sqlite'));config.tenantId='980107c0ab';
  const app=createApp(config),url=await listen(app.server);
  try {
    const r2=app.store.configuration('R2');app.store.publish('R2',{configuration:{...r2,enabled:true},expectedRevision:r2.revision,requestId:'replay-policy-enable',note:'测试'});
    const detection=await fetch(url+'/api/detections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario:'rapid_pull',windowStart:'2026-10-23T12:00'})});assert.equal(detection.status,200);
    const alert=app.store.alerts().find(a=>a.ruleId==='R2')!;assert.equal(alert.suspicionScore,50);assert.equal(alert.feature.businessPolicyVersion,'BP-980107c0ab-v2');
    const latest={...app.store.businessPolicy(config.tenantId)!,version:'later-permissive-policy',downloadAllowed:true,prefetchAllowed:true};
    app.store.db.prepare('UPDATE business_policies SET data=? WHERE tenant_id=?').run(JSON.stringify(latest),config.tenantId);
    const timeline=await get(url,`/api/alerts/${alert.id}/timeline`);assert.equal(timeline.status,200);
    assert.ok(timeline.data.sidebar.observed.some((t:string)=>t.includes('S=50')&&t.includes('BP-980107c0ab-v2')&&t.includes('禁止下载/预取')));
    assert.equal(timeline.data.sidebar.unknown.some((t:string)=>/业务前提待核实|嫌疑分暂不计算/.test(t)),false);
    assert.equal(JSON.stringify(timeline.data.sidebar).includes('later-permissive-policy'),false);
    assert.deepEqual(app.store.getAlert(alert.id),alert);
  }finally{await close(app.server);rmSync(dir,{recursive:true,force:true});}
});
