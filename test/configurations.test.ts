import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import type { Config } from '../server/config.ts';
import type { RuleConfiguration } from '../server/types.ts';

test('published configurations drive detections, history and rollback without changing old alert evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'traceguard-config-'));
  const cfg: Config = { host: '127.0.0.1', port: 0, mode: 'demo', tenantId: 'test', runId: 'test', sqlitePath: join(directory, 'state.sqlite'), clickhouse: { url: '', database: 'da', user: '', password: '' } };
  let app = createApp(cfg);
  const listen = async () => { app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); const a = app.server.address(); assert.ok(a && typeof a !== 'string'); return `http://127.0.0.1:${a.port}`; };
  const close = async () => { const done = once(app.server, 'close'); app.server.close(); app.server.closeAllConnections(); await done; };
  let url = await listen();
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(url + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() } as { status: number; data: any; error?: { code: string } };
  };
  let serial = 0;
  const publish = async (configuration: RuleConfiguration, expectedRevision = configuration.revision) => request(`/api/rules/${configuration.id}/configurations`, { configuration, expectedRevision, requestId: `config-request-${++serial}`, note: '配置端到端验收' });
  try {
    const catalog = (await request('/api/rules')).data;
    assert.deepEqual(catalog.filter((r: any) => r.supported).map((r: any) => r.id), ['R1', 'R2', 'R3', 'R4A', 'R4B', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10']);
    assert.equal((await request('/api/rules/R99/configurations', {})).status, 404);
    assert.equal((await request('/api/rules/R7/validate', null)).status, 400);
    const input = { scenario: 'failure_burst', windowStart: '2026-10-23T14:00' };
    await request('/api/detections', input);
    const original = (await request('/api/alerts')).data.items[0];
    const c7: RuleConfiguration = catalog.find((r: any) => r.id === 'R7').configuration;
    c7.tiers[1].score = 35;
    const body = { configuration: c7, expectedRevision: 1, requestId: 'idempotent-config-request', note: '注意档分值改为 35' };
    const changed = await request('/api/rules/R7/configurations', body);
    assert.equal(changed.data.revision, 2);
    assert.equal((await request('/api/rules/R7/configurations', body)).data.revision, 2);
    assert.equal((await publish(c7, 1)).status, 409);
    const again = await request('/api/detections', input);
    assert.equal(again.data.reused, false); assert.equal(again.data.run.features[0].anomalyScore, 35);
    assert.equal(again.data.run.features[0].configuration.revision, 2);
    assert.equal((await request('/api/detections', input)).data.reused, true);
    const frozen = (await request(`/api/alerts/${original.id}`)).data;
    assert.equal(frozen.anomalyScore, 25); assert.equal(frozen.feature.configuration.revision, 1);
    assert.equal((await request('/api/rules/R7/history')).data.length, 2);
    const restored = await request('/api/rules/R7/rollback', { targetRevision: 1, expectedRevision: 2, requestId: 'rollback-config-001' });
    assert.equal(restored.data.revision, 3); assert.equal(restored.data.tiers[1].score, 25);
    const disabled = { ...restored.data, enabled: false };
    assert.equal((await publish(disabled)).status, 200);
    assert.equal((await request('/api/detections', input)).error?.code, 'NO_ENABLED_RULES');
    for (const id of ['R2', 'R6', 'R9', 'R10']) {
      const current = (await request('/api/rules')).data.find((r: any) => r.id === id).configuration;
      assert.equal((await publish({ ...current, enabled: true })).status, 200);
    }
    const fast = (await request('/api/detections', { scenario: 'rapid_pull', windowStart: '2026-10-23T12:00' })).data.run;
    assert.deepEqual(fast.features.filter((f: any) => f.anomalyScore > 0).map((f: any) => [f.ruleId, f.anomalyScore]), [['R2', 50], ['R6', 15]]);
    assert.equal(fast.alertCount, 2);
    const night = (await request('/api/detections', { scenario: 'sustained_access', windowStart: '2026-10-23T02:00' })).data.run;
    assert.equal(night.features.find((f: any) => f.ruleId === 'R9').labelHit, true); assert.equal(night.alertCount, 0);
    const tools = (await request('/api/detections', { scenario: 'client_tool', windowStart: '2026-10-23T18:00' })).data.run;
    assert.equal(tools.features.find((f: any) => f.ruleId === 'R10').anomalyScore, 5);
    const sample = await request('/api/rules/R2/simulate', { configuration: { ...catalog.find((r: any) => r.id === 'R2').configuration, enabled: true }, metrics: { contentSeconds: 7200, speedRatio: 12 } });
    assert.equal(sample.data.anomalyScore, 50); assert.equal(sample.data.mode, 'SAMPLE_ONLY');
    for (const id of ['R1', 'R3', 'R4A', 'R4B', 'R5', 'R8']) {
      const current = (await request('/api/rules')).data.find((r: any) => r.id === id).configuration;
      assert.equal((await publish({ ...current, enabled: true })).status, 200);
    }
    const scope = (await request('/api/detections', { scenario: 'scope_violation', windowStart: '2026-10-23T15:00' })).data.run;
    const scopeFeature = scope.features.find((f: any) => f.ruleId === 'R4A');
    assert.equal(scopeFeature.anomalyScore, 50); assert.equal(scopeFeature.subjectType, 'TOKEN');
    assert.equal(scopeFeature.windowStart, '2026-10-23 14:40:00.000');
    const tokenAlert = (await request('/api/alerts?q=demo-token')).data.items.find((a: any) => a.ruleId === 'R4A');
    assert.equal(tokenAlert.videoId, ''); assert.equal(tokenAlert.windowStart, scopeFeature.windowStart);
    assert.deepEqual(tokenAlert.feature.relatedVideoIds, ['demo-video-outside']);
    const shared = (await request('/api/detections', { scenario: 'token_shared', windowStart: '2026-10-23T13:00' })).data.run;
    assert.equal(shared.features.find((f: any) => f.ruleId === 'R4B').anomalyScore, 50);
    assert.equal(shared.features.find((f: any) => f.ruleId === 'R4B').suspicionScore, null);
    const c4b = (await request('/api/rules')).data.find((r: any) => r.id === 'R4B').configuration;
    c4b.parameters.highPasses = 100;
    await publish(c4b);
    const weaker = (await request('/api/detections', { scenario: 'token_shared', windowStart: '2026-10-23T13:00' })).data.run;
    assert.equal(weaker.features.find((f: any) => f.ruleId === 'R4B').anomalyScore, 25);
    const beforeRestart = (await request('/api/alerts')).data.total;
    await close(); app = createApp(cfg); url = await listen();
    assert.equal((await request('/api/alerts')).data.total, beforeRestart);
    assert.equal((await request('/api/rules')).data.find((r: any) => r.id === 'R7').configuration.revision, 4);
    assert.equal((await request(`/api/alerts/${original.id}`)).data.anomalyScore, 25);
  } finally { await close(); rmSync(directory, { recursive: true, force: true }); }
});
