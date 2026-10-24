/* TG-F00: physical import dedup and business event dedup are distinct. */
WITH raw AS
(
 SELECT event_type,source,scenario_id,count() AS source_observed_record_count,
  uniqExact(event_id) AS business_event_count,
  countIf(parse_status!='OK') AS parse_failure_count
 FROM da.tg_validation_events FINAL
 WHERE run_id={run_id:String} AND user_id={user_id:String}
  AND ({scenario_id:String}='' OR scenario_id={scenario_id:String})
  AND event_time>={window_start:DateTime64(3)} AND event_time<{window_end:DateTime64(3)}
 GROUP BY event_type,source,scenario_id
), quality AS
(
 SELECT event_type,source,scenario_id,count() AS observed_event_count,
 countIf(subject_type='VIEWER')/count() AS identity_mapping_success_ratio,
 countIf(notEmpty(video_id))/count() AS video_mapping_success_ratio,
 countIf(auth_result=-1)/count() AS auth_unknown_ratio,
 countIf(ua_family='UNKNOWN')/count() AS unknown_ua_ratio,
 countIf(media_mapped)/count() AS manifest_mapping_ratio,
 min((toUnixTimestamp64Milli(ingest_time)-toUnixTimestamp64Milli(event_time))) AS ingest_delay_min_ms,
 max((toUnixTimestamp64Milli(ingest_time)-toUnixTimestamp64Milli(event_time))) AS ingest_delay_max_ms,
 quantileExact(0.95)((toUnixTimestamp64Milli(ingest_time)-toUnixTimestamp64Milli(event_time))) AS ingest_delay_p95_ms
 FROM da.tg_validation_event_features
 WHERE run_id={run_id:String} AND user_id={user_id:String}
 AND ({scenario_id:String}='' OR scenario_id={scenario_id:String})
 AND event_time>={window_start:DateTime64(3)} AND event_time<{window_end:DateTime64(3)}
 GROUP BY event_type,source,scenario_id
), coverage AS
(
 SELECT scenario_id,event_type,
 max(toUInt8(is_complete AND coverage_start<={window_start:DateTime64(3)} AND coverage_end>={window_end:DateTime64(3)})) AS window_source_coverage
 FROM da.tg_validation_source_coverage FINAL
 WHERE run_id={run_id:String} AND user_id={user_id:String}
 GROUP BY scenario_id,event_type
)
SELECT {run_id:String} AS run_id,{user_id:String} AS user_id,'SOURCE' AS subject_type,
 concat(raw.source,':',raw.event_type) AS subject_id,raw.scenario_id AS scenario_id,
 {window_start:DateTime64(3)} AS window_start,{window_end:DateTime64(3)} AS window_end,
 raw.event_type AS event_type,raw.source AS source,
 source_observed_record_count,business_event_count,parse_failure_count,
 source_observed_record_count-business_event_count AS replay_record_count,
 quality.observed_event_count AS observed_event_count,
 identity_mapping_success_ratio,video_mapping_success_ratio,auth_unknown_ratio,unknown_ua_ratio,
 manifest_mapping_ratio,ingest_delay_min_ms,ingest_delay_max_ms,ingest_delay_p95_ms,
 coverage.window_source_coverage AS window_source_coverage,
 NOT coverage.window_source_coverage AS source_gap_flag,
 'AVAILABLE' AS compute_status,'OBSERVATION_SCOPE_ONLY' AS reason_code,'OBSERVED' AS value_kind,
 'TG-F00' AS feature_code,'1' AS feature_version,now64(3) AS as_of_time
FROM raw INNER JOIN quality ON raw.event_type=quality.event_type AND raw.source=quality.source AND raw.scenario_id=quality.scenario_id
LEFT JOIN coverage ON raw.scenario_id=coverage.scenario_id AND raw.event_type=coverage.event_type;
