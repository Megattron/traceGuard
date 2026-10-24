import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBusinessPolicy, configuredBusinessPolicy } from '../server/business-policy.ts';
import { Store } from '../server/store.ts';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const policy = {
  tenantId: '980107c0ab', version: 'BP-980107c0ab-v1', effectiveFrom: '2026-10-23T00:00:00+08:00',
  downloadAllowed: false, prefetchAllowed: false, accountSharingAllowed: false, keyCacheTtlSeconds: 300,
  renewal: { allowed: true, initiatedBy: 'same_viewer' as const, preserveScope: true, snapshotRequired: true },
};
const feature = (ruleId: 'R1' | 'R2' | 'R3' | 'R4B', reason: string, anomalyScore: number) => ({
  ruleId, reason, anomalyScore, suspicionScore: null, businessPolicyVersion: undefined,
});

test('verified tenant policy admits qualifying R1, R2, and R4B evidence into suspicion score', () => {
  const cases = [
    [feature('R1', 'BUSINESS_CACHE_POLICY_UNVERIFIED', 25), 25],
    [feature('R2', 'BUSINESS_DOWNLOAD_POLICY_UNVERIFIED', 50), 50],
    [feature('R4B', 'BUSINESS_SHARING_POLICY_UNVERIFIED', 50), 50],
  ] as const;
  for (const [input, expected] of cases) {
    const result = applyBusinessPolicy(input, policy, '2026-10-23 12:00:00.000');
    assert.equal(result.suspicionScore, expected);
    assert.equal(result.reason, '');
    assert.equal(result.businessPolicyVersion, policy.version);
  }
});

test('unverified, not-yet-effective, and unrelated rule features keep their prior score state', () => {
  const input = feature('R4B', 'BUSINESS_SHARING_POLICY_UNVERIFIED', 50);
  assert.equal(applyBusinessPolicy(input, null, '2026-10-23 12:00:00.000').suspicionScore, null);
  assert.equal(applyBusinessPolicy(input, policy, '2026-10-22 12:00:00.000').suspicionScore, null);
  assert.equal(applyBusinessPolicy(feature('R3', 'BUSINESS_SHARING_POLICY_UNVERIFIED', 50), policy, '2026-10-23 12:00:00.000').suspicionScore, null);
});

test('download and sharing rules stay blocked if the tenant policy allows them', () => {
  const permissive = { ...policy, downloadAllowed: true, accountSharingAllowed: true };
  assert.equal(applyBusinessPolicy(feature('R2', 'BUSINESS_DOWNLOAD_POLICY_UNVERIFIED', 50), permissive, '2026-10-23 12:00:00.000').suspicionScore, null);
  assert.equal(applyBusinessPolicy(feature('R4B', 'BUSINESS_SHARING_POLICY_UNVERIFIED', 50), permissive, '2026-10-23 12:00:00.000').suspicionScore, null);
});

test('customer configuration is scoped and upgrades persist with history',()=>{
  const configured=configuredBusinessPolicy('980107c0ab')!;
  assert.equal(configured.version,'BP-980107c0ab-v2');assert.equal(configured.downloadAllowed,false);assert.equal(configured.prefetchAllowed,false);assert.equal(configured.accountSharingAllowed,false);
  assert.equal(configured.keyCacheTtlSeconds,300);assert.deepEqual(configured.renewal,{allowed:true,initiatedBy:'same_viewer',preserveScope:true,snapshotRequired:true});
  assert.equal(configuredBusinessPolicy('unconfigured-tenant'),null);
  const dir=mkdtempSync(join(tmpdir(),'tg-policy-')),path=join(dir,'policy.sqlite');let store=new Store(path,'unconfigured-tenant');
  try {
    store.db.prepare('INSERT INTO business_policies(tenant_id,data) VALUES(?,?)').run(policy.tenantId,JSON.stringify(policy));store.close();
    store=new Store(path,policy.tenantId);assert.deepEqual(store.businessPolicy(policy.tenantId),configured);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM business_policy_history WHERE tenant_id=?').get(policy.tenantId)!.n,2);
    store.close();store=new Store(path,policy.tenantId);assert.equal(store.businessPolicy(policy.tenantId)!.version,configured.version);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('R1 does not gain suspicion from undefined cache lifetime or scope-expanding renewal',()=>{
  const input=feature('R1','BUSINESS_CACHE_POLICY_UNVERIFIED',25);
  assert.equal(applyBusinessPolicy(input,{...policy,keyCacheTtlSeconds:0},'2026-10-23 12:00:00.000').suspicionScore,null);
  assert.equal(applyBusinessPolicy(input,{...policy,renewal:{...policy.renewal,preserveScope:false}},'2026-10-23 12:00:00.000').suspicionScore,null);
  assert.equal(applyBusinessPolicy(input,{...policy,renewal:{...policy.renewal,snapshotRequired:false}},'2026-10-23 12:00:00.000').suspicionScore,null);
  assert.equal(applyBusinessPolicy(input,policy,'invalid').suspicionScore,null);
});
