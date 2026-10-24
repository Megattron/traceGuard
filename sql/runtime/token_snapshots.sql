SELECT token_ref, effective_at, expires_at, revoked, allowed_video_ids, original_issued_at, policy_version
FROM {database:Identifier}.tg_validation_token_snapshots FINAL
WHERE run_id = {run_id:String} AND user_id = {tenant_id:String}
  AND scenario_id = {scenario_id:String} AND dataset_kind = 'SYNTHETIC'
  AND effective_at < {window_end:DateTime64(3, 'Asia/Shanghai')}
