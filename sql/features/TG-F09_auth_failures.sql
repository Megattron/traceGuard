/* TG-F09 / R7: do not mix authorization stages or CDN HTTP results. */
WITH events AS
(
 SELECT * FROM da.tg_validation_event_features
 WHERE run_id={run_id:String} AND user_id={user_id:String}
 AND ({scenario_id:String}='' OR scenario_id={scenario_id:String})
 AND event_time>={window_start:DateTime64(3)} AND event_time<{window_end:DateTime64(3)}
 AND event_type IN ('TS_VALIDATE','HLS_KEY_VALIDATE')
), grouped AS
(
 SELECT scenario_id,video_id,source,event_type,
 count() AS observed_event_count,countIf(auth_result=1) AS auth_pass_count_obs,
 countIf(auth_result=0) AS auth_fail_count_obs,countIf(auth_result=-1) AS auth_unknown_count_obs,
 uniqExactIf(token_ref,auth_result=0 AND notEmpty(token_ref)) AS failed_token_count_obs,
 uniqExactIf(client_ip,auth_result=0 AND isNotNull(client_ip)) AS failed_ip_count_obs,
 countIf(auth_result=0 AND empty(token_ref)) AS failed_unknown_token_count,
 countIf(auth_result=0 AND isNull(client_ip)) AS failed_unknown_ip_count,
 groupArrayIf(tuple(token_ref),auth_result=0 AND notEmpty(token_ref)) AS failed_tokens,
 groupArrayIf(tuple(client_ip),auth_result=0 AND isNotNull(client_ip)) AS failed_ips,
 groupArrayIf(ifNull(failure_reason,'UNKNOWN'),auth_result=0) AS reasons
 FROM events GROUP BY scenario_id,video_id,source,event_type
)
SELECT {run_id:String} AS run_id,{user_id:String} AS user_id,'VIDEO' AS subject_type,
 video_id AS subject_id,scenario_id,video_id,source,event_type,
 {window_start:DateTime64(3)} AS window_start,{window_end:DateTime64(3)} AS window_end,
 observed_event_count,auth_pass_count_obs,auth_fail_count_obs,auth_unknown_count_obs,
 auth_pass_count_obs+auth_fail_count_obs AS auth_known_result_count_obs,
 auth_fail_count_obs/nullIf(auth_known_result_count_obs,0) AS auth_failure_ratio_obs,
 if(auth_known_result_count_obs=0,'ZERO_DENOMINATOR','OK') AS auth_failure_ratio_status,
 auth_unknown_count_obs/nullIf(observed_event_count,0) AS auth_unknown_ratio,
 failed_token_count_obs,failed_ip_count_obs,failed_unknown_token_count,failed_unknown_ip_count,
 if(length(failed_tokens)>0,arrayMax(arrayMap(x->arrayCount(y->y=x,failed_tokens),arrayDistinct(failed_tokens)))/nullIf(auth_fail_count_obs,0),NULL) AS top1_failed_token_share_obs,
 if(length(failed_ips)>0,arrayMax(arrayMap(x->arrayCount(y->y=x,failed_ips),arrayDistinct(failed_ips)))/nullIf(auth_fail_count_obs,0),NULL) AS top1_failed_ip_share_obs,
 arrayMap(x->tuple(x,arrayCount(y->y=x,reasons)),arraySort(arrayDistinct(reasons))) AS failure_reason_counts,
 if(notEmpty(video_id),'AVAILABLE','UNAVAILABLE') AS compute_status,
 if(empty(video_id),'MISSING_VIDEO_MAPPING',if(auth_known_result_count_obs=0,'ZERO_DENOMINATOR','OK')) AS reason_code,
 'OBSERVED' AS value_kind,'TG-F09' AS feature_code,'1' AS feature_version,now64(3) AS as_of_time
FROM grouped;
