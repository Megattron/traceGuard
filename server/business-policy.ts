import type { BusinessPolicy, RuleId } from './types.ts';
import { readFileSync } from 'node:fs';

// Explicit per-customer configuration; never infer a restrictive policy for another tenant.
export function configuredBusinessPolicy(tenantId:string):BusinessPolicy|null {
  const policies:unknown=JSON.parse(readFileSync(new URL('../config/business-policies.json',import.meta.url),'utf8'));
  if(!Array.isArray(policies))throw new Error('业务策略配置必须是数组');
  const selected=policies.filter(p=>p?.tenantId===tenantId);
  if(!selected.length)return null;
  if(selected.length!==1)throw new Error('租户业务策略存在重复配置');
  const p=selected[0];
  if(typeof p.version!=='string'||!p.version||!Number.isFinite(Date.parse(p.effectiveFrom))
    ||[p.downloadAllowed,p.prefetchAllowed,p.accountSharingAllowed,p.renewal?.allowed,p.renewal?.preserveScope,p.renewal?.snapshotRequired].some(v=>typeof v!=='boolean')
    ||!Number.isInteger(p.keyCacheTtlSeconds)||p.keyCacheTtlSeconds<60||p.keyCacheTtlSeconds>3600||p.renewal.initiatedBy!=='same_viewer')throw new Error('租户业务策略字段或缓存有效期无效');
  return structuredClone(p) as BusinessPolicy;
}

type PolicyFeature = {
  ruleId?: RuleId;
  reason: string;
  anomalyScore: number | null;
  suspicionScore: number | null;
  businessPolicyVersion?: string;
};

export function applyBusinessPolicy<T extends PolicyFeature>(feature: T, policy: BusinessPolicy | null, windowStart: string): T {
  const start=Date.parse(windowStart.replace(' ', 'T') + '+08:00'), effective=policy?Date.parse(policy.effectiveFrom):NaN;
  if (!policy || !Number.isFinite(start) || !Number.isFinite(effective) || start < effective) return feature;
  const cacheDefined=Number.isInteger(policy.keyCacheTtlSeconds)&&policy.keyCacheTtlSeconds>=60&&policy.keyCacheTtlSeconds<=3600
    &&(!policy.renewal.allowed||policy.renewal.initiatedBy==='same_viewer'&&policy.renewal.preserveScope&&policy.renewal.snapshotRequired);
  const admitted = feature.ruleId === 'R1' && feature.reason === 'BUSINESS_CACHE_POLICY_UNVERIFIED' && cacheDefined
    || feature.ruleId === 'R2' && feature.reason === 'BUSINESS_DOWNLOAD_POLICY_UNVERIFIED' && !policy.downloadAllowed && !policy.prefetchAllowed
    || feature.ruleId === 'R4B' && feature.reason === 'BUSINESS_SHARING_POLICY_UNVERIFIED' && !policy.accountSharingAllowed;
  if (!admitted || feature.anomalyScore === null || feature.anomalyScore <= 0) return feature;
  return { ...feature, reason: '', suspicionScore: feature.anomalyScore, businessPolicyVersion: policy.version } as T;
}
