/* TG-F01: single-event facts. Source baseline is not promoted to an authenticated viewer. */
SELECT *, 'TG-F01' AS feature_code,'1' AS feature_version,
 'AVAILABLE' AS compute_status,'PARTIAL_FIELDS_PRESERVE_NULL' AS reason_code,'OBSERVED' AS value_kind,
 {window_start:DateTime64(3)} AS window_start,{window_end:DateTime64(3)} AS window_end,now64(3) AS as_of_time
FROM da.tg_validation_event_features
WHERE run_id={run_id:String} AND user_id={user_id:String}
 AND ({scenario_id:String}='' OR scenario_id={scenario_id:String})
 AND event_time>={window_start:DateTime64(3)} AND event_time<{window_end:DateTime64(3)};
