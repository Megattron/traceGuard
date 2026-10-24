import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Config } from './config.ts';
import { AppError, type Alert, type DetectionInput, type Feature, type RuleConfiguration } from './types.ts';
import { evaluateR7, validateFeature } from './rule.ts';
import { applyConfiguration, definition } from './rules.ts';
import { demoEvidence, deriveFeatures, type RawEvent, type Media, type Coverage } from './features.ts';
import { at } from './features.ts';
import { deriveAdvanced, deriveSustained, sourceCovered, type Snapshot } from './advanced-features.ts';
import { ruleWindow, stamp, withinBatch } from './windows.ts';
import { buildTimeline, type ReplayInput, type ReplayTimeline } from './timeline.ts';

const FILES = ['R7_video_failures', 'access_events', 'media_segments', 'source_coverage', 'token_snapshots', 'authorization_history', 'playback_states', 'R8_sustained'] as const;
const QUERIES = Object.fromEntries(FILES.map(name => [name, readFileSync(new URL(`../sql/runtime/${name}.sql`, import.meta.url), 'utf8')]));
// Include the extraction/evaluation implementation, not only SQL, in cache identity.
export const SQL_HASH = createHash('sha256').update(FILES.map(name => QUERIES[name]).join('\n'))
  .update(['features.ts', 'advanced-features.ts', 'windows.ts', 'source.ts', 'rules.ts', 'rule.ts', 'business-policy.ts'].map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n')).digest('hex');

export class FeatureSource {
  config: Config;
  constructor(config: Config) { this.config = config; }
  async extract(input: DetectionInput, configurations: RuleConfiguration[] = [definition('R7').defaults!]): Promise<Feature[]> {
    const result: Feature[] = [];
    const selected = configurations.filter(c => c.enabled).filter(c => {
      const window = ruleWindow(input, c.id);
      if (withinBatch(window)) return true;
      result.push({ ruleId: c.id, ruleName: definition(c.id).name, configuration: structuredClone(c), videoId: '', scenario: input.scenario, source: this.config.mode === 'demo' ? 'LOCAL_DEMO' : 'SIMULATOR', eventType: 'NOT_EVALUATED', datasetKinds: [], observed: 0, passed: 0, failed: 0, unknown: 0, known: 0, failureRatio: null,
        anomalyScore: null, suspicionScore: null, computeStatus: 'UNAVAILABLE', reason: 'WINDOW_OUTSIDE_BATCH', windowStart: window.windowStart, windowEnd: window.windowEnd });
      return false;
    });
    const r7 = selected.find(c => c.id === 'R7');
    const other = selected.filter(c => c.id !== 'R7');
    if (this.config.mode === 'demo') {
      const evidence = demoEvidence(input);
      if (r7 && evidence.events.length) {
        const passed = evidence.events.filter(e => e.auth_result === 1).length;
        const failed = evidence.events.filter(e => e.auth_result === 0).length;
        const unknown = evidence.events.length - passed - failed;
        result.push(applyConfiguration({ videoId: 'demo-video-001', scenario: input.scenario, source: 'LOCAL_DEMO', eventType: 'TS_VALIDATE', datasetKinds: ['LOCAL_DEMO'],
          observed: evidence.events.length, passed, failed, unknown, ...evaluateR7(passed, failed, unknown) }, r7));
      }
      for (const config of other) {
        const window = ruleWindow(input, config.id);
        const days = new Set([window.windowStart.slice(0, 10), window.windowEnd.slice(0, 10)]);
        const all = [...days].filter(day => day < '2026-10-24').map(day => demoEvidence({ ...window, windowStart: day + ' 00:00:00.000', windowEnd: stamp(at(day + ' 00:00:00.000') + 86400000) }));
        const events = all.flatMap(e => e.events), media = [...new Map(all.flatMap(e => e.media).map(m => [m.object_path, m])).values()];
        const coverage = all[0]?.coverage || [];
        const snapshots: Snapshot[] = [...new Set(events.map(e => e.token_ref))].map(token => ({ token_ref: token, effective_at: '2026-10-16 00:00:00.000', expires_at: '2026-10-24 00:00:00.000', revoked: 0,
          allowed_video_ids: ['demo-video-001'], original_issued_at: '2026-10-16 00:00:00.000', policy_version: 'LOCAL_DEMO' }));
        if (['R1', 'R3', 'R4A', 'R4B', 'R5'].includes(config.id)) result.push(...deriveAdvanced(events, media, coverage, snapshots, window, config, events));
        else if (config.id === 'R8') result.push(...deriveSustained(events, media, coverage, window, config));
        else result.push(...deriveFeatures(events.filter(e => e.event_time_ms >= at(window.windowStart) && e.event_time_ms < at(window.windowEnd)), media, coverage, window, [config]));
      }
      return result.map(f => ({ ...f, windowStart: f.windowStart || input.windowStart, windowEnd: f.windowEnd || input.windowEnd }));
    }
    if (r7) result.push(...(await this.query('R7_video_failures', input)).map(row => applyConfiguration(validateFeature(row), r7)));
    if (other.length) {
      const rawRules = other.filter(c => c.id !== 'R8');
      const rawWindow = { ...input, windowStart: rawRules.length ? stamp(Math.min(...rawRules.map(c => at(ruleWindow(input, c.id).windowStart)))) : input.windowStart };
      const rows = rawRules.length ? await this.query('access_events', rawWindow, 25000) : [];
      for (const row of rows) {
        if (typeof row.event_id !== 'string' || typeof row.video_id !== 'string' || !Number.isSafeInteger(row.event_time_ms)
          || !Number.isInteger(row.auth_result) || typeof row.event_type !== 'string') throw new AppError(502, 'INVALID_FEATURE', '事件输入格式无效');
      }
      let media: Media[] = [];
      const coverage = await this.query('source_coverage', input) as unknown as Coverage[];
      if (rows.length && other.some(c => ['R1', 'R2', 'R6'].includes(c.id))) {
        const videos = [...new Set(rows.filter(e => e.event_type === 'TS_VALIDATE' && Number(e.event_time_ms) >= at(input.windowStart)).map(e => e.video_id).filter(Boolean))];
        media = await this.query('media_segments', input, 25000, { param_video_ids_json: JSON.stringify(videos) }) as unknown as Media[];
      }
      const snapshots = rows.length && other.some(c => ['R1', 'R4A', 'R4B'].includes(c.id)) ? await this.query('token_snapshots', input, 25000) as unknown as Snapshot[] : [];
      const tokens = [...new Set(rows.filter(e => e.event_type === 'TS_VALIDATE' && Number(e.event_time_ms) >= at(input.windowStart)).map(e => e.token_ref).filter(Boolean))];
      const history = rows.length && other.some(c => c.id === 'R1') ? await this.query('authorization_history', input, 25000, { param_token_refs_json: JSON.stringify(tokens) }) as unknown as RawEvent[] : [];
      for (const c of other) {
        const window = ruleWindow(input, c.id);
        if (c.id === 'R8') {
          const aggregate = await this.query('R8_sustained', window, 1000);
          for (const row of aggregate) {
            if (typeof row.subject_id !== 'string' || !Number.isSafeInteger(row.observed) || !Number.isSafeInteger(row.active_minutes) || Number(row.active_minutes) > 1440 || !Number.isFinite(row.content_seconds) || Number(row.content_seconds) < 0) throw new AppError(502, 'INVALID_FEATURE', '全天聚合输入无效');
            const reason = row.identity_verified !== 1 ? 'IDENTITY_UNVERIFIED' : Number(row.mapped_unknown) > 0 ? 'MISSING_OR_AMBIGUOUS_MEDIA' : Number(row.quality_invalid) > 0 || !sourceCovered(coverage, 'TS_VALIDATE', at(window.windowStart), at(window.windowEnd)) ? 'INCOMPLETE_OR_UNVERIFIED_SOURCE' : '';
            result.push(applyConfiguration({ videoId: '', subjectType: row.identity_verified === 1 ? 'VIEWER' : 'CREDENTIAL_VIEWER', subjectId: String(row.subject_id), actorId: row.identity_verified === 1 ? String(row.subject_id) : '', relatedVideoIds: row.video_ids as string[], contextId: JSON.stringify([row.identity_verified, row.subject_id, row.source]),
              ...window, source: String(row.source), eventType: 'TS_VALIDATE', datasetKinds: ['SYNTHETIC'], observed: Number(row.observed), passed: Number(row.observed), failed: 0, unknown: 0, known: Number(row.observed), failureRatio: 0,
              anomalyScore: 0, suspicionScore: 0, computeStatus: reason ? 'UNAVAILABLE' : 'AVAILABLE', reason, metrics: { activeMinutes: Number(row.active_minutes), contentSeconds: Number(row.content_seconds) } }, c));
          }
        } else if (['R1', 'R3', 'R4A', 'R4B', 'R5'].includes(c.id)) {
          const states = c.id === 'R3' ? await this.query('playback_states', window, 25000) as unknown as RawEvent[] : history;
          result.push(...deriveAdvanced(rows as unknown as RawEvent[], media, coverage, snapshots, window, c, states));
        } else result.push(...deriveFeatures(rows.filter(e => Number(e.event_time_ms) >= at(window.windowStart)) as unknown as RawEvent[], media, coverage, window, [c]));
      }
    }
    return result.map(f => ({ ...f, windowStart: f.windowStart || input.windowStart, windowEnd: f.windowEnd || input.windowEnd }));
  }
  // Event replay for one alert: re-reads the immutable validation batch for the alert window and
  // builds the three shared-cursor tracks. Deterministic view-time derivation, same filters as extract().
  async replay(alert: Alert): Promise<ReplayTimeline> {
    const input: DetectionInput = { scenario: alert.scenario as DetectionInput['scenario'], windowStart: alert.windowStart, windowEnd: alert.windowEnd };
    const info: ReplayInput = {
      ruleId: alert.ruleId || 'R7', ruleName: alert.ruleName || '视频鉴权失败异常', scenario: alert.scenario,
      windowStart: alert.windowStart, windowEnd: alert.windowEnd, videoId: alert.videoId, tier: alert.feature.tier || null,
      subjectType: alert.feature.subjectType, subjectId: alert.feature.subjectId, contextId: alert.feature.contextId, metrics: alert.feature.metrics,
      scoring:{anomalyScore:alert.anomalyScore,suspicionScore:alert.suspicionScore,reason:alert.feature.reason,businessPolicyVersion:alert.feature.businessPolicyVersion},
    };
    if (this.config.mode === 'demo') {
      const evidence = demoEvidence(input);
      const snapshots: Snapshot[] = [...new Set(evidence.events.map(event => event.token_ref))].map(token => ({
        token_ref: token, effective_at: '2026-10-16 00:00:00.000', expires_at: '2026-10-24 00:00:00.000', revoked: 0,
        allowed_video_ids: ['demo-video-001'], original_issued_at: '2026-10-16 00:00:00.000', policy_version: 'LOCAL_DEMO',
      }));
      return buildTimeline(info, { events: evidence.events, media: evidence.media, snapshots, coverage: evidence.coverage });
    }
    const rows = await this.query('access_events', input, 25000) as unknown as RawEvent[];
    const videos = [...new Set(rows.map(event => event.video_id).filter(Boolean))].slice(0, 100);
    const media = videos.length ? await this.query('media_segments', input, 25000, { param_video_ids_json: JSON.stringify(videos) }) as unknown as Media[] : [];
    const tokens = [...new Set(rows.filter(event => event.event_type === 'TS_VALIDATE').map(event => event.token_ref).filter(Boolean))];
    const snapshots = tokens.length ? await this.query('token_snapshots', input, 5000) as unknown as Snapshot[] : [];
    const history = tokens.length ? await this.query('authorization_history', input, 25000, { param_token_refs_json: JSON.stringify(tokens) }) as unknown as RawEvent[] : [];
    const coverage = await this.query('source_coverage', input, 1000) as unknown as Coverage[];
    return buildTimeline(info, { events: [...rows, ...history], media, snapshots, coverage });
  }
  private async query(name: typeof FILES[number], input: DetectionInput, maxRows = 1000, extra: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
    const started = performance.now();
    const url = new URL(this.config.clickhouse.url);
    const params: Record<string, string> = {
      database: this.config.clickhouse.database, readonly: '1', max_execution_time: '12', max_threads: '1',
      max_memory_usage: '268435456', max_result_rows: String(maxRows), max_result_bytes: '16777216', result_overflow_mode: 'throw',
      output_format_json_quote_64bit_integers: '0', param_database: this.config.clickhouse.database,
      param_run_id: this.config.runId, param_tenant_id: this.config.tenantId, param_scenario_id: input.scenario,
      param_window_start: input.windowStart, param_window_end: input.windowEnd,
      ...extra,
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const auth = Buffer.from(`${this.config.clickhouse.user}:${this.config.clickhouse.password}`).toString('base64');
    try {
      const response = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'text/plain; charset=utf-8' },
        body: QUERIES[name] + '\nFORMAT JSON', signal: AbortSignal.timeout(18000), redirect: 'error' });
      if (!response.ok) {
        const diagnostic = await response.text(); const code = diagnostic.match(/^Code:\s*(\d+)/)?.[1];
        console.error(`ClickHouse query failed: HTTP ${response.status}${code ? ', code ' + code : ''}`);
        throw new AppError(502, 'CLICKHOUSE_QUERY_FAILED', `ClickHouse 查询失败（HTTP ${response.status}${code ? '，错误码 ' + code : ''}），未生成告警。请检查服务端连接及查询限额。`);
      }
      const result = await response.json() as { data?: Record<string, unknown>[] };
      if (!Array.isArray(result.data) || result.data.length > maxRows) throw new AppError(502, 'INVALID_FEATURE', 'ClickHouse 返回格式或规模无效');
      if (process.env.TRACEGUARD_QUERY_TIMING === '1') console.info(`ClickHouse ${name}: ${Math.round(performance.now() - started)}ms, ${result.data.length} rows`);
      return result.data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      console.error(`ClickHouse ${name} failed after ${Math.round(performance.now() - started)}ms: ${error instanceof Error ? error.name : 'UnknownError'}`);
      throw new AppError(502, 'CLICKHOUSE_UNREACHABLE', 'ClickHouse 连接中断或查询超时，本次检测失败，未生成告警。');
    }
  }
}
