import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import type { Config } from '../server/config.ts';
import type { Alert, DetectionRun } from '../server/types.ts';

function config(path = ':memory:'): Config {
  return { host: '127.0.0.1', port: 0, mode: 'demo', tenantId: 'test-tenant', runId: 'test-run',
    sqlitePath: path, clickhouse: { url: '', database: 'da', user: 'test', password: 'test-only-password' } };
}
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  const done = once(server, 'close'); server.close(); server.closeAllConnections(); await done;
}
async function request(url: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(url + path, body === undefined ? { headers: extraHeaders } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body),
  });
  return { status: response.status, ...await response.json() } as { status: number; data: any; error?: { code: string } };
}
const input = { scenario: 'failure_burst', windowStart: '2026-10-23T14:00' };

test('detect → immutable evidence → review → retry → restart is persisted and idempotent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'traceguard-test-'));
  const cfg = config(join(directory, 'test.sqlite'));
  const first = createApp(cfg); const url = await listen(first.server);
  let second: ReturnType<typeof createApp> | undefined;
  try {
    const home = await fetch(url + '/');
    assert.equal(home.status, 200); assert.match(await home.text(), /TraceGuard/);
    assert.match(home.headers.get('content-security-policy')!, /default-src 'self'/);
    const detection = await request(url, '/api/detections', input);
    assert.equal(detection.status, 200);
    assert.equal(detection.data.run.alertCount, 1);
    assert.equal(detection.data.run.features[0].failureRatio, 0.75);
    const list = await request(url, '/api/alerts');
    const alert = list.data.items[0] as Alert;
    assert.equal(list.data.total, 1); assert.equal(alert.anomalyScore, 25); assert.equal(alert.suspicionScore, 0);
    const originalEvidence = JSON.stringify(alert.feature);
    const reviewBody = { status: '已误报', note: '已核对配置变更，属于测试签名失败。', expectedVersion: 1, requestId: 'review-request-001' };
    assert.equal((await request(url, `/api/alerts/${alert.id}/reviews`, { ...reviewBody, note: ' ' })).status, 400);
    const reviewed = await request(url, `/api/alerts/${alert.id}/reviews`, reviewBody);
    assert.equal(reviewed.data.version, 2); assert.equal(reviewed.data.reviews.length, 1);
    assert.equal(JSON.stringify(reviewed.data.feature), originalEvidence);
    const replayed = await request(url, `/api/alerts/${alert.id}/reviews`, reviewBody);
    assert.equal(replayed.data.reviews.length, 1); assert.equal(replayed.data.version, 2);
    assert.equal((await request(url, `/api/alerts/${alert.id}/reviews`, { ...reviewBody, note: 'different' })).status, 409);
    assert.equal((await request(url, `/api/alerts/${alert.id}/reviews`, { ...reviewBody, requestId: 'review-request-002' })).status, 409);
    assert.equal((await request(url, '/api/detections', input)).data.reused, true);
    assert.equal((await request(url, '/api/alerts')).data.total, 1);
    assert.equal((await request(url, '/api/overview')).data.pending, 0);
    assert.equal((await request(url, '/api/alerts?status=' + encodeURIComponent('已误报'))).data.total, 1);
    await close(first.server);
    second = createApp(cfg); const secondUrl = await listen(second.server);
    const restored = await request(secondUrl, `/api/alerts/${alert.id}`);
    assert.equal(restored.data.status, '已误报'); assert.equal(restored.data.reviews.length, 1);
    assert.equal(restored.data.anomalyScore, 25); assert.equal(restored.data.suspicionScore, 0);
    assert.equal(JSON.stringify(restored.data.feature), originalEvidence);
  } finally {
    if (first.server.listening) await close(first.server);
    if (second?.server.listening) await close(second.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unknown results, no observations and no match remain different and create no alerts', async () => {
  const app = createApp(config()); const url = await listen(app.server);
  try {
    const unknown = await request(url, '/api/detections', { scenario: 'unknown_inputs', windowStart: '2026-10-23T17:00' });
    assert.equal(unknown.data.run.features[0].unknown, 10);
    assert.equal(unknown.data.run.features[0].anomalyScore, null);
    const empty = await request(url, '/api/detections', { scenario: 'failure_burst', windowStart: '2026-10-23T01:00' });
    assert.equal(empty.data.run.features.length, 0);
    const normal = await request(url, '/api/detections', { scenario: 'normal', windowStart: '2026-10-23T14:00' });
    assert.equal(normal.data.run.features[0].anomalyScore, 0);
    assert.equal(normal.data.run.features[0].computeStatus, 'AVAILABLE');
    assert.equal((await request(url, '/api/alerts')).data.total, 0);
  } finally { await close(app.server); }
});

test('automatic validation checks use the same persisted detection path as manual runs', async () => {
  const app = createApp(config()); const url = await listen(app.server);
  try {
    await app.scheduler.tick();
    const schedule = await request(url, '/api/scheduler');
    assert.equal(schedule.data.checked, 1);
    assert.equal(schedule.data.last.scenario, 'rapid_pull');
    const overview = await request(url, '/api/overview');
    assert.equal(overview.data.runs.length, 1);
    assert.equal(overview.data.runs[0].dataBatchId, 'test-run');
    const manual = await request(url, '/api/detections', { scenario: 'rapid_pull', windowStart: '2026-10-23T12:00' });
    assert.equal(manual.data.reused, true);
    assert.equal((await request(url, '/api/overview')).data.runs.length, 1);
  } finally { await close(app.server); }
});

test('untrusted origins and invalid input are rejected before mutation', async () => {
  const app = createApp(config()); const url = await listen(app.server);
  try {
    assert.equal((await request(url, '/api/detections', input, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await request(url, '/api/detections', { ...input, scenario: "' OR 1=1" })).status, 400);
    assert.equal((await request(url, '/api/alerts?status=invalid')).status, 400);
    assert.equal((await request(url, '/api/overview')).data.runs.length, 0);
  } finally { await close(app.server); }
});

test('ClickHouse input is parameterized and read-only; failure records do not fall back to demo', async () => {
  let fail = false; let calls = 0;
  const upstream = createServer((req, res) => {
    calls++;
    const url = new URL(req.url!, 'http://localhost');
    assert.equal(url.searchParams.get('readonly'), '1');
    assert.equal(url.searchParams.get('max_threads'), '1');
    assert.equal(url.searchParams.get('param_tenant_id'), 'test-tenant');
    assert.equal(url.searchParams.get('param_scenario_id'), 'failure_burst');
    assert.equal(url.searchParams.get('param_window_start'), calls === 1 ? '2026-10-23 14:00:00.000' : '2026-10-22 14:00:00.000');
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('test:test-only-password').toString('base64'));
    if (fail) { res.writeHead(500); res.end('SECRET_UPSTREAM_DETAIL'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ video_id: 'real-test-video', scenario_id: 'failure_burst', source: 'SIMULATOR', event_type: 'TS_VALIDATE',
      dataset_kinds: ['SYNTHETIC'], observed: 200, passed: 50, failed: 150, unknown: 0, known: 200, failure_ratio: 0.75, anomaly_score: 25 }] }));
  });
  const upstreamUrl = await listen(upstream);
  const cfg = config(); cfg.mode = 'clickhouse'; cfg.clickhouse.url = upstreamUrl;
  const app = createApp(cfg); const url = await listen(app.server);
  try {
    const detected = await request(url, '/api/detections', input);
    assert.equal(detected.data.run.sourceMode, 'clickhouse');
    assert.equal(detected.data.run.features[0].videoId, 'real-test-video');
    assert.equal((await request(url, '/api/detections', input)).data.reused, true); assert.equal(calls, 1);
    fail = true;
    const failed = await request(url, '/api/detections', { ...input, windowStart: '2026-10-22T14:00' });
    assert.equal(failed.status, 502); assert.equal(failed.error?.code, 'CLICKHOUSE_QUERY_FAILED');
    assert.ok(!JSON.stringify(failed).includes('SECRET_UPSTREAM_DETAIL'));
    const overview = await request(url, '/api/overview');
    assert.equal(overview.data.alerts, 1);
    assert.ok(overview.data.runs.some((r: DetectionRun) => r.status === 'FAILED'));
    fail = false;
    assert.equal((await request(url, '/api/detections', { ...input, windowStart: '2026-10-22T14:00' })).status, 200);
    assert.equal((await request(url, '/api/alerts')).data.total, 2);
  } finally { await close(app.server); await close(upstream); }
});
