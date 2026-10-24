import type { DetectionInput, Feature, RuleConfiguration } from './types.ts';
import { applyConfiguration } from './rules.ts';

export interface RawEvent {
  event_id: string; video_id: string; source: string; event_type: string; dataset_kind: string;
  auth_result: number; viewer_id: string | null; credential_viewer_id: string | null;
  identity_basis: string; association_status: string; token_ref: string; session_ref: string | null;
  request_ref: string; request_url: string; user_agent: string | null; parse_status: string;
  sampling_rate: number | null; sampling_method: string; sampling_unit: string;
  native_sequence: number | null; event_time_ms: number;
  request_ip?: string | null; ip_basis?: string; http_status?: number | null;
  response_bytes?: number | null; response_completed?: number | null;
  key_valid_until?: string | null; state?: string | null; state_valid_until?: string | null; trusted_state?: number;
}
export interface Media {
  object_path: string; video_id: string; content_version: string; resource_version: string;
  playlist_ref: string; rendition_ref: string; track_type: string; segment_index: number;
  media_start_s: number; media_end_s: number; total_segments: number; manifest_available: number;
}
export interface Coverage { coverage_start: string; coverage_end: string; is_complete: number; sampling_rate: number; sampling_method: string; event_type?: string; requires_token?: number; requires_manifest?: number; requires_key?: number; key_validity_seconds?: number; protocol_version?: string }
export const groups = <T>(rows: T[], key: (row: T) => string) => {
  const result = new Map<string, T[]>();
  for (const row of rows) { const id = key(row); const group = result.get(id) || []; group.push(row); result.set(id, group); }
  return result;
};
export const at = (date: string) => Date.parse(date.replace(' ', 'T') + '+08:00');
export const actor = (e: RawEvent) => e.identity_basis === 'AUTHENTICATED_VIEWER' && e.viewer_id && e.association_status === 'CONFIRMED' ? e.viewer_id : '';
export const identityKey = (e: RawEvent) => actor(e) ? ['VIEWER', actor(e)] : ['CREDENTIAL_VIEWER', e.credential_viewer_id || '?'];
export const pathOf = (url: string) => { try { return url.startsWith('/') ? url.split('?')[0] : new URL(url).pathname; } catch { return ''; } };

export function mediaIndex(rows: Media[]) {
  const index = new Map<string, Media | null>();
  for (const row of rows) index.set(row.object_path, index.has(row.object_path) ? null : row);
  return index;
}
export function intervalUnion(intervals: [number, number][]) {
  let total = 0, start = 0, end = 0, first = true;
  for (const [left, right] of intervals.slice().sort((a, b) => a[0] - b[0])) {
    if (first) { start = left; end = right; first = false; }
    else if (left <= end) end = Math.max(end, right);
    else { total += end - start; start = left; end = right; }
  }
  return first ? 0 : total + end - start;
}
export function base(rows: RawEvent[], input: DetectionInput, contextId: string): Feature {
  const passed = rows.filter(e => e.auth_result === 1).length, failed = rows.filter(e => e.auth_result === 0).length;
  return { videoId: rows[0].video_id, scenario: input.scenario, source: rows[0].source, eventType: 'TS_VALIDATE',
    datasetKinds: [...new Set(rows.map(e => e.dataset_kind))], observed: rows.length, passed, failed, unknown: rows.length - passed - failed,
    known: passed + failed, failureRatio: passed + failed ? failed / (passed + failed) : null,
    anomalyScore: 0, suspicionScore: 0, computeStatus: 'AVAILABLE', reason: '', contextId, actorId: actor(rows[0]) };
}
function unavailable(feature: Feature, reason: string) { return { ...feature, computeStatus: 'UNAVAILABLE' as const, reason }; }

export function deriveFeatures(events: RawEvent[], media: Media[], coverage: Coverage[], input: DetectionInput, configs: RuleConfiguration[]): Feature[] {
  events = events.filter(e => ['MANIFEST_REQUEST', 'HLS_KEY_VALIDATE', 'KEY_RESPONSE', 'TS_VALIDATE', 'CDN_MEDIA_ACCESS'].includes(e.event_type));
  const index = mediaIndex(media);
  const covered = coverage.some(c => (!c.event_type || c.event_type === 'TS_VALIDATE') && c.is_complete === 1 && c.sampling_rate === 1 && c.sampling_method === 'CENSUS' && at(c.coverage_start) <= at(input.windowStart) && at(c.coverage_end) >= at(input.windowEnd));
  const auth = events.filter(e => e.event_type === 'TS_VALIDATE');
  const mapped = (e: RawEvent) => {
    const row = index.get(pathOf(e.request_url));
    return row && row.manifest_available === 1 && row.video_id === e.video_id && row.content_version && Number.isFinite(row.media_start_s) && Number.isFinite(row.media_end_s) && row.media_end_s > row.media_start_s ? row : null;
  };
  const quality = (rows: RawEvent[], feature: Feature) => {
    if (rows.some(e => !actor(e))) return unavailable(feature, 'IDENTITY_UNVERIFIED');
    if (!covered || rows.some(e => e.sampling_rate !== 1 || e.sampling_method !== 'CENSUS' || e.parse_status !== 'OK' || !['SIMULATOR', 'LOCAL_DEMO'].includes(e.source))) return unavailable(feature, 'INCOMPLETE_OR_UNVERIFIED_SOURCE');
    if (rows.some(e => !mapped(e))) return unavailable(feature, 'MISSING_OR_AMBIGUOUS_MEDIA');
    return feature;
  };
  const result: Feature[] = [];
  for (const config of configs) {
    if (config.id === 'R2') {
      for (const [context, rows] of groups(auth.filter(e => e.auth_result === 1), e => JSON.stringify([e.video_id, identityKey(e), e.source]))) {
        let f = quality(rows, base(rows, input, context));
        let seconds = 0;
        for (const content of groups(rows, e => mapped(e)?.content_version || '?').values()) {
          seconds += intervalUnion(content.map(e => mapped(e)).filter((m): m is Media => !!m).map(m => [m.media_start_s, m.media_end_s]));
        }
        f.metrics = { contentSeconds: f.computeStatus === 'AVAILABLE' ? seconds : null, speedRatio: f.computeStatus === 'AVAILABLE' ? seconds / 600 : null };
        result.push(applyConfiguration(f, config));
      }
    }
    if (config.id === 'R6') {
      const candidates = auth.filter(e => e.auth_result === 1);
      const activityKey = (e: RawEvent) => JSON.stringify([e.video_id, identityKey(e), e.session_ref || e.token_ref, e.source]);
      const activityRows = groups(candidates, activityKey);
      for (const [context, rows] of groups(candidates, e => { const m = mapped(e); return JSON.stringify([e.video_id, identityKey(e), e.session_ref || e.token_ref, m?.resource_version, m?.playlist_ref, m?.rendition_ref, m?.track_type, e.source]); })) {
        // An unmapped request cannot be silently split into a separate "unknown"
        // playlist while the remaining known requests claim a complete sequence.
        let f = quality(activityRows.get(activityKey(rows[0]))!, base(rows, input, context));
        const sorted = rows.slice().sort((a, b) => a.event_time_ms - b.event_time_ms || (a.native_sequence ?? 0) - (b.native_sequence ?? 0));
        const definitions = new Set(rows.map(e => mapped(e)?.total_segments));
        const total = mapped(rows[0])?.total_segments || 0;
        if (definitions.size !== 1 || total <= 0) f = unavailable(f, 'INCONSISTENT_MANIFEST');
        if (rows.length < 3) f = unavailable(f, 'INSUFFICIENT_EVENTS');
        const gaps: number[] = []; let increasing = 0;
        for (let i = 1; i < sorted.length; i++) {
          const left = sorted[i - 1], right = sorted[i]; const gap = right.event_time_ms - left.event_time_ms;
          if (gap === 0 && !(left.native_sequence !== null && right.native_sequence !== null && left.native_sequence < right.native_sequence)) f = unavailable(f, 'AMBIGUOUS_EVENT_ORDER');
          gaps.push(gap);
          if (mapped(right) && mapped(left) && mapped(right)!.segment_index > mapped(left)!.segment_index) increasing++;
        }
        const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
        if (mean <= 0) f = unavailable(f, 'ZERO_MEAN_GAP');
        const unique = new Set(rows.filter(e => mapped(e)).map(e => mapped(e)!.segment_index)).size;
        f.metrics = { uniqueSegments: unique, coverage: total ? unique / total : null, monotonic: gaps.length ? increasing / gaps.length : null,
          intervalCv: mean > 0 ? Math.sqrt(gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length) / mean : null };
        result.push(applyConfiguration(f, config));
      }
    }
    if (config.id === 'R9') {
      for (const [context, rows] of groups(auth, e => JSON.stringify([e.video_id, e.source]))) {
        const start = config.parameters.nightStartHour, end = config.parameters.nightEndHour;
        const nightEvents = rows.filter(e => { const hour = new Date(e.event_time_ms + 8 * 3600000).getUTCHours(); return start < end ? hour >= start && hour < end : hour >= start || hour < end; }).length;
        // This is a video/source tag; the first row cannot stand in for every viewer.
        result.push(applyConfiguration({ ...base(rows, input, context), actorId: '', metrics: { nightEvents } }, config));
      }
    }
    if (config.id === 'R10') {
      const signature = (e: RawEvent) => e.source === 'HEALTH_CHECK' ? 'LEGITIMATE' : e.user_agent?.toLowerCase().match(/curl\/|wget\/|python-requests|ffmpeg|libavformat|aria2/)?.[0].replace('/', '') || (e.user_agent ? 'NONE' : 'UNKNOWN');
      const stage = (e: RawEvent) => e.event_type === 'MANIFEST_REQUEST' ? 'MANIFEST' : ['HLS_KEY_VALIDATE', 'KEY_RESPONSE'].includes(e.event_type) ? 'KEY' : 'MEDIA';
      for (const [context, rows] of groups(events, e => JSON.stringify([e.video_id, identityKey(e), e.session_ref || e.token_ref, signature(e), e.source]))) {
        let f = base(rows, input, context); f.eventType = 'CLIENT_REQUEST';
        const code = signature(rows[0]);
        if (code === 'UNKNOWN') f = unavailable(f, 'UNKNOWN_CLIENT_UA');
        const tools = ['NONE', 'UNKNOWN', 'LEGITIMATE'].includes(code) ? [] : rows;
        f.metrics = { toolRequests: new Set(tools.map(e => JSON.stringify([stage(e), e.request_ref || e.event_id]))).size, toolStages: new Set(tools.map(stage)).size };
        result.push(applyConfiguration(f, config));
      }
    }
  }
  return result;
}

export function demoEvidence(input: DetectionInput): { events: RawEvent[]; media: Media[]; coverage: Coverage[] } {
  const day = input.windowStart.slice(0, 10);
  const settings: Record<string, [number, number, number]> = { rapid_pull: [720, 100, 12], client_tool: [20, 1000, 18], sustained_access: [960, 60000, 0], normal: [180, 1000, 14], failure_burst: [200, 1000, 14], unknown_inputs: [10, 1000, 17], token_shared: [40, 5000, 13], scope_violation: [20, 1000, 15], missing_chain: [20, 1000, 16] };
  const [count, spacing, hour] = settings[input.scenario];
  const events: RawEvent[] = [];
  const media: Media[] = [];
  for (let i = 0; i < count; i++) {
    const timestamp = Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00+08:00`) + i * spacing;
    if (timestamp < at(input.windowStart) || timestamp >= at(input.windowEnd)) continue;
    const segment = i % 720; const path = `/demo/${segment}.ts`;
    const video = input.scenario === 'scope_violation' ? 'demo-video-outside' : 'demo-video-001';
    events.push({ event_id: `demo-${day}-${i}`, video_id: video, source: 'LOCAL_DEMO', event_type: 'TS_VALIDATE', dataset_kind: 'LOCAL_DEMO',
      auth_result: input.scenario === 'unknown_inputs' ? -1 : input.scenario === 'failure_burst' && i < 150 || input.scenario === 'normal' && i < 8 ? 0 : 1,
      viewer_id: 'demo-viewer', credential_viewer_id: 'demo-viewer', identity_basis: 'AUTHENTICATED_VIEWER', association_status: 'CONFIRMED', token_ref: 'demo-token', session_ref: 'demo-session',
      request_ref: `req-${day}-${i}`, request_url: path, user_agent: input.scenario === 'client_tool' ? 'python-requests/2.32' : input.scenario === 'token_shared' && i % 2 ? 'Mozilla/5.0 iPhone' : 'Mozilla/5.0 Android', parse_status: 'OK',
      request_ip: input.scenario === 'token_shared' && i % 2 ? '198.51.100.2' : '198.51.100.1', ip_basis: 'TRUSTED_REQUEST',
      sampling_rate: 1, sampling_method: 'CENSUS', sampling_unit: 'AUTH_EVENT', native_sequence: i, event_time_ms: timestamp });
    media.push({ object_path: path, video_id: video, content_version: 'demo-content', resource_version: 'v1', playlist_ref: 'p1', rendition_ref: '1080', track_type: 'VIDEO', segment_index: segment, media_start_s: segment * 10, media_end_s: (segment + 1) * 10, total_segments: 720, manifest_available: 1 });
  }
  return { events, media: [...new Map(media.map(m => [m.object_path, m])).values()], coverage: ['TS_VALIDATE', 'PLAYBACK_STATE', 'TOKEN_CREATE', 'MANIFEST_REQUEST', 'KEY_RESPONSE'].map(event_type => ({ event_type, coverage_start: '2026-10-15 00:00:00.000', coverage_end: '2026-10-24 00:00:00.000', is_complete: 1, sampling_rate: 1, sampling_method: 'CENSUS', requires_token: 1, requires_manifest: 1, requires_key: 1, key_validity_seconds: 3600, protocol_version: 'LOCAL_DEMO' })) };
}
