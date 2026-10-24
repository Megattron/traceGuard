-- TG-F10 / R8: TS-auth-pass access minutes, observed runs, gaps and media amounts.
-- One source/result layer is used; CDN and auth records of the same request are not double counted.
-- *_24h and /1440 values are NULL unless the requested window is exactly 24 hours.
WITH
    {run_id:String} AS p_run,{user_id:String} AS p_user,{scenario_id:String} AS p_scenario,
    {window_start:DateTime64(3)} AS p_start,{window_end:DateTime64(3)} AS p_end,
    (toUnixTimestamp64Milli(p_end)-toUnixTimestamp64Milli(p_start)) / 1000.0 AS window_s,
    window_s = 86400 AND modulo(toUnixTimestamp64Milli(p_start),60000) = 0 AS is_full_day_window,
    input AS
    (
        SELECT * FROM da.tg_validation_event_features
        WHERE run_id = p_run AND user_id = p_user
          AND (p_scenario = '' OR scenario_id = p_scenario)
          AND event_time >= p_start AND event_time < p_end
          AND event_type = 'TS_VALIDATE' AND auth_result = 1
          AND subject_id IS NOT NULL AND video_id != ''
    ),
    activity AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,source,sampling_method,sampling_unit,sampling_rate,
            count() AS observed_event_count,
            arraySort(groupUniqArray(intDiv(toUnixTimestamp64Milli(event_time),60000))) AS active_minutes,
            arraySort(groupArray(toUnixTimestamp64Milli(event_time))) AS request_times,
            countIf(media_mapped != 1) AS manifest_unknown_count,
            sumIf(ifNull(segment_duration_s,0),media_mapped = 1) AS request_seconds_mapped
        FROM input
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id,source,sampling_method,sampling_unit,sampling_rate
    ),
    content_unions AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,source,sampling_method,sampling_unit,sampling_rate,
            video_id,content_version,
            intervalLengthSumIf(toFloat64(ifNull(media_start_s,0)),toFloat64(ifNull(media_end_s,0)),
                media_mapped = 1) AS unique_media_s
        FROM input
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id,source,sampling_method,sampling_unit,sampling_rate,
            video_id,content_version
    ),
    content_totals AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,source,sampling_method,sampling_unit,sampling_rate,
            sum(unique_media_s) AS union_media_seconds
        FROM content_unions
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id,source,sampling_method,sampling_unit,sampling_rate
    )
SELECT a.run_id AS run_id,a.user_id AS user_id,a.scenario_id AS scenario_id,
    a.subject_type AS subject_type,a.subject_id AS subject_id,a.source AS source,
    a.sampling_method AS sampling_method,a.sampling_unit AS sampling_unit,a.sampling_rate AS sampling_rate,
    p_start AS window_start,p_end AS window_end,
    window_s AS window_seconds,'AUTH_PASS' AS result_scope,
    'AVAILABLE' AS compute_status,'' AS reason_code,'OBSERVED' AS value_kind,
    a.observed_event_count AS observed_event_count,length(a.active_minutes) AS active_minute_count_obs,
    arrayMax(arrayMap(x -> length(x),arraySplit((m,d) -> d != 1,a.active_minutes,arrayDifference(a.active_minutes))))
        AS longest_observed_active_minute_run,
    if(length(a.request_times) >= 2,arrayMax(arrayDifference(a.request_times)) / 1000.0,NULL)
        AS max_observed_request_gap_s,
    a.manifest_unknown_count AS manifest_unknown_count,
    if(a.manifest_unknown_count = 0,c.union_media_seconds,NULL) AS unique_media_seconds_window,
    if(a.manifest_unknown_count = 0,a.request_seconds_mapped,NULL) AS request_equivalent_seconds_window,
    if(is_full_day_window AND a.manifest_unknown_count = 0,c.union_media_seconds,NULL) AS unique_media_seconds_24h,
    if(is_full_day_window AND a.manifest_unknown_count = 0,a.request_seconds_mapped,NULL)
        AS request_equivalent_seconds_24h,
    if(is_full_day_window,length(a.active_minutes) / 1440.0,NULL) AS active_minute_fraction_obs,
    multiIf(window_s != 86400,'WINDOW_IS_NOT_24_HOURS',NOT is_full_day_window,
        'WINDOW_NOT_ALIGNED_TO_MINUTE','AVAILABLE') AS full_day_feature_status,
    if(a.manifest_unknown_count = 0,'AVAILABLE','MISSING_MANIFEST') AS media_feature_status,
    'LOWER_BOUND' AS active_minute_value_kind,'LOWER_BOUND' AS unique_media_value_kind
FROM activity AS a
LEFT JOIN content_totals AS c ON a.run_id=c.run_id AND a.user_id=c.user_id AND a.scenario_id=c.scenario_id
    AND a.subject_type=c.subject_type AND a.subject_id=c.subject_id AND a.source=c.source
    AND a.sampling_method=c.sampling_method AND a.sampling_unit=c.sampling_unit
    AND ifNull(a.sampling_rate,-1)=ifNull(c.sampling_rate,-1)
ORDER BY a.scenario_id,a.subject_type,a.subject_id,a.source
