import { isIP } from 'node:net';
import type { DetectionInput, Feature, RuleConfiguration } from './types.ts';
import { applyConfiguration } from './rules.ts';
import { actor, at, base, groups, identityKey, intervalUnion, mediaIndex, pathOf, type Coverage, type Media, type RawEvent } from './features.ts';

export interface Snapshot {
  token_ref: string; effective_at: string; expires_at: string; revoked: number;
  allowed_video_ids: string[]; original_issued_at: string; policy_version: string;
}
export function snapshotLookup(snapshots: Snapshot[]) {
  const tokens = groups(snapshots, s => s.token_ref);
  return (event: RawEvent) => {
    const eligible = (tokens.get(event.token_ref) || []).filter(s => at(s.effective_at) <= event.event_time_ms).sort((a, b) => at(b.effective_at) - at(a.effective_at));
    if (!eligible.length || !eligible[0].policy_version) return null;
    const latest = eligible.filter(s => s.effective_at === eligible[0].effective_at);
    if (new Set(latest.map(s => JSON.stringify(s))).size !== 1) return null;
    return eligible[0];
  };
}
export const validToken = (snapshot: Snapshot, time: number) => snapshot.revoked === 0 && at(snapshot.expires_at) > time;
export function sourceCovered(coverage: Coverage[], eventType: string, start: number, end: number) {
  if (end <= start) return false;
  const spans: [number, number][] = coverage.filter(c => c.event_type === eventType && c.is_complete === 1 && c.sampling_rate === 1 && c.sampling_method === 'CENSUS')
    .map(c => [Math.max(start, at(c.coverage_start)), Math.min(end, at(c.coverage_end))]).filter(s => s[1] > s[0]) as [number, number][];
  return intervalUnion(spans) >= end - start;
}
const error = (f: Feature, reason: string): Feature => ({ ...f, computeStatus: 'UNAVAILABLE', reason });
const whole = (rows: RawEvent[]) => rows.every(e => e.sampling_rate === 1 && e.sampling_method === 'CENSUS' && e.parse_status === 'OK' && ['SIMULATOR', 'LOCAL_DEMO'].includes(e.source));
const scoped = (events: RawEvent[], input: DetectionInput) => events.filter(e => e.event_time_ms >= at(input.windowStart) && e.event_time_ms < at(input.windowEnd));
const client = (e: RawEvent) => ['MANIFEST_REQUEST', 'HLS_KEY_VALIDATE', 'KEY_RESPONSE', 'TS_VALIDATE', 'CDN_MEDIA_ACCESS', 'REQUEST_REJECTED'].includes(e.event_type);
const mediaPass = (e: RawEvent) => e.auth_result === 1 || e.event_type === 'CDN_MEDIA_ACCESS' && [200, 206].includes(e.http_status ?? 0) && (e.response_bytes ?? 0) > 0;
const refs = (rows: RawEvent[]) => rows.slice(0, 20).map(e => e.event_id);
function nativeFeature(rows: RawEvent[], input: DetectionInput, context: string, type: 'VIEWER' | 'TOKEN'): Feature {
  const f = base(rows, input, context);
  return { ...f, videoId: '', actorId: type === 'VIEWER' ? actor(rows[0]) : '', subjectType: type === 'VIEWER' && !actor(rows[0]) ? 'CREDENTIAL_VIEWER' : type,
    subjectId: type === 'TOKEN' ? rows[0].token_ref : actor(rows[0]) || rows[0].credential_viewer_id || '',
    relatedVideoIds: [...new Set(rows.map(e => e.video_id).filter(Boolean))], evidenceRefs: refs(rows), windowStart: input.windowStart, windowEnd: input.windowEnd };
}

export function clientClass(event: RawEvent) {
  const ua = (event.user_agent || '').toLowerCase();
  if (/android/.test(ua)) return 'ANDROID';
  if (/iphone|ipad/.test(ua)) return 'IOS';
  if (/windows/.test(ua)) return 'WINDOWS';
  if (/macintosh|mac os/.test(ua)) return 'MACOS';
  if (/linux/.test(ua)) return 'LINUX';
  if (/curl\/|wget\/|python-requests|ffmpeg|libavformat|aria2/.test(ua)) return 'TOOL';
  return '';
}
function environment(e: RawEvent) {
  const category = clientClass(e);
  return category && e.request_ip && isIP(e.request_ip) && ['TRUSTED_REQUEST', 'DIRECT_CLIENT'].includes(e.ip_basis || '') ? { key: JSON.stringify([e.request_ip, category]), ip: e.request_ip, category } : null;
}

export function deriveAdvanced(events: RawEvent[], media: Media[], coverage: Coverage[], snapshots: Snapshot[], input: DetectionInput, config: RuleConfiguration, history: RawEvent[] = []): Feature[] {
  const observed = scoped(events, input), lookup = snapshotLookup(snapshots), result: Feature[] = [];
  const finish = (f: Feature) => result.push(applyConfiguration({ ...f, windowStart: input.windowStart, windowEnd: input.windowEnd }, config));
  if (config.id === 'R4A') {
    for (const [context, rows] of groups(observed.filter(e => client(e) && e.token_ref), e => JSON.stringify([e.token_ref, e.source]))) {
      let f = nativeFeature(rows, input, context, 'TOKEN'); f.eventType = 'CLIENT_REQUEST';
      if (!whole(rows)) f = error(f, 'INCOMPLETE_OR_UNVERIFIED_SOURCE');
      // A response and authorization of the same request represent one attempt.
      const requests = groups(rows, e => JSON.stringify([e.video_id, e.request_ref || e.event_id]));
      let attempts = 0, successes = 0, unknown = 0; const outside = new Set<string>(), successfulVideos = new Set<string>();
      for (const request of requests.values()) {
        const states = request.map(e => ({ e, s: lookup(e) }));
        if (states.some(({ e, s }) => !s || !e.video_id)) { unknown++; continue; }
        const out = states.filter(({ e, s }) => !s!.allowed_video_ids.includes(e.video_id));
        if (!out.length) continue;
        attempts++; outside.add(request[0].video_id);
        if (out.some(({ e }) => mediaPass(e))) { successes++; successfulVideos.add(request[0].video_id); }
        else if (out.some(({ e }) => !(e.auth_result === 0 || (e.http_status ?? 0) >= 400))) unknown++;
      }
      f.metrics = { outsideAttempts: attempts, outsideVideos: outside.size, outsideSuccesses: successes };
      // A known success proves the high tier even if unrelated requests have unknown history.
      if (unknown && !successes) f = error(f, 'MISSING_OR_AMBIGUOUS_TOKEN_HISTORY');
      f.relatedVideoIds = [...(successes ? successfulVideos : outside)];
      if (unknown && successes) f.limitations = ['其他请求存在未知授权历史，仅依据已核实的范围外成功记录评分'];
      finish(f);
    }
  }
  if (config.id === 'R5') {
    for (const [context, rows] of groups(observed.filter(e => e.event_type === 'TS_VALIDATE'), e => JSON.stringify([identityKey(e), e.source]))) {
      let f = nativeFeature(rows, input, context, 'VIEWER');
      const eligible = rows.filter(e => environment(e) && e.source !== 'HEALTH_CHECK');
      if (rows.some(e => !actor(e))) f = error(f, 'IDENTITY_UNVERIFIED');
      else if (!whole(rows) || !sourceCovered(coverage, 'TS_VALIDATE', at(input.windowStart), at(input.windowEnd))) f = error(f, 'INCOMPLETE_OR_UNVERIFIED_SOURCE');
      else if (rows.some(e => e.ip_basis !== 'VERIFIED_PROXY' && !environment(e))) f = error(f, 'UNKNOWN_CLIENT_ENVIRONMENT');
      else if (eligible.length < config.parameters.minimumEvents) f = error(f, 'INSUFFICIENT_VALID_EVENTS');
      f.metrics = { ipCount: new Set(eligible.map(e => e.request_ip)).size, uaCount: new Set(eligible.map(clientClass)).size, validEvents: eligible.length, excludedProxyEvents: rows.filter(e => e.ip_basis === 'VERIFIED_PROXY').length };
      finish(f);
    }
  }
  if (config.id === 'R4B') {
    for (const [context, rows] of groups(observed.filter(e => e.event_type === 'TS_VALIDATE' && e.token_ref), e => JSON.stringify([e.token_ref, e.source]))) {
      let f = nativeFeature(rows, input, context, 'TOKEN');
      if (!whole(rows) || !sourceCovered(coverage, 'TS_VALIDATE', at(input.windowStart), at(input.windowEnd))) f = error(f, 'INCOMPLETE_OR_UNVERIFIED_SOURCE');
      if (rows.some(e => !lookup(e))) f = error(f, 'MISSING_OR_AMBIGUOUS_TOKEN_HISTORY');
      const passes = rows.filter(e => e.auth_result === 1 && lookup(e) && validToken(lookup(e)!, e.event_time_ms) && e.ip_basis !== 'VERIFIED_PROXY');
      if (passes.some(e => !environment(e))) f = error(f, 'UNKNOWN_CLIENT_ENVIRONMENT');
      const environments = [...groups(passes.filter(e => environment(e)), e => environment(e)!.key).values()];
      if (environments.length > 100) {
        finish(error({ ...f, metrics: { generalEnvironments: null, attentionEnvironments: null, attentionPairs: null, highPairs: null } }, 'ENVIRONMENT_PAIR_LIMIT'));
        continue;
      }
      let attentionPairs = 0, highPairs = 0;
      for (let a = 0; a < environments.length; a++) for (let b = a + 1; b < environments.length; b++) {
        const left = environments[a], right = environments[b], el = environment(left[0])!, er = environment(right[0])!;
        if (el.category === er.category) continue;
        const start = Math.max(Math.min(...left.map(e => e.event_time_ms)), Math.min(...right.map(e => e.event_time_ms)));
        const end = Math.min(Math.max(...left.map(e => e.event_time_ms)), Math.max(...right.map(e => e.event_time_ms)));
        if (end - start < config.parameters.interleaveSeconds * 1000) continue;
        const pair = [...left, ...right].filter(e => e.event_time_ms >= start && e.event_time_ms <= end).sort((a, b) => a.event_time_ms - b.event_time_ms);
        const timeGroups = groups(pair, e => String(e.event_time_ms));
        // Ambiguous timestamp order invalidates this pair rather than deleting ties and inventing switches.
        if ([...timeGroups.values()].some(g => g.length > 1 && (g.some(e => e.native_sequence === null) || new Set(g.map(e => e.native_sequence)).size !== g.length))) continue;
        pair.sort((a, b) => a.event_time_ms - b.event_time_ms || (a.native_sequence ?? 0) - (b.native_sequence ?? 0));
        let switches = 0;
        for (let i = 1; i < pair.length; i++) if (environment(pair[i])!.key !== environment(pair[i - 1])!.key) switches++;
        const l = pair.filter(e => environment(e)!.key === el.key).length, r = pair.length - l;
        if (switches >= 3 && Math.min(l, r) >= config.parameters.attentionPasses) attentionPairs++;
        if (switches >= 3 && el.ip !== er.ip && Math.min(l, r) >= config.parameters.highPasses) highPairs++;
      }
      f.metrics = { generalEnvironments: environments.filter(e => e.length >= config.parameters.generalPasses).length,
        attentionEnvironments: environments.filter(e => e.length >= config.parameters.attentionPasses).length, attentionPairs, highPairs };
      finish(f);
    }
  }
  if (config.id === 'R3') {
    const stateRows = [...events, ...history].filter(e => e.event_type === 'PLAYBACK_STATE' && e.event_time_ms < at(input.windowEnd)
      && (e.event_time_ms >= at(input.windowStart) || !!e.state_valid_until && at(e.state_valid_until) > at(input.windowStart)));
    const dedup = [...new Map(stateRows.map(e => [e.event_id, e])).values()];
    const all = [...dedup, ...observed.filter(e => e.event_type === 'TS_VALIDATE')];
    for (const [context, rows] of groups(all, e => JSON.stringify([identityKey(e), e.source]))) {
      let f = nativeFeature(rows, input, context, 'VIEWER'); f.eventType = 'PLAYBACK_STATE';
      const states = rows.filter(e => e.event_type === 'PLAYBACK_STATE');
      if (rows.some(e => !actor(e))) f = error(f, 'IDENTITY_UNVERIFIED');
      else if (!states.length) f = error(f, 'MISSING_TRUSTED_STATE');
      else if (!whole(states) || !sourceCovered(coverage, 'PLAYBACK_STATE', at(input.windowStart), at(input.windowEnd))) f = error(f, 'INCOMPLETE_OR_UNVERIFIED_SOURCE');
      const intervals = new Map<string, [number, number][]>();
      for (const session of groups(states, e => e.session_ref || '?').values()) {
        session.sort((a, b) => a.event_time_ms - b.event_time_ms);
        if (session.some(e => e.trusted_state !== 1 || !e.session_ref || !e.state_valid_until || !Number.isFinite(at(e.state_valid_until)))) f = error(f, 'MISSING_TRUSTED_STATE');
        for (let i = 0; i < session.length; i++) {
          const e = session[i];
          if (i && e.event_time_ms === session[i - 1].event_time_ms) f = error(f, 'AMBIGUOUS_EVENT_ORDER');
          if (e.state !== 'PLAYING' || !e.state_valid_until || !e.video_id) continue;
          const start = Math.max(e.event_time_ms, at(input.windowStart)), end = Math.min(at(e.state_valid_until), session[i + 1]?.event_time_ms ?? at(input.windowEnd), at(input.windowEnd));
          if (end > start) { const list = intervals.get(e.video_id) || []; list.push([start, end]); intervals.set(e.video_id, list); }
        }
      }
      // Merge adjacent heartbeats for each video before checking a persistent subset.
      const merged = new Map<string, [number, number][]>();
      for (const [video, spans] of intervals) {
        const list: [number, number][] = [];
        for (const span of spans.sort((a, b) => a[0] - b[0])) { const last = list.at(-1); if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else list.push([...span]); }
        merged.set(video, list);
      }
      let videos: string[] = [];
      for (const start of [...merged.values()].flat().map(s => s[0])) {
        const subset = [...merged].filter(([, spans]) => spans.some(s => s[0] <= start && s[1] >= start + config.parameters.minimumOverlapSeconds * 1000)).map(([v]) => v);
        if (subset.length > videos.length) videos = subset;
      }
      f.relatedVideoIds = videos; f.metrics = { concurrentVideos: videos.length }; finish(f);
    }
  }
  if (config.id === 'R1') {
    const index = mediaIndex(media);
    const tokenHistories = groups(history, e => e.token_ref);
    for (const [context, rows] of groups(observed.filter(e => e.event_type === 'TS_VALIDATE' && e.auth_result === 1), e => JSON.stringify([identityKey(e), e.video_id, e.session_ref || e.token_ref, e.source]))) {
      let f = base(rows, input, context); f.evidenceRefs = refs(rows); f.limitations = ['一般档顺序异常未计算：缺少协议顺序模型'];
      const missing = new Set<string>(), joint = new Set<string>();
      if (rows.some(e => !actor(e))) f = error(f, 'IDENTITY_UNVERIFIED');
      if (!whole(rows) || !sourceCovered(coverage, 'TS_VALIDATE', at(input.windowStart), at(input.windowEnd))) f = error(f, 'INCOMPLETE_OR_UNVERIFIED_SOURCE');
      for (const e of rows) {
        const m = index.get(pathOf(e.request_url)), s = lookup(e);
        if (!m || m.video_id !== e.video_id || m.manifest_available !== 1) { f = error(f, 'MISSING_OR_AMBIGUOUS_MEDIA'); continue; }
        const protocols = coverage.filter(c => c.event_type === 'TS_VALIDATE' && at(c.coverage_start) <= e.event_time_ms && at(c.coverage_end) > e.event_time_ms);
        if (protocols.length !== 1 || !protocols[0].protocol_version || !s || !Number.isFinite(at(s.original_issued_at))) { f = error(f, 'MISSING_PROTOCOL_OR_AUTHORIZATION_HISTORY'); continue; }
        const p = protocols[0], prior = (tokenHistories.get(e.token_ref) || []).filter(h => (h.video_id === e.video_id || ['TOKEN_CREATE', 'TOKEN_RENEW'].includes(h.event_type)) && (!e.session_ref || !h.session_ref || h.session_ref === e.session_ref || ['TOKEN_CREATE', 'TOKEN_RENEW'].includes(h.event_type)));
        if (!whole(prior)) { f = error(f, 'INCOMPLETE_OR_UNVERIFIED_SOURCE'); continue; }
        const keySeconds = p.key_validity_seconds || 0;
        const tokenPresent = validToken(s, e.event_time_ms);
        const keyPresent = prior.some(h => h.event_type === 'KEY_RESPONSE' && h.event_time_ms < e.event_time_ms && h.http_status === 200 && h.response_completed === 1 && (h.key_valid_until ? at(h.key_valid_until) > e.event_time_ms : keySeconds > 0 && h.event_time_ms + keySeconds * 1000 > e.event_time_ms));
        const manifestPresent = prior.some(h => h.event_type === 'MANIFEST_REQUEST' && h.event_time_ms >= at(s.original_issued_at) && h.event_time_ms < e.event_time_ms && h.http_status === 200);
        const tied = prior.some(h => h.event_time_ms === e.event_time_ms && ['KEY_RESPONSE', 'MANIFEST_REQUEST'].includes(h.event_type));
        const tokenKnown = !p.requires_token || tokenPresent || sourceCovered(coverage, 'TOKEN_CREATE', at(s.original_issued_at), e.event_time_ms);
        const manifestKnown = !p.requires_manifest || manifestPresent || sourceCovered(coverage, 'MANIFEST_REQUEST', at(s.original_issued_at), e.event_time_ms);
        const keyKnown = !p.requires_key || keyPresent || keySeconds > 0 && sourceCovered(coverage, 'KEY_RESPONSE', e.event_time_ms - keySeconds * 1000, e.event_time_ms);
        if (!tokenKnown || !manifestKnown || !keyKnown || tied) { f = error(f, 'SOURCE_OR_VALIDITY_NOT_COMPLETE'); continue; }
        const id = JSON.stringify([m.content_version, m.resource_version, m.playlist_ref, m.rendition_ref, m.track_type, m.segment_index]);
        if (p.requires_token && !tokenPresent || p.requires_manifest && !manifestPresent || p.requires_key && !keyPresent) missing.add(id);
        if (p.requires_token && !tokenPresent && p.requires_key && !keyPresent) joint.add(id);
      }
      f.metrics = { missingOneSegments: missing.size, missingTokenKeySegments: joint.size }; finish(f);
    }
  }
  return result;
}

// Shared by demo extraction and the ClickHouse aggregate adapter.
export function deriveSustained(events: RawEvent[], media: Media[], coverage: Coverage[], input: DetectionInput, config: RuleConfiguration): Feature[] {
  const index = mediaIndex(media), result: Feature[] = [];
  for (const [context, rows] of groups(scoped(events, input).filter(e => e.event_type === 'TS_VALIDATE' && e.auth_result === 1), e => JSON.stringify([identityKey(e), e.source]))) {
    let f = nativeFeature(rows, input, context, 'VIEWER');
    if (rows.some(e => !actor(e))) f = error(f, 'IDENTITY_UNVERIFIED');
    if (at(input.windowEnd) - at(input.windowStart) !== 86400000 || !whole(rows) || !sourceCovered(coverage, 'TS_VALIDATE', at(input.windowStart), at(input.windowEnd))) f = error(f, 'INCOMPLETE_OR_UNVERIFIED_SOURCE');
    let seconds = 0;
    for (const content of groups(rows, e => JSON.stringify([e.video_id, index.get(pathOf(e.request_url))?.content_version])).values()) {
      const mapped = content.map(e => index.get(pathOf(e.request_url)));
      if (mapped.some((m, i) => !m || m.video_id !== content[i].video_id || m.manifest_available !== 1 || !(m.media_end_s > m.media_start_s))) f = error(f, 'MISSING_OR_AMBIGUOUS_MEDIA');
      seconds += intervalUnion(mapped.filter((m): m is Media => !!m).map(m => [m.media_start_s, m.media_end_s]));
    }
    f.metrics = { activeMinutes: new Set(rows.map(e => Math.floor(e.event_time_ms / 60000))).size, contentSeconds: seconds };
    result.push(applyConfiguration(f, config));
  }
  return result;
}
