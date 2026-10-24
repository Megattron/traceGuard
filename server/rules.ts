import { AppError, type Feature, type RuleConfiguration, type RuleId } from './types.ts';

export interface FieldDefinition { key: string; label: string; unit: string; max: number; integer?: boolean }
export interface RuleDefinition {
  id: string; name: string; supported: boolean; reason: string; description: string; window: string;
  kind: '主要' | '辅助' | '标签'; maxScore: number; prerequisite: string;
  fields: FieldDefinition[]; parameters: FieldDefinition[]; defaults?: RuleConfiguration;
}
const field = (key: string, label: string, unit = '', max = 1e9, integer = false): FieldDefinition => ({ key, label, unit, max, integer });
const defaults = (id: RuleId, enabled: boolean, parameters: Record<string, number>, fields: string[], ops: ('>=' | '<=')[], values: number[][], scores: number[]): RuleConfiguration => ({
  id, enabled, parameters, revision: 1, version: `${id}-v0.2.1`,
  tiers: scores.map((score, i) => ({ label: (id === 'R1' ? ['注意', '高危险'] : ['一般', '注意', ['R5', 'R6', 'R8', 'R10'].includes(id) ? '高档' : '高危险'])[i], score,
    conditions: fields.map((key, j) => ({ field: key, op: ops[j], value: values[i][j] })) })),
});
export const CATALOG: RuleDefinition[] = [
  { id: 'R1', name: '授权链路异常', supported: true, reason: '', description: '在同一视频及会话内，统计必要授权步骤缺失后获准访问的唯一分片。', window: '10 分钟 · 中高档', kind: '主要', maxScore: 50,
    prerequisite: '已接注意、高危险两档；一般档缺协议顺序模型，暂不计算。检查有效 token、历史密钥和来源覆盖；合法缓存策略未核验时 S 为数据不足。',
    fields: [field('missingOneSegments', '缺必要步骤的唯一分片', '片', 1e7, true), field('missingTokenKeySegments', '同时缺有效授权和密钥的唯一分片', '片', 1e7, true)], parameters: [],
    defaults: defaults('R1', false, {}, ['missingOneSegments'], ['>='], [[30], [100]], [25, 50]) },
  { id: 'R2', name: '高速拉片', supported: true, reason: '', description: '按认证观众及视频局部，计算鉴权通过的去重内容时长和固定窗口倍率。', window: '10 分钟', kind: '主要', maxScore: 50,
    prerequisite: '要求可靠身份、完整媒体映射、全量 TS 来源覆盖。当前计算访问异常 A；合法下载/预取尚未核验时，S 保持数据不足。',
    fields: [field('contentSeconds', '去重内容时长', '秒'), field('speedRatio', '拉取倍率', '倍', 10000)], parameters: [],
    defaults: defaults('R2', false, {}, ['contentSeconds', 'speedRatio'], ['>=', '>='], [[1800, 3], [1800, 5], [1800, 10]], [10, 25, 50]) },
  { id: 'R3', name: '同时多视频播放', supported: true, reason: '', description: '可信播放状态形成有效区间，寻找同一组视频持续重叠的最大数量。', window: '5 分钟', kind: '主要', maxScore: 50,
    prerequisite: '仅使用可信、未过期且会话关联明确的播放状态；请求数量不代替播放并发。合法多路播放策略未核验时只展示异常 A，S 为数据不足。',
    fields: [field('concurrentVideos', '持续并发视频数', '个', 10000, true)], parameters: [field('minimumOverlapSeconds', '最小连续重叠', '秒', 300, true)],
    defaults: defaults('R3', false, { minimumOverlapSeconds: 60 }, ['concurrentVideos'], ['>='], [[2], [3], [4]], [10, 25, 50]) },
  { id: 'R4A', name: '跨授权范围复用', supported: true, reason: '', description: '按事件时点选择授权快照，按请求与阶段去重，评分原生主体为 token。', window: '30 分钟', kind: '主要', maxScore: 50,
    prerequisite: '低中档要求范围外尝试全部未获准；任一范围外获准或有字节响应进入高档。缺少或冲突的授权历史不可判定，不把 token 分复制给所有关联视频或绑定观众。',
    fields: [field('outsideAttempts', '范围外请求数', '次', 1e9, true), field('outsideVideos', '范围外视频数', '个', 1e7, true), field('outsideSuccesses', '范围外获准或响应数', '次', 1e9, true)], parameters: [],
    defaults: defaults('R4A', false, {}, ['outsideAttempts', 'outsideVideos', 'outsideSuccesses'], ['>=', '>=', '<='], [[10, 2, 0], [30, 5, 0], [1, 1, 0]], [10, 25, 50]) },
  { id: 'R4B', name: '同 token 多环境使用', supported: true, reason: '', description: '仅比较有效 token 的客户端通过记录，在同一环境对内联合核对交错、跨度和通过次数。', window: '10 分钟', kind: '主要', maxScore: 50,
    prerequisite: '按可信 IP 和客户端类别区分环境；未知环境不算设备。高档同时要求 IP 与客户端类别不同，双方在交错区间达到次数下限；合法共享策略未核验时 S 为数据不足。',
    fields: [field('generalEnvironments', '达到一般档次数的环境', '个', 10000, true), field('attentionEnvironments', '达到注意档次数的环境', '个', 10000, true), field('attentionPairs', '满足注意档交错的环境对', '对', 1e7, true), field('highPairs', '满足高档交错的环境对', '对', 1e7, true)],
    parameters: [field('generalPasses', '一般档每环境通过数', '次', 1e7, true), field('attentionPasses', '注意档每环境通过数', '次', 1e7, true), field('highPasses', '高档每环境通过数', '次', 1e7, true), field('interleaveSeconds', '最小交错跨度', '秒', 600, true)],
    defaults: defaults('R4B', false, { generalPasses: 2, attentionPasses: 5, highPasses: 10, interleaveSeconds: 60 }, ['generalEnvironments'], ['>='], [[2], [3], [1]], [10, 25, 50]) },
  { id: 'R5', name: '设备与网络环境变化', supported: true, reason: '', description: '一小时内按认证观众统计可信 IP 和归一化客户端类别，排除后端及已知代理。', window: '1 小时', kind: '辅助', maxScore: 15,
    prerequisite: '有效客户端事件达到配置下限。IP/UA 只表示环境，不能证明物理设备数；当前单规则告警不汇总，不与 R4B 重复累计主体分。',
    fields: [field('ipCount', '可信 IP 数', '个', 1e7, true), field('uaCount', '客户端类别数', '类', 1000, true)], parameters: [field('minimumEvents', '最小有效事件数', '条', 1e7, true)],
    defaults: defaults('R5', false, { minimumEvents: 20 }, ['ipCount', 'uaCount'], ['>=', '>='], [[3, 2], [5, 3], [8, 4]], [5, 10, 15]) },
  { id: 'R6', name: '分片机械访问', supported: true, reason: '', description: '同一观众、视频、会话及媒体序列内，计算覆盖率、递增比例和请求间隔 CV。', window: '10 分钟', kind: '辅助', maxScore: 15,
    prerequisite: '要求完整清单、全量来源、至少三个有确定先后的请求；不同会话、清晰度和轨道不拼接。只计异常 A，尚未建立同活动主要证据关联时 S 为 0。',
    fields: [field('uniqueSegments', '唯一分片数', '片', 1e7, true), field('coverage', '分片覆盖率', '%', 1), field('monotonic', '递增比例', '%', 1), field('intervalCv', '间隔 CV', '', 10000)], parameters: [],
    defaults: defaults('R6', false, {}, ['uniqueSegments', 'coverage', 'monotonic', 'intervalCv'], ['>=', '>=', '>=', '<='], [[30, .5, .9, .5], [30, .8, .95, .2], [30, .95, .99, .1]], [5, 10, 15]) },
  { id: 'R7', name: '视频鉴权失败异常', supported: true, reason: '', description: '同一视频、同一 TS 鉴权来源，分别统计 PASS、FAIL 和 UNKNOWN。', window: '10 分钟', kind: '主要', maxScore: 50,
    prerequisite: '已知结果数达到配置下限；UNKNOWN 不视为失败。R7 只计异常分 A，S 固定为 0。',
    fields: [field('failed', '失败事件数', '条', 1e9, true), field('failureRatio', '失败率', '%', 1)], parameters: [field('minimumKnownResults', '最小已知样本', '条', 1e7, true)],
    defaults: defaults('R7', true, { minimumKnownResults: 100 }, ['failed', 'failureRatio'], ['>=', '>='], [[30, .2], [100, .5], [300, .8]], [10, 25, 50]) },
  { id: 'R8', name: '长时间高强度访问', supported: true, reason: '', description: '完整 24 小时内按认证观众、单一来源统计活跃分钟及跨视频去重内容时长。', window: '24 小时', kind: '辅助', maxScore: 15,
    prerequisite: '窗口与来源覆盖完整、媒体映射唯一；同内容跨重试、轨道和清晰度按时间轴去重。不把 24 小时的十分钟评分相加。只计异常 A，S 暂为 0。',
    fields: [field('activeMinutes', '活跃分钟', '分钟', 1440, true), field('contentSeconds', '去重内容时长', '秒')], parameters: [],
    defaults: defaults('R8', false, {}, ['activeMinutes', 'contentSeconds'], ['>=', '>='], [[480, 28800], [720, 43200], [960, 57600]], [5, 10, 15]) },
  { id: 'R9', name: '夜间访问标签', supported: true, reason: '', description: '按北京时间和本规则版本的夜间起止小时，标记窗口内夜间访问。', window: '事件级 / 10 分钟汇总', kind: '标签', maxScore: 0,
    prerequisite: '仅为可解释上下文，始终 0 分，不生成风险告警。规则配置的时段作为应用版本保存，不修改原始业务配置表。',
    fields: [field('nightEvents', '夜间事件', '条', 1e9, true)], parameters: [field('nightStartHour', '夜间起点', '时', 23, true), field('nightEndHour', '夜间终点', '时', 24, true)],
    defaults: defaults('R9', false, { nightStartHour: 2, nightEndHour: 6 }, [], [], [], []) },
  { id: 'R10', name: '脚本或工具特征', supported: true, reason: '', description: '在同一会话、同一工具签名内统计工具请求与请求阶段，排除后端签发和已知合法工具。', window: '10 分钟', kind: '辅助', maxScore: 15,
    prerequisite: '同工具签名分组；鉴权和响应按请求关联及阶段规范去重。只计异常 A，缺同活动主要证据时 S 为 0。',
    fields: [field('toolRequests', '工具请求数', '条', 1e9, true), field('toolStages', '工具阶段数', '类', 3, true)], parameters: [],
    defaults: defaults('R10', false, {}, ['toolRequests', 'toolStages'], ['>=', '>='], [[1, 1], [20, 2], [100, 3]], [5, 10, 15]) },
];

// These branches express distinct evidence, so they are not forced into one AND tree.
CATALOG[0].defaults!.tiers[1].conditions = [{ field: 'missingTokenKeySegments', op: '>=', value: 100 }];
const scopeTiers = CATALOG.find(r => r.id === 'R4A')!.defaults!.tiers;
scopeTiers[2].conditions = [{ field: 'outsideSuccesses', op: '>=', value: 1 }];
const environmentTiers = CATALOG.find(r => r.id === 'R4B')!.defaults!.tiers;
environmentTiers[1].conditions = [{ field: 'attentionEnvironments', op: '>=', value: 3 }];
environmentTiers[1].alternatives = [[{ field: 'attentionPairs', op: '>=', value: 1 }]];
environmentTiers[2].conditions = [{ field: 'highPairs', op: '>=', value: 1 }];

export const WINDOW_MINUTES: Record<RuleId, number> = { R1: 10, R2: 10, R3: 5, R4A: 30, R4B: 10, R5: 60, R6: 10, R7: 10, R8: 1440, R9: 10, R10: 10 };
export const conditionGroups = (tier: RuleConfiguration['tiers'][number]) => [tier.conditions, ...(tier.alternatives || [])];

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function definition(id: string) {
  const result = CATALOG.find(r => r.id === id);
  if (!result) throw new AppError(404, 'RULE_NOT_FOUND', '规则不存在');
  return result;
}
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function validateConfiguration(id: string, body: unknown): RuleConfiguration {
  const def = definition(id);
  if (!def.supported || !def.defaults) throw new AppError(400, 'RULE_NOT_SUPPORTED', def.reason);
  if (!plain(body) || body.id !== id || typeof body.enabled !== 'boolean' || !plain(body.parameters) || !Array.isArray(body.tiers)) throw new AppError(400, 'INVALID_RULE', '规则配置格式无效');
  if (Object.keys(body).some(k => !['id', 'enabled', 'parameters', 'tiers', 'revision', 'version'].includes(k))) throw new AppError(400, 'INVALID_RULE', '存在未支持的规则字段');
  const validNumber = (value: unknown, field: FieldDefinition) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= field.max && (!field.integer || Number.isInteger(value));
  const parameters: Record<string, number> = {};
  if (Object.keys(body.parameters).length !== def.parameters.length) throw new AppError(400, 'INVALID_RULE', '规则前提参数不完整');
  for (const f of def.parameters) {
    if (!validNumber(body.parameters[f.key], f)) throw new AppError(400, 'INVALID_RULE', `${f.label}无效`);
    parameters[f.key] = body.parameters[f.key] as number;
  }
  if (id === 'R7' && parameters.minimumKnownResults < 1) throw new AppError(400, 'INVALID_RULE', '最小已知样本必须至少为 1');
  if (def.parameters.some(f => id !== 'R9' && parameters[f.key] < 1)) throw new AppError(400, 'INVALID_RULE', '前提参数必须至少为 1');
  if (id === 'R4B' && (parameters.generalPasses > parameters.attentionPasses || parameters.attentionPasses > parameters.highPasses)) throw new AppError(400, 'INVALID_RULE', '各档每环境通过数必须递增');
  if (id === 'R9' && parameters.nightStartHour === parameters.nightEndHour) throw new AppError(400, 'INVALID_RULE', '夜间起止时刻不能相同');
  if (body.tiers.length !== def.defaults.tiers.length) throw new AppError(400, 'INVALID_RULE', '规则档位数量无效');
  const tiers = body.tiers.map((tier: unknown, i: number) => {
    const template = def.defaults!.tiers[i];
    if (!plain(tier) || Object.keys(tier).some(k => !['label', 'score', 'conditions', 'alternatives'].includes(k)) || !Number.isInteger(tier.score) || Number(tier.score) < 1 || Number(tier.score) > def.maxScore || !Array.isArray(tier.conditions) || tier.conditions.length !== template.conditions.length) throw new AppError(400, 'INVALID_RULE', `第 ${i + 1} 档格式或分值无效`);
    if (template.alternatives ? !Array.isArray(tier.alternatives) || tier.alternatives.length !== template.alternatives.length : tier.alternatives !== undefined) throw new AppError(400, 'INVALID_RULE', '规则分支结构无效');
    const parseGroup = (group: unknown, expectedGroup: typeof template.conditions) => {
      if (!Array.isArray(group) || group.length !== expectedGroup.length) throw new AppError(400, 'INVALID_RULE', '规则分支条件不完整');
      return group.map((condition: unknown, j: number) => {
      const expected = expectedGroup[j]; const f = def.fields.find(f => f.key === expected.field)!;
      if (!plain(condition) || Object.keys(condition).some(k => !['field', 'op', 'value'].includes(k)) || condition.field !== expected.field || condition.op !== expected.op || !validNumber(condition.value, f)) throw new AppError(400, 'INVALID_RULE', `${f.label}条件无效，字段和操作符由服务端固定`);
      if (['R1', 'R3', 'R4A', 'R4B'].includes(id) && expected.op === '>=' && Number(condition.value) < 1) throw new AppError(400, 'INVALID_RULE', '证据数量阈值不能小于 1');
      if (id === 'R3' && Number(condition.value) < 2) throw new AppError(400, 'INVALID_RULE', '多视频并发阈值不能小于 2');
      if (id === 'R4A' && expected.op === '<=' && condition.value !== 0) throw new AppError(400, 'INVALID_RULE', '低中档仅适用于全部未获准的范围外尝试');
      return { field: expected.field, op: expected.op, value: condition.value as number };
      });
    };
    return { label: template.label, score: tier.score as number, conditions: parseGroup(tier.conditions, template.conditions),
      ...(template.alternatives ? { alternatives: template.alternatives.map((g, j) => parseGroup((tier.alternatives as unknown[])[j], g)) } : {}) };
  });
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].score < tiers[i - 1].score) throw new AppError(400, 'INVALID_RULE', '高档分值不能低于低档');
    for (let j = 0; j < tiers[i].conditions.length; j++) {
      const current = tiers[i].conditions[j], previous = tiers[i - 1].conditions[j];
      if (!previous || current.field !== previous.field || current.op !== previous.op) continue;
      if (current.op === '>=' ? current.value < previous.value : current.value > previous.value) throw new AppError(400, 'INVALID_RULE', '高档条件必须至少与低档同样严格');
    }
  }
  return { id: id as RuleId, revision: 0, version: '', enabled: body.enabled, parameters, tiers };
}

export function evaluateConfigured(config: RuleConfiguration, metrics: Record<string, number | null>) {
  const unavailable = (reason: string) => ({ anomalyScore: null, suspicionScore: null, computeStatus: 'UNAVAILABLE' as const, reason, tier: '数据不足', labelHit: false });
  if (!config.enabled) return unavailable('RULE_DISABLED');
  if (config.id === 'R7' && (metrics.known ?? 0) < config.parameters.minimumKnownResults) return unavailable('INSUFFICIENT_KNOWN_RESULTS');
  if (config.id === 'R9') {
    if (!Number.isSafeInteger(metrics.nightEvents) || metrics.nightEvents! < 0) return unavailable('MISSING_NIGHT_EVENTS');
    return { anomalyScore: 0, suspicionScore: 0, computeStatus: 'AVAILABLE' as const, reason: '', tier: metrics.nightEvents! > 0 ? '夜间标签' : '未命中', labelHit: metrics.nightEvents! > 0 };
  }
  const conditionState = (c: typeof config.tiers[number]['conditions'][number]) => typeof metrics[c.field] !== 'number' || !Number.isFinite(metrics[c.field]) ? null : c.op === '>=' ? metrics[c.field]! >= c.value : metrics[c.field]! <= c.value;
  let score = 0, label = '未命中';
  let unknownHigher = false;
  for (const tier of config.tiers) {
    const groups = conditionGroups(tier).map(group => group.map(conditionState));
    if (groups.some(g => g.every(s => s === true))) { score = tier.score; label = tier.label; unknownHigher = false; }
    else if (groups.some(g => !g.includes(false) && g.includes(null))) unknownHigher = true;
  }
  if (unknownHigher) return unavailable('MISSING_REQUIRED_FEATURE');
  const reason = score > 0 ? ({ R1: 'BUSINESS_CACHE_POLICY_UNVERIFIED', R2: 'BUSINESS_DOWNLOAD_POLICY_UNVERIFIED', R3: 'BUSINESS_SHARING_POLICY_UNVERIFIED', R4B: 'BUSINESS_SHARING_POLICY_UNVERIFIED' } as Record<string, string>)[config.id] || '' : '';
  return { anomalyScore: score, suspicionScore: reason ? null : config.id === 'R4A' ? score : 0, computeStatus: 'AVAILABLE' as const,
    reason, tier: label, labelHit: false };
}
export function applyConfiguration(feature: Feature, config: RuleConfiguration): Feature {
  const metrics = feature.metrics || { passed: feature.passed, failed: feature.failed, unknown: feature.unknown, known: feature.known, failureRatio: feature.failureRatio };
  const evaluated = evaluateConfigured(config, metrics);
  const guardFailed = config.id !== 'R7' && feature.computeStatus === 'UNAVAILABLE';
  const absentVideo = !feature.videoId && !feature.subjectId;
  return { ...feature, ...evaluated,
    ...(guardFailed || absentVideo ? { anomalyScore: null, suspicionScore: null, computeStatus: 'UNAVAILABLE' as const, reason: absentVideo ? 'MISSING_VIDEO_MAPPING' : feature.reason, tier: '数据不足', labelHit: false } : {}),
    ruleId: config.id, ruleName: definition(config.id).name, metrics, configuration: clone(config),
  };
}
