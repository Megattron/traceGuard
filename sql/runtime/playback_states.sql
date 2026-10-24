-- Include a valid pre-window state; expired states cannot establish an active interval.
SELECT event_id, video_id, source, event_type, dataset_kind, auth_result,
  viewer_id, credential_viewer_id, identity_basis, association_status,
  token_ref, session_ref, request_ref, request_url, user_agent, parse_status,
  sampling_rate, sampling_method, sampling_unit, native_sequence,
  request_ip, ip_basis, http_status, response_bytes, response_completed,
  key_valid_until, state, state_valid_until, trusted_state,
  toUnixTimestamp64Milli(event_time) AS event_time_ms
FROM {database:Identifier}.tg_validation_events
WHERE run_id = {run_id:String} AND user_id = {tenant_id:String}
  AND scenario_id = {scenario_id:String} AND dataset_kind = 'SYNTHETIC'
  AND event_type = 'PLAYBACK_STATE'
  AND event_time < {window_end:DateTime64(3, 'Asia/Shanghai')}
  AND (event_time >= {window_start:DateTime64(3, 'Asia/Shanghai')}
    OR state_valid_until > {window_start:DateTime64(3, 'Asia/Shanghai')})
ORDER BY event_id, ingest_time DESC, record_id DESC
LIMIT 1 BY event_id
