import { isIP } from 'node:net';
import { actor, at, groups, intervalUnion, mediaIndex, pathOf, type Coverage, type Media, type RawEvent } from './features.ts';
import { clientClass, type Snapshot } from './advanced-features.ts';

// Event replay for one alert: three tracks (authorization, content, environment) sharing one
// wall-clock window. Everything here is derived from observed records only; no synthetic events.

export interface ReplayAuthEvent { t: number; kind: string; label: string; tokenRef: string; status: number | null; keyValidUntil: number | null }
export interface ReplayToken { ref: string; issuedAt: number; effectiveAt: number; expiresAt: number; revoked: boolean; allowedVideos: string[] }
export interface ReplaySegment { t: number; s: number; e: number }
// 点位与进度时间均为相对窗口起点的毫秒偏移，压缩传输体积。
export interface ReplayProgress { t: number; req: number; sec: number }
export interface ReplayCourse {
  videoId: string; totalSegments: number | null; coveredSegments: number; totalSeconds: number | null; dedupSeconds: number;
  strictlyIncreasing: boolean | null; firstT: number | null; lastT: number | null;
  points: number[]; failedPoints: number[]; progress: ReplayProgress[]; sampled: boolean;
}
export interface ReplayEnvironment { ip: string; category: string; label: string; ua: string | null; points: number[]; firstT: number; lastT: number; count: number }
export interface ReplaySideBlocks { observed: string[]; risk: string[]; unknown: string[]; next: string[] }

export interface ReplayTimeline {
  windowStart: string; windowEnd: string; windowMs: number; windowSeconds: number;
  ruleId: string; ruleName: string; scenario: string; tier: string | null;
  subject: { kind: string; id: string };
  scopeNote: string;
  content: {
    basis: string; requests: number; dedupSeconds: number; speedRatio: number | null; coverageRatio: number | null;
    strictlyIncreasing: boolean | null; medianGapMs: number | null; gapCv: number | null;
    activeMinutes: number | null; courses: ReplayCourse[];
  };
  auth: { tokens: ReplayToken[]; events: ReplayAuthEvent[] };
  env: { environments: ReplayEnvironment[]; toolUa: string | null; switches: number; unknownEvents: number };
  sidebar: ReplaySideBlocks;
  limitations: string[];
}

export interface ReplayInput {
  ruleId: string; ruleName: string; scenario: string;
  windowStart: string; windowEnd: string; videoId: string;
  tier: string | null;
  subjectType?: string; subjectId?: string; contextId?: string;
  metrics?: Record<string, number | null>;
  scoring?: { anomalyScore:number; suspicionScore:number|null; reason:string; businessPolicyVersion?:string };
}

const AUTH_KINDS: Record<string, string> = {
  TOKEN_CREATE: '签发 token', TOKEN_RENEW: '续期 token', MANIFEST_REQUEST: '请求播放清单',
  HLS_KEY_VALIDATE: '校验解密密钥', KEY_RESPONSE: '获取解密密钥', REQUEST_REJECTED: '请求被拒绝',
};
const CLIENT_TYPES = ['MANIFEST_REQUEST', 'HLS_KEY_VALIDATE', 'KEY_RESPONSE', 'TS_VALIDATE', 'CDN_MEDIA_ACCESS', 'REQUEST_REJECTED'];
const CATEGORY_LABEL: Record<string, string> = { ANDROID: '安卓', IOS: 'iPhone/iPad', WINDOWS: 'Windows', MACOS: 'macOS', LINUX: 'Linux', TOOL: '工具程序' };
const TOOL_PATTERN = /(ffmpeg|curl|wget|aria2c?|python-requests|libavformat)(\/[\w.]+)?/i;

// Same success definition as the rule engine: a passed validation or a complete CDN response.
const acquired = (event: RawEvent) => event.auth_result === 1 || event.event_type === 'CDN_MEDIA_ACCESS' && [200, 206].includes(event.http_status ?? 0) && (event.response_bytes ?? 0) > 0;
const failedAttempt = (event: RawEvent) => event.auth_result === 0 || event.event_type === 'CDN_MEDIA_ACCESS' && (event.http_status ?? 0) >= 400;

function browserLabel(ua: string) {
  if (/edg\//i.test(ua)) return 'Edge';
  if (/chrome|crios/i.test(ua)) return 'Chrome';
  if (/safari/i.test(ua)) return 'Safari';
  if (/firefox/i.test(ua)) return 'Firefox';
  return '';
}

// The alert feature stores its grouping key in contextId; recover the viewer / credential subject
// from it so the replay shows the same population the rule scored.
function subjectFrom(input: ReplayInput): { kind: string; id: string } {
  if (input.subjectType && input.subjectId && input.subjectType !== 'VIDEO') return { kind: input.subjectType, id: input.subjectId };
  const walk = (value: unknown): string[] | null => {
    if (Array.isArray(value)) {
      if (value.length === 2 && ['VIEWER', 'CREDENTIAL_VIEWER'].includes(String(value[0])) && typeof value[1] === 'string') return [String(value[0]), value[1]];
      for (const item of value) { const found = walk(item); if (found) return found; }
    }
    return null;
  };
  try {
    const found = walk(JSON.parse(input.contextId || 'null'));
    if (found) return { kind: found[0], id: found[1] };
  } catch { /* legacy context ids are not JSON */ }
  return input.videoId ? { kind: 'VIDEO', id: input.videoId } : { kind: 'ANY', id: '' };
}

const SUBJECT_LABEL: Record<string, string> = { VIEWER: '认证观众', CREDENTIAL_VIEWER: '凭证绑定观众', TOKEN: '授权凭证', VIDEO: '视频主体', ANY: '全部事件' };
const inScope = (event: RawEvent, subject: { kind: string; id: string }) =>
  subject.kind === 'VIEWER' ? actor(event) === subject.id
    : subject.kind === 'CREDENTIAL_VIEWER' ? !actor(event) && event.credential_viewer_id === subject.id
      : subject.kind === 'TOKEN' ? event.token_ref === subject.id
        : subject.kind === 'VIDEO' ? event.video_id === subject.id
          : true;

const secondsText = (value: number) => value >= 5400 ? `${(value / 3600).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 小时` : `${Math.round(value).toLocaleString('zh-CN')} 秒`;
const ratioText = (value: number) => `${value >= 10 ? Math.round(value) : value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 倍`;
const pctText = (value: number) => `${(value * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;

function sidebars(input: ReplayInput, timeline: Omit<ReplayTimeline, 'sidebar'>): ReplaySideBlocks {
  const { content, env, auth } = timeline;
  const observed: string[] = [];
  const risk: string[] = [];
  const unknown: string[] = [];
  const next: string[] = [];
  const issued = auth.events.find(event => event.kind === 'TOKEN_CREATE');
  const keyed = auth.events.find(event => event.kind === 'KEY_RESPONSE');
  if (issued && keyed && auth.events.some(event => event.kind === 'MANIFEST_REQUEST')) {
    observed.push(`起播链路正常：${((keyed.t - issued.t) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 秒内完成签发 token → 播放清单 → 解密密钥`);
  }
  if (content.requests) {
    observed.push(`窗口内 ${content.requests.toLocaleString('zh-CN')} 次内容请求，去重内容 ${secondsText(content.dedupSeconds)}` +
      (content.speedRatio !== null && content.speedRatio >= 1 ? `（按窗口时长折算 ${ratioText(content.speedRatio)}）` : ''));
  }
  if (content.coverageRatio !== null && content.requests) {
    observed.push(`分片覆盖 ${pctText(content.coverageRatio)}${content.strictlyIncreasing ? '，分片严格递增' : ''}` +
      (content.medianGapMs !== null ? `，请求间隔中位数 ${content.medianGapMs.toLocaleString('zh-CN')} ms${(content.gapCv ?? 1) < 0.1 ? '，几乎没有波动' : ''}` : ''));
  }
  if (content.activeMinutes !== null && timeline.windowSeconds > 3600) observed.push(`窗口内活跃 ${content.activeMinutes.toLocaleString('zh-CN')} 分钟，覆盖 ${content.courses.length} 门课程`);
  if (env.environments.length > 1) observed.push(`同一主体在 ${env.environments.length} 组 IP/客户端环境使用${env.switches >= 3 ? `，环境间交替 ${env.switches} 次` : ''}`);
  else if (env.environments.length === 1) observed.push(`全部请求来自同一环境（${env.environments[0].label}）`);
  if (env.toolUa) observed.push(`客户端标识 ${env.toolUa}，存在工具访问特征`);
  // Interpret the alert's frozen scoring state, never the tenant's current policy.
  const score=input.scoring?.suspicionScore;
  const policy=input.scoring?.businessPolicyVersion;
  const policyLabels:Record<string,string>={R1:'缓存及续期约束',R2:'禁止下载/预取',R4B:'禁止账号共享'};
  if(typeof score==='number') {
    observed.push(policy&&policyLabels[input.ruleId]
      ? `该告警已核验业务前提：${policyLabels[input.ruleId]}；嫌疑分 S=${score}（${policy}）`
      : `该告警保存的嫌疑分 S=${score}，回放沿用该分值`);
    if(score>0&&policyLabels[input.ruleId]&&!policy)unknown.push('历史告警未保存业务策略版本，具体准入依据需结合原告警核对');
  } else if(input.scoring?.reason.startsWith('BUSINESS_')&&input.scoring.reason.endsWith('_UNVERIFIED')) {
    unknown.push('该告警生成时的业务前提待核实，嫌疑分暂不计算；回放保留当时的评分状态');
  } else if(input.scoring) {
    unknown.push('该告警嫌疑分不可计算，需核查触发时的准入依据');
  } else {
    unknown.push('历史回放输入未保存嫌疑分及业务前提信息，以原告警快照为准');
  }
  switch (input.ruleId) {
    case 'R2':
      risk.push(typeof score==='number'&&score>0&&policy?'禁止下载/预取前提下的异常内容拉取线索':'批量内容获取线索（机械访问特征）');
      unknown.push('加密分片访问与密钥获取不能证明内容已被解密、留存或传播');
      next.push(typeof score==='number'&&score>0&&policy?'核查该账号是否存在单独批准的业务例外及实际内容使用范围':'核查该账号的下载/预取授权与内容使用范围', '核对账号使用人与企业培训安排');
      break;
    case 'R6':
    case 'R10':
      risk.push('机械顺序拉取特征：分片顺序与请求间隔偏离正常播放');
      unknown.push('工具特征只能说明客户端标识，不能证明内容已被解密或外传');
      next.push('核查该账号下载授权与自动化工具使用情况');
      break;
    case 'R4A':
    case 'R4B':
    case 'R5':
      risk.push('账号共享使用线索：同一凭证在多个环境交替使用');
      unknown.push('IP 与客户端标识不能等同于设备或自然人，不能断言有几个人在共用账号');
      next.push('核查账号使用人与共享情况', '确认是否存在合法的多设备使用安排');
      break;
    case 'R8':
      risk.push(`长时持续访问，达到 R8 ${input.tier || '命中档位'}，作为辅助证据进入人工核查`);
      unknown.push('网络日志无法直接观察屏幕录制，不等于已识别录屏或已看完全部课程');
      next.push('核查账号使用人、企业培训安排与自动连播设置');
      break;
    case 'R7': {
      if (input.metrics?.failureRatio !== null && input.metrics?.failureRatio !== undefined) {
        observed.push(`已知鉴权结果中失败占 ${pctText(input.metrics.failureRatio)}`);
      }
      risk.push('访问异常，优先排查服务或授权配置');
      unknown.push('仅凭失败率不能确诊故障，故障也可能与恶意行为同时发生');
      next.push('检查错误码分布、用户分布、时间集中度与服务监控');
      break;
    }
    default:
      risk.push(`${input.ruleId} ${input.ruleName}命中（${input.tier || '见特征快照'}），贡献异常分`);
      unknown.push('此处仅展示单规则证据，不构成对盗版行为的认定');
      next.push('按规则前提核查对应业务事实，再决定处置');
  }
  return { observed, risk, unknown, next };
}

// Strictly increasing means: distinct acquired segments, in request order, always move forward in
// media time. Duplicate observations of the same segment (validation + CDN access) are collapsed.
function segmentOrder(segments: ReplaySegment[]): boolean | null {
  const collapsed: ReplaySegment[] = [];
  for (const segment of segments) {
    const last = collapsed.at(-1);
    if (!last || last.s !== segment.s || last.e !== segment.e) collapsed.push(segment);
  }
  if (collapsed.length < 2) return null;
  for (let i = 1; i < collapsed.length; i++) if (collapsed[i].s <= collapsed[i - 1].s) return false;
  return true;
}

export function buildTimeline(input: ReplayInput, data: { events: RawEvent[]; media: Media[]; snapshots: Snapshot[]; coverage: Coverage[] }): ReplayTimeline {
  const t0 = at(input.windowStart), t1 = at(input.windowEnd), span = Math.max(1, t1 - t0);
  const subject = subjectFrom(input);
  const deduped = [...new Map(data.events.map(event => [event.event_id, event])).values()].sort((a, b) => a.event_time_ms - b.event_time_ms);
  const windowEvents = deduped.filter(event => event.event_time_ms >= t0 && event.event_time_ms < t1);
  const mine = windowEvents.filter(event => CLIENT_TYPES.includes(event.event_type) && inScope(event, subject));
  const limitations: string[] = [];

  // Authorization track: snapshots give validity spans; history supplies events issued before the window.
  const tokenRefs = new Set(mine.map(event => event.token_ref).filter(Boolean));
  if (subject.kind === 'TOKEN' && subject.id) tokenRefs.add(subject.id);
  const snapshots = data.snapshots.filter(snapshot => tokenRefs.has(snapshot.token_ref));
  const authEvents = deduped
    .filter(event => event.token_ref && tokenRefs.has(event.token_ref) && event.event_type in AUTH_KINDS && event.event_time_ms < t1)
    .map(event => ({ t: event.event_time_ms - t0, kind: event.event_type, label: AUTH_KINDS[event.event_type], tokenRef: event.token_ref, status: event.http_status ?? null, keyValidUntil: event.key_valid_until ? at(event.key_valid_until) - t0 : null }));
  const tokens = snapshots.map(snapshot => ({
    ref: snapshot.token_ref, issuedAt: at(snapshot.original_issued_at), effectiveAt: at(snapshot.effective_at),
    expiresAt: at(snapshot.expires_at), revoked: snapshot.revoked === 1, allowedVideos: snapshot.allowed_video_ids,
  }));
  if (tokenRefs.size && !snapshots.length) limitations.push('授权凭证缺少可用快照，轨迹仅显示事件时点，不显示有效期');

  // Content track: only mapped, completely answered segment requests count toward content volume.
  const index = mediaIndex(data.media);
  const contentEvents = mine.filter(event => ['TS_VALIDATE', 'CDN_MEDIA_ACCESS'].includes(event.event_type));
  const courses: ReplayCourse[] = [];
  const gapTimes: number[] = [];
  let unmappedAcquired = 0;
  let sampledDisplay = false;
  // 画布每像素最多两个点就有意义；超出后等距采样显示，计数与内容量仍按全量事件计算。
  const sample = (times: number[], cap: number) => {
    if (times.length <= cap) return { values: times, sampled: false };
    const step = Math.ceil(times.length / cap);
    const values = times.filter((_, position) => position % step === 0);
    if (values.at(-1) !== times.at(-1)) values.push(times.at(-1)!);
    return { values, sampled: true };
  };
  for (const [videoId, rows] of groups(contentEvents, event => event.video_id)) {
    const rowOf = (event: RawEvent) => {
      const row = index.get(pathOf(event.request_url));
      return row && row.video_id === videoId && row.manifest_available === 1 ? row : null;
    };
    const definitions = new Set<number>();
    let maxEnd = 0;
    for (const event of rows) { const row = rowOf(event); if (row) { definitions.add(row.total_segments); maxEnd = Math.max(maxEnd, row.media_end_s); } }
    for (const event of rows) if (acquired(event) && !rowOf(event)) unmappedAcquired++;
    const segments = rows.filter(event => acquired(event) && rowOf(event))
      .map(event => { const row = rowOf(event)!; return { t: event.event_time_ms, s: row.media_start_s, e: row.media_end_s }; })
      .sort((a, b) => a.t - b.t);
    const ordered = rows.slice().sort((a, b) => a.event_time_ms - b.event_time_ms || (a.native_sequence ?? 0) - (b.native_sequence ?? 0));
    // 随游标推进的累计序列：请求次数与去重内容秒数（区间并集，重复分片不重复计数）。
    let union: [number, number][] = [];
    let secondsSoFar = 0;
    let segIndex = 0;
    const progress: ReplayProgress[] = [];
    const step = Math.max(1, Math.ceil(ordered.length / 400));
    ordered.forEach((event, position) => {
      while (segIndex < segments.length && segments[segIndex].t <= event.event_time_ms) {
        const segment = segments[segIndex++];
        let start = segment.s, end = segment.e;
        const merged: [number, number][] = [];
        let kept = 0;
        for (const [s, e] of union) {
          if (e < start || s > end) { merged.push([s, e]); kept += e - s; }
          else { start = Math.min(start, s); end = Math.max(end, e); }
        }
        merged.push([start, end]);
        merged.sort((a, b) => a[0] - b[0]);
        union = merged;
        secondsSoFar = kept + (end - start);
      }
      if (position % step === 0 || position === ordered.length - 1) progress.push({ t: event.event_time_ms - t0, req: position + 1, sec: Math.round(secondsSoFar) });
    });
    const firstSeen = new Map<string, number>();
    for (const segment of segments) if (!firstSeen.has(`${segment.s}-${segment.e}`)) firstSeen.set(`${segment.s}-${segment.e}`, segment.t);
    gapTimes.push(...firstSeen.values());
    const sampledPoints = sample(ordered.map(event => event.event_time_ms - t0), 800);
    const sampledFailed = sample(ordered.filter(event => failedAttempt(event)).map(event => event.event_time_ms - t0), 400);
    sampledDisplay = sampledDisplay || sampledPoints.sampled || sampledFailed.sampled;
    courses.push({
      videoId,
      totalSegments: definitions.size === 1 ? [...definitions][0] : null,
      coveredSegments: new Set(segments.map(segment => `${segment.s}-${segment.e}`)).size,
      totalSeconds: maxEnd || null,
      dedupSeconds: intervalUnion(segments.map(segment => [segment.s, segment.e] as [number, number])),
      strictlyIncreasing: segmentOrder(segments),
      firstT: ordered.length ? ordered[0].event_time_ms - t0 : null,
      lastT: ordered.length ? ordered.at(-1)!.event_time_ms - t0 : null,
      points: sampledPoints.values,
      failedPoints: sampledFailed.values,
      progress,
      sampled: sampledPoints.sampled || sampledFailed.sampled,
    });
  }
  // Interval statistics use the first acquisition time per distinct segment, so a segment's
  // validation + CDN response do not halve the observed request rhythm.
  const gapSource = gapTimes.sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < gapSource.length; i++) gaps.push(gapSource[i] - gapSource[i - 1]);
  const medianGapMs = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
  const gapCv = gaps.length && medianGapMs ? Math.sqrt(gaps.reduce((sum, gap) => sum + (gap - medianGapMs) ** 2, 0) / gaps.length) / medianGapMs : null;
  const dedupSeconds = courses.reduce((sum, course) => sum + course.dedupSeconds, 0);
  const totalSegments = courses.reduce((sum, course) => sum + (course.totalSegments || 0), 0);
  const coveredSegments = courses.reduce((sum, course) => sum + course.coveredSegments, 0);
  if (unmappedAcquired) limitations.push(`${unmappedAcquired.toLocaleString('zh-CN')} 次成功响应缺少可映射的媒体分片，未计入内容统计`);
  if (mine.some(event => event.sampling_rate !== null && (event.sampling_rate !== 1 || event.sampling_method !== 'CENSUS'))) limitations.push('窗口内含采样事件，统计仅覆盖已采集部分');
  if (sampledDisplay) limitations.push('轨迹上的请求点做了等距采样显示，计数与内容量不受影响');
  const strictlyIncreasing = courses.length ? courses.every(course => course.strictlyIncreasing !== false) : null;

  // Environment track: trusted IP + normalized client class, exactly like the rule engine's environment().
  const trusted = (event: RawEvent) => {
    const category = clientClass(event);
    return !!(category && event.request_ip && isIP(event.request_ip) && ['TRUSTED_REQUEST', 'DIRECT_CLIENT'].includes(event.ip_basis || ''));
  };
  const unknownEvents = mine.filter(event => !trusted(event)).length;
  const environments = [...groups(mine.filter(trusted), event => JSON.stringify([event.request_ip, clientClass(event)]))]
    .map(([, rows]) => {
      const ip = rows[0].request_ip!, category = clientClass(rows[0])!, ua = rows.find(event => event.user_agent)?.user_agent || null;
      const device = CATEGORY_LABEL[category] || category;
      const label = category === 'TOOL' ? `${ip} · 工具程序` : `${ip} · ${device}${ua && browserLabel(ua) ? ' ' + browserLabel(ua) : ''}`;
      const sampledEnv = sample(rows.map(event => event.event_time_ms - t0).sort((a, b) => a - b), 2000);
      sampledDisplay = sampledDisplay || sampledEnv.sampled;
      const points = sampledEnv.values;
      return { ip, category, label, ua, points, firstT: points[0], lastT: points.at(-1)!, count: rows.length };
    })
    .sort((a, b) => a.firstT - b.firstT);
  const merged = mine.filter(trusted)
    .map(event => ({ t: event.event_time_ms, key: `${event.request_ip}|${clientClass(event)}` }))
    .sort((a, b) => a.t - b.t);
  let switches = 0;
  for (let i = 1; i < merged.length; i++) if (merged[i].key !== merged[i - 1].key) switches++;
  const toolUa = mine.map(event => event.user_agent?.match(TOOL_PATTERN)?.[0]).find(Boolean) || null;

  const basis = mine.length && mine.every(event => event.sampling_rate === 1 && event.sampling_method === 'CENSUS')
    ? '去重内容按分片映射与 CDN 完整响应（HTTP 200/206 且有响应体）统计；事件为全量采集（CENSUS）'
    : '去重内容按分片映射与 CDN 完整响应统计；窗口含采样数据或无事件，统计仅覆盖已采集部分';

  const base: Omit<ReplayTimeline, 'sidebar'> = {
    windowStart: input.windowStart, windowEnd: input.windowEnd, windowMs: span, windowSeconds: span / 1000,
    ruleId: input.ruleId, ruleName: input.ruleName, scenario: input.scenario, tier: input.tier,
    subject, scopeNote: `按告警主体（${SUBJECT_LABEL[subject.kind] || subject.kind}）与窗口内客户端请求过滤；授权轨迹包含窗口前签发、仍在有效期内的凭证`,
    content: {
      basis, requests: contentEvents.length, dedupSeconds,
      speedRatio: dedupSeconds > 0 ? dedupSeconds / (span / 1000) : null,
      coverageRatio: totalSegments > 0 ? coveredSegments / totalSegments : null,
      strictlyIncreasing, medianGapMs, gapCv,
      activeMinutes: contentEvents.length ? new Set(contentEvents.map(event => Math.floor(event.event_time_ms / 60000))).size : null,
      courses: courses.sort((a, b) => (a.firstT ?? 0) - (b.firstT ?? 0)),
    },
    auth: { tokens, events: authEvents },
    env: { environments, toolUa, switches, unknownEvents },
    limitations,
  };
  return { ...base, sidebar: sidebars(input, base) };
}
