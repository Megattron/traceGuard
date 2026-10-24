-- TG-F08 / R6: one subject + video + session/token + media playlist sequence.
-- A deterministic event_id sort never establishes chronological order for timestamp ties.
-- Native sequence may disambiguate a tie only when both values are present and different.
WITH
    {run_id:String} AS p_run,{user_id:String} AS p_user,{scenario_id:String} AS p_scenario,
    {window_start:DateTime64(3)} AS p_start,{window_end:DateTime64(3)} AS p_end,
    grouped AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,video_id,
            if(session_ref IS NULL,concat('TOKEN:',token_ref),concat('SESSION:',assumeNotNull(session_ref)))
                AS session_context,
            resource_version,playlist_ref,rendition_ref,track_type,source,sampling_method,sampling_unit,sampling_rate,
            count() AS observed_event_count,
            countIf(media_mapped != 1) AS manifest_unknown_count,
            uniqExactIf(segment_index,media_mapped = 1) AS unique_segment_count_obs,
            uniqExactIf(total_segments,media_mapped = 1 AND total_segments > 0) AS total_segment_definition_count,
            maxIf(total_segments,media_mapped = 1) AS manifest_total_segments,
            arraySort(x -> (x.1,ifNull(x.4,toUInt64(0)),x.2),groupArray(tuple(
                toUnixTimestamp64Milli(event_time),event_id,
                if(media_mapped = 1,segment_index,CAST(NULL,'Nullable(Int32)')),native_sequence))) AS requests
        FROM da.tg_validation_event_features
        WHERE run_id = p_run AND user_id = p_user
          AND (p_scenario = '' OR scenario_id = p_scenario)
          AND event_time >= p_start AND event_time < p_end
          AND event_type = 'TS_VALIDATE' AND auth_result = 1 AND subject_id IS NOT NULL AND video_id != ''
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id,video_id,session_context,
            resource_version,playlist_ref,rendition_ref,track_type,source,sampling_method,sampling_unit,sampling_rate
    ),
    arrays AS
    (
        SELECT *,
            arrayMap(x -> arrayCount(y -> y.1 = x.1,requests),requests) AS time_peer_counts,
            arrayFilter(i -> i > 1,arrayEnumerate(requests)) AS pair_positions,
            arrayMap(i -> requests[i].1-requests[i-1].1,
                arrayFilter(i -> i > 1,arrayEnumerate(requests))) AS gaps_ms,
            length(arrayFilter(t -> arrayCount(x -> x.1 = t,requests) > 1,
                arrayDistinct(arrayMap(x -> x.1,requests)))) AS timestamp_tie_count
        FROM grouped
    ),
    pairs AS
    (
        SELECT *,arrayMap(i -> ifNull(
            (time_peer_counts[i-1] = 1 AND time_peer_counts[i] = 1)
            OR (requests[i-1].4 IS NOT NULL AND requests[i].4 IS NOT NULL
                AND requests[i-1].4 < requests[i].4),toUInt8(0)),pair_positions) AS order_known,
            arrayMap(i -> requests[i-1].3 IS NOT NULL AND requests[i].3 IS NOT NULL,pair_positions)
                AS segment_pair_known,
            if(length(gaps_ms) > 0,arrayAvg(gaps_ms),NULL) AS gap_mean_ms
        FROM arrays
    )
SELECT run_id,user_id,scenario_id,subject_type,subject_id,video_id,session_context,
    resource_version,playlist_ref,rendition_ref,track_type,source,sampling_method,sampling_unit,sampling_rate,
    p_start AS window_start,p_end AS window_end,
    'AVAILABLE' AS compute_status,'' AS reason_code,'OBSERVED' AS value_kind,
    observed_event_count,manifest_unknown_count,unique_segment_count_obs,
    if(total_segment_definition_count = 1 AND manifest_total_segments > 0,manifest_total_segments,NULL)
        AS total_segments,
    if(total_segment_definition_count = 1 AND manifest_total_segments > 0,
        unique_segment_count_obs / nullIf(toFloat64(manifest_total_segments),0),NULL) AS coverage_ratio_obs,
    multiIf(total_segment_definition_count = 0,'MISSING_MANIFEST',total_segment_definition_count > 1,
        'INCONSISTENT_MANIFEST','AVAILABLE') AS coverage_status,
    'LOWER_BOUND' AS coverage_value_kind,
    arrayCount((known,mapped) -> known AND mapped,order_known,segment_pair_known) AS valid_order_pair_count,
    arrayCount(known -> NOT known,order_known) AS order_unknown_pair_count,
    timestamp_tie_count,
    arrayCount((i,known,mapped) -> ifNull(known AND mapped AND requests[i].3 > requests[i-1].3,toUInt8(0)),
        pair_positions,order_known,segment_pair_known)
        / nullIf(toFloat64(arrayCount((known,mapped) -> known AND mapped,order_known,segment_pair_known)),0)
        AS monotonic_ratio_obs,
    if(arrayCount((known,mapped) -> known AND mapped,order_known,segment_pair_known) > 0,
        'AVAILABLE','ZERO_DENOMINATOR') AS monotonic_ratio_status,
    arrayCount(x -> x.3 IS NULL,requests) AS unknown_segment_index_count,
    observed_event_count - manifest_unknown_count - unique_segment_count_obs AS repeat_segment_count,
    arrayCount((i,known,mapped) -> ifNull(known AND mapped AND requests[i].3 < requests[i-1].3,toUInt8(0)),
        pair_positions,order_known,segment_pair_known) AS backward_step_count,
    gap_mean_ms AS request_gap_mean_ms,
    if(length(gaps_ms) > 0,sqrt(arrayAvg(arrayMap(g -> pow(g-ifNull(gap_mean_ms,0),2),gaps_ms))),NULL)
        AS request_gap_std_ms,
    if(length(requests) >= 3 AND gap_mean_ms > 0,
        sqrt(arrayAvg(arrayMap(g -> pow(g-ifNull(gap_mean_ms,0),2),gaps_ms))) / nullIf(gap_mean_ms,0),NULL)
        AS interval_cv_obs,
    multiIf(length(requests) < 3,'INSUFFICIENT_EVENTS',ifNull(gap_mean_ms,0) <= 0,
        'ZERO_OR_UNKNOWN_MEAN_GAP','AVAILABLE') AS interval_cv_status
FROM pairs
ORDER BY scenario_id,subject_type,subject_id,video_id,session_context,playlist_ref
