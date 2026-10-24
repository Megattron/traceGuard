-- TG-F03 / R2: request volume, media interval unions and fixed-window speed.
-- ALL_VIDEOS and VIDEO_LOCAL are recalculated independently; TS auth and CDN delivery are never added together.
WITH
    {run_id:String} AS p_run,
    {user_id:String} AS p_user,
    {scenario_id:String} AS p_scenario,
    {window_start:DateTime64(3)} AS p_start,
    {window_end:DateTime64(3)} AS p_end,
    (toUnixTimestamp64Milli(p_end)-toUnixTimestamp64Milli(p_start)) / 1000.0 AS window_s,
    input AS
    (
        SELECT *,
            event_type = 'TS_VALIDATE' AND auth_result = 1 AS auth_pass,
            event_type = 'CDN_MEDIA_ACCESS' AND ifNull(http_status IN (200,206),0)
                AND ifNull(response_bytes > 0,0) AS cdn_response,
            event_type = 'CDN_MEDIA_ACCESS' AND ifNull(fully_served = 1,0) AS full_response,
            tupleElement(context,1) AS video_scope,
            tupleElement(context,2) AS scope_video_id
        FROM da.tg_validation_event_features
        ARRAY JOIN [tuple('ALL_VIDEOS',''),tuple('VIDEO_LOCAL',video_id)] AS context
        WHERE run_id = p_run AND user_id = p_user
          AND (p_scenario = '' OR scenario_id = p_scenario)
          AND event_time >= p_start AND event_time < p_end
          AND subject_id IS NOT NULL AND video_id != ''
          AND event_type IN ('TS_VALIDATE','CDN_MEDIA_ACCESS')
    ),
    per_content AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,video_scope,scope_video_id,
            video_id AS content_video_id,content_version,
            count() AS observed_event_count,
            countIf(auth_pass) AS auth_n,
            countIf(auth_pass AND media_mapped = 1) AS auth_mapped_n,
            countIf(cdn_response) AS cdn_n,
            countIf(cdn_response AND media_mapped = 1) AS cdn_mapped_n,
            countIf(event_type = 'CDN_MEDIA_ACCESS') AS cdn_event_n,
            countIf(event_type = 'CDN_MEDIA_ACCESS' AND fully_served IS NULL) AS full_unknown_n,
            countIf(full_response AND media_mapped != 1) AS full_unmapped_n,
            countIf(auth_pass AND (sampling_rate IS NULL OR sampling_rate <= 0 OR sampling_rate > 1
                OR sampling_method NOT IN ('BERNOULLI','UNIFORM_REQUEST','CENSUS')
                OR sampling_unit NOT IN ('AUTH_EVENT','REQUEST'))) AS estimate_ineligible_n,
            countIf(auth_pass AND ifNull(sampling_rate < 1,1)) AS auth_sampled_n,
            countIf(cdn_response AND ifNull(sampling_rate < 1,1)) AS cdn_sampled_n,
            sumIf(ifNull(segment_duration_s,0),auth_pass AND media_mapped = 1) AS auth_seconds_mapped,
            sumIf(ifNull(segment_duration_s,0) / ifNull(nullIf(sampling_rate,0),1),
                auth_pass AND media_mapped = 1) AS auth_seconds_est_mapped,
            intervalLengthSumIf(toFloat64(ifNull(media_start_s,0)),toFloat64(ifNull(media_end_s,0)),
                auth_pass AND media_mapped = 1) AS auth_union_s,
            intervalLengthSumIf(toFloat64(ifNull(media_start_s,0)),toFloat64(ifNull(media_end_s,0)),
                cdn_response AND media_mapped = 1) AS cdn_union_s,
            intervalLengthSumIf(toFloat64(ifNull(media_start_s,0)),toFloat64(ifNull(media_end_s,0)),
                full_response AND media_mapped = 1) AS full_union_s
        FROM input
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id,video_scope,scope_video_id,
            content_video_id,content_version
    ),
    totals AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,video_scope,scope_video_id,
            sum(observed_event_count) AS observed_event_count,
            sum(auth_n) AS ts_auth_pass_count_obs,
            sum(auth_n - auth_mapped_n) AS auth_manifest_unknown_count,
            sum(cdn_n) AS cdn_response_count_obs,
            sum(cdn_n - cdn_mapped_n) AS cdn_manifest_unknown_count,
            sum(cdn_event_n) AS cdn_observed_event_count,
            sum(full_unknown_n) AS fully_served_unknown_count,
            sum(full_unmapped_n) AS fully_served_manifest_unknown_count,
            sum(estimate_ineligible_n) AS estimate_ineligible_count,
            sum(auth_sampled_n) AS auth_sampled_count,
            sum(cdn_sampled_n) AS cdn_sampled_count,
            sum(auth_seconds_mapped) AS auth_mapped_request_seconds,
            sum(auth_seconds_est_mapped) AS auth_estimate_seconds,
            sum(auth_union_s) AS auth_union_seconds,
            sum(cdn_union_s) AS cdn_union_seconds,
            sum(full_union_s) AS full_union_seconds
        FROM per_content
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id,video_scope,scope_video_id
    )
SELECT run_id,user_id,scenario_id,subject_type,subject_id,video_scope,scope_video_id AS video_id,
    p_start AS window_start,p_end AS window_end,window_s AS window_seconds,
    'AVAILABLE' AS compute_status,'' AS reason_code,'OBSERVED' AS value_kind,
    observed_event_count,ts_auth_pass_count_obs,cdn_response_count_obs,
    auth_manifest_unknown_count,cdn_manifest_unknown_count,fully_served_unknown_count,
    fully_served_manifest_unknown_count,estimate_ineligible_count,
    if(auth_manifest_unknown_count = 0,auth_mapped_request_seconds,NULL) AS auth_request_equivalent_seconds_obs,
    if(ts_auth_pass_count_obs > 0 AND auth_manifest_unknown_count = 0 AND estimate_ineligible_count = 0,auth_estimate_seconds,NULL)
        AS auth_request_equivalent_seconds_est,
    if(auth_manifest_unknown_count = 0,auth_union_seconds,NULL) AS auth_unique_media_seconds_obs,
    if(cdn_manifest_unknown_count = 0,cdn_union_seconds,NULL) AS cdn_response_media_seconds_obs,
    if(cdn_observed_event_count > 0 AND fully_served_unknown_count = 0
        AND fully_served_manifest_unknown_count = 0,full_union_seconds,NULL) AS fully_served_media_seconds,
    if(window_s > 0 AND auth_manifest_unknown_count = 0,auth_union_seconds / nullIf(window_s,0),NULL)
        AS auth_unique_speed_ratio,
    if(window_s > 0 AND cdn_manifest_unknown_count = 0,cdn_union_seconds / nullIf(window_s,0),NULL)
        AS cdn_response_speed_ratio,
    if(auth_manifest_unknown_count > 0,'MISSING_MANIFEST','AVAILABLE') AS auth_media_status,
    if(cdn_manifest_unknown_count > 0,'MISSING_MANIFEST','AVAILABLE') AS cdn_media_status,
    multiIf(cdn_observed_event_count = 0,'NO_CDN_OBSERVATION',fully_served_unknown_count > 0,
        'MISSING_DELIVERY_EVIDENCE',fully_served_manifest_unknown_count > 0,'MISSING_MANIFEST','AVAILABLE')
        AS fully_served_status,
    multiIf(ts_auth_pass_count_obs = 0,'NO_AUTH_OBSERVATION',auth_manifest_unknown_count > 0,'MISSING_MANIFEST',estimate_ineligible_count > 0,
        'SAMPLING_ESTIMATE_DISABLED','AVAILABLE') AS estimate_status,
    if(auth_sampled_count > 0,'LOWER_BOUND','OBSERVED') AS auth_unique_value_kind,
    if(cdn_sampled_count > 0,'LOWER_BOUND','OBSERVED') AS cdn_media_value_kind,
    'AUTH_PASS' AS auth_result_scope,'HTTP_200_OR_206_WITH_RESPONSE_BYTES' AS cdn_result_scope
FROM totals
ORDER BY scenario_id,subject_type,subject_id,video_scope,video_id
