import { AppError, type Feature } from './types.ts';

export const RULE_VERSION = 'R7-v0.2.1';
export const RULE = {
  id: 'R7', version: RULE_VERSION, name: '视频鉴权失败异常', windowSeconds: 600,
  eventType: 'TS_VALIDATE', minimumKnownResults: 100,
  tiers: [
    { label: '一般', score: 10, minimumFailures: 30, minimumRatio: 0.2 },
    { label: '注意', score: 25, minimumFailures: 100, minimumRatio: 0.5 },
    { label: '高危险', score: 50, minimumFailures: 300, minimumRatio: 0.8 },
  ],
  note: 'R7 反映视频访问异常，仅计入异常分 A；盗版嫌疑分 S 固定为 0。阈值为候选口径，尚未完成生产校准。',
};

export function evaluateR7(passed: number, failed: number, unknown: number, videoId = 'video') {
  for (const value of [passed, failed, unknown]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new AppError(502, 'INVALID_FEATURE', '上游特征计数无效');
  }
  const known = passed + failed;
  const failureRatio = known ? failed / known : null;
  if (!videoId || known < 100) return {
    known, failureRatio, anomalyScore: null, suspicionScore: null,
    computeStatus: 'UNAVAILABLE' as const,
    reason: !videoId ? 'MISSING_VIDEO_MAPPING' : known === 0 ? 'NO_KNOWN_RESULTS' : 'INSUFFICIENT_KNOWN_RESULTS',
  };
  const anomalyScore = failed >= 300 && failureRatio! >= 0.8 ? 50
    : failed >= 100 && failureRatio! >= 0.5 ? 25
      : failed >= 30 && failureRatio! >= 0.2 ? 10 : 0;
  return { known, failureRatio, anomalyScore, suspicionScore: 0, computeStatus: 'AVAILABLE' as const, reason: '' };
}

export function validateFeature(row: Record<string, unknown>): Feature {
  const passed = Number(row.passed), failed = Number(row.failed), unknown = Number(row.unknown);
  const videoId = String(row.video_id ?? '');
  const evaluated = evaluateR7(passed, failed, unknown, videoId);
  const ratioValid = row.failure_ratio === null ? evaluated.failureRatio === null
    : typeof row.failure_ratio === 'number' && Number.isFinite(row.failure_ratio)
      && evaluated.failureRatio !== null && Math.abs(row.failure_ratio - evaluated.failureRatio) <= 1e-10;
  if (Number(row.observed) !== passed + failed + unknown || Number(row.known) !== evaluated.known
    || row.anomaly_score !== evaluated.anomalyScore || !ratioValid) {
    throw new AppError(502, 'INVALID_FEATURE', '上游特征与 R7 计分契约不一致');
  }
  return {
    videoId, scenario: String(row.scenario_id), source: String(row.source), eventType: String(row.event_type),
    datasetKinds: Array.isArray(row.dataset_kinds) ? row.dataset_kinds.map(String) : [],
    observed: passed + failed + unknown, passed, failed, unknown, ...evaluated,
  };
}
