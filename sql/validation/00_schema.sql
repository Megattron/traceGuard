CREATE TABLE IF NOT EXISTS da.tg_validation_events
(
 run_id String, dataset_kind LowCardinality(String), scenario_id String,
 record_id String, event_id String, source_event_id String,
 event_time DateTime64(3,'Asia/Shanghai'), ingest_time DateTime64(3,'Asia/Shanghai'),
 event_type LowCardinality(String), source LowCardinality(String), user_id String,
 viewer_id Nullable(String), credential_viewer_id Nullable(String), identity_basis LowCardinality(String),
 video_id String, token_ref String, session_ref Nullable(String), association_status LowCardinality(String),
 request_ref String, request_ip Nullable(String), viewer_ip Nullable(String), ip_basis LowCardinality(String),
 user_agent Nullable(String), request_url String, segment_index_raw Nullable(Int32),
 auth_result Int8, http_status Nullable(UInt16), failure_reason Nullable(String), token_action Nullable(String),
 key_valid_until Nullable(DateTime64(3,'Asia/Shanghai')),
 response_bytes Nullable(UInt64), object_size Nullable(UInt64), response_completed Nullable(UInt8),
 range_start Nullable(UInt64), range_end Nullable(UInt64),
 state Nullable(String), current_time_s Nullable(Float64), playback_rate Nullable(Float64),
 state_valid_until Nullable(DateTime64(3,'Asia/Shanghai')), trusted_state UInt8,
 native_sequence Nullable(UInt64), sampling_rate Nullable(Float64),
 sampling_method LowCardinality(String), sampling_unit LowCardinality(String),
 parse_status LowCardinality(String), quality_flags Array(String), raw_log_ref String, load_part String
)
ENGINE=ReplacingMergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (run_id,user_id,record_id);

CREATE TABLE IF NOT EXISTS da.tg_validation_media_segments
(
 run_id String, row_key String, dataset_kind LowCardinality(String), scenario_id String,
 user_id String, video_id String, resource_version String, content_version String,
 playlist_ref String, rendition_ref String, track_type LowCardinality(String), object_path String,
 segment_index Int32, media_start_s Float64, media_end_s Float64, segment_duration_s Float64,
 total_segments UInt32, expected_object_bytes UInt64, manifest_available UInt8
)
ENGINE=ReplacingMergeTree ORDER BY (run_id,user_id,row_key);

CREATE TABLE IF NOT EXISTS da.tg_validation_token_snapshots
(
 run_id String, row_key String, dataset_kind LowCardinality(String), scenario_id String,
 user_id String, token_ref String, effective_at DateTime64(3,'Asia/Shanghai'),
 expires_at DateTime64(3,'Asia/Shanghai'), revoked UInt8, allowed_video_ids Array(String),
 credential_viewer_id Nullable(String), token_app_id Nullable(String),
 original_issued_at DateTime64(3,'Asia/Shanghai'), last_renewed_at DateTime64(3,'Asia/Shanghai'),
 policy_version String
)
ENGINE=ReplacingMergeTree ORDER BY (run_id,user_id,row_key);

CREATE TABLE IF NOT EXISTS da.tg_validation_source_coverage
(
 run_id String, row_key String, dataset_kind LowCardinality(String), scenario_id String,
 user_id String, event_type String, coverage_start DateTime64(3,'Asia/Shanghai'),
 coverage_end DateTime64(3,'Asia/Shanghai'), is_complete UInt8,
 sampling_rate Nullable(Float64), sampling_method String,
 requires_token UInt8, requires_manifest UInt8, requires_key UInt8,
 key_validity_seconds UInt32, request_activity_ttl_seconds Nullable(UInt32), protocol_version String
)
ENGINE=ReplacingMergeTree ORDER BY (run_id,user_id,row_key);

CREATE TABLE IF NOT EXISTS da.tg_validation_business_config
(
 run_id String, row_key String, dataset_kind LowCardinality(String), scenario_id String,
 user_id String, timezone Nullable(String), off_hours_start_min Nullable(UInt16),
 off_hours_end_min Nullable(UInt16), config_version String,
 valid_from DateTime64(3,'Asia/Shanghai'), valid_to DateTime64(3,'Asia/Shanghai')
)
ENGINE=ReplacingMergeTree ORDER BY (run_id,user_id,row_key);

CREATE TABLE IF NOT EXISTS da.tg_validation_ip_info
(
 run_id String, row_key String, dataset_kind LowCardinality(String), request_ip String,
 country String, province String, isp String, mapping_version String
)
ENGINE=ReplacingMergeTree ORDER BY (run_id,row_key);
