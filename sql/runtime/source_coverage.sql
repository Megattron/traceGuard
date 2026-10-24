SELECT event_type, coverage_start, coverage_end, is_complete, sampling_rate, sampling_method,
  requires_token, requires_manifest, requires_key, key_validity_seconds, protocol_version
FROM {database:Identifier}.tg_validation_source_coverage FINAL
WHERE run_id = {run_id:String} AND user_id = {tenant_id:String}
  AND scenario_id = {scenario_id:String}
  AND dataset_kind = 'SYNTHETIC'
