export type SourceMode = 'demo' | 'clickhouse';
export type ReviewStatus = '待复核' | '复核中' | '观察中' | '已确认' | '已误报';
export const REVIEW_STATUSES: ReviewStatus[] = ['待复核', '复核中', '观察中', '已确认', '已误报'];
export const SCENARIOS = ['failure_burst', 'normal', 'unknown_inputs', 'rapid_pull', 'client_tool', 'sustained_access', 'token_shared', 'scope_violation', 'missing_chain'] as const;
export type Scenario = typeof SCENARIOS[number];
export type RuleId = 'R1' | 'R2' | 'R3' | 'R4A' | 'R4B' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10';
export interface Condition { field: string; op: '>=' | '<='; value: number }
export interface RuleConfiguration {
  id: RuleId; revision: number; version: string; enabled: boolean;
  parameters: Record<string, number>;
  tiers: { label: string; score: number; conditions: Condition[]; alternatives?: Condition[][] }[];
}

export interface BusinessPolicy {
  tenantId: string;
  version: string;
  effectiveFrom: string;
  downloadAllowed: boolean;
  prefetchAllowed: boolean;
  accountSharingAllowed: boolean;
  keyCacheTtlSeconds: number;
  renewal: { allowed: boolean; initiatedBy: 'same_viewer'; preserveScope: boolean; snapshotRequired: boolean };
}

export interface DetectionInput {
  scenario: Scenario;
  windowStart: string;
  windowEnd: string;
}

export interface Feature {
  subjectType?: 'VIEWER' | 'CREDENTIAL_VIEWER' | 'TOKEN' | 'VIDEO';
  subjectId?: string;
  relatedVideoIds?: string[];
  windowStart?: string;
  windowEnd?: string;
  evidenceRefs?: string[];
  limitations?: string[];
  ruleId?: RuleId;
  ruleName?: string;
  tier?: string;
  contextId?: string;
  actorId?: string;
  metrics?: Record<string, number | null>;
  configuration?: RuleConfiguration;
  businessPolicyVersion?: string;
  labelHit?: boolean;
  videoId: string;
  scenario: string;
  source: string;
  eventType: string;
  datasetKinds: string[];
  observed: number;
  passed: number;
  failed: number;
  unknown: number;
  known: number;
  failureRatio: number | null;
  anomalyScore: number | null;
  suspicionScore: number | null;
  computeStatus: 'AVAILABLE' | 'UNAVAILABLE';
  reason: string;
}

export interface DetectionRun {
  dataBatchId?: string;
  businessPolicy?: BusinessPolicy | null;
  configurations?: RuleConfiguration[];
  id: string;
  sourceMode: SourceMode;
  scenario: string;
  windowStart: string;
  windowEnd: string;
  ruleVersion: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number | null;
  features: Feature[];
  alertCount: number;
  error: string | null;
}

export interface Review {
  id: string;
  status: ReviewStatus;
  note: string;
  actor: string;
  createdAt: string;
  requestId: string;
}

export interface Alert {
  ruleId?: RuleId;
  ruleName?: string;
  id: string;
  runId: string;
  tenantId: string;
  sourceMode: SourceMode;
  videoId: string;
  scenario: string;
  source: string;
  eventType: string;
  windowStart: string;
  windowEnd: string;
  anomalyScore: number;
  suspicionScore: number | null;
  ruleVersion: string;
  sqlHash: string;
  feature: Feature;
  status: ReviewStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  reviews: Review[];
}

export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
