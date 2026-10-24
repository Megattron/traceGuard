-- TG-F04 / R3: distinct accessed videos and trusted PLAYING interval concurrency.
-- State intervals are clipped by next state, explicit expiry and the query window.
-- The independent TS-request proxy needs an explicit TTL model covering the window and its lookback.
WITH
    {run_id:String} AS p_run,{user_id:String} AS p_user,{scenario_id:String} AS p_scenario,
    {window_start:DateTime64(3)} AS p_start,{window_end:DateTime64(3)} AS p_end,
    toUnixTimestamp64Milli(p_start) AS start_ms,toUnixTimestamp64Milli(p_end) AS end_ms,
    all_events AS
    (
        SELECT * FROM da.tg_validation_event_features
        WHERE run_id = p_run AND user_id = p_user
          AND (p_scenario = '' OR scenario_id = p_scenario)
          AND event_time < p_end AND subject_id IS NOT NULL AND video_id != ''
    ),
    request_counts AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,
            count() AS observed_evidence_count,
            countIf(event_type = 'TS_VALIDATE') AS ts_observed_event_count,
            countIf(event_type = 'CDN_MEDIA_ACCESS') AS cdn_observed_event_count,
            uniqExactIf(video_id,(event_type = 'TS_VALIDATE' AND auth_result = 1)
                OR (event_type = 'CDN_MEDIA_ACCESS' AND ifNull(http_status IN (200,206),0)
                    AND ifNull(response_bytes > 0,0))) AS window_active_video_count_obs
        FROM all_events
        WHERE event_time >= p_start AND event_type IN ('TS_VALIDATE','CDN_MEDIA_ACCESS')
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id
    ),
    request_models AS
    (
        SELECT run_id,user_id,scenario_id,
            arrayDistinct(arrayMap(m -> m.3,arrayFilter(m -> m.3 > 0
                AND m.1 <= start_ms-toInt64(m.3)*1000 AND m.2 >= end_ms,
                groupArray(tuple(toUnixTimestamp64Milli(coverage_start),toUnixTimestamp64Milli(coverage_end),
                    ifNull(request_activity_ttl_seconds,toUInt32(0))))))) AS valid_model_ttls
        FROM da.tg_validation_source_coverage FINAL
        WHERE run_id = p_run AND user_id = p_user AND event_type = 'TS_VALIDATE'
          AND (p_scenario = '' OR scenario_id = p_scenario)
        GROUP BY run_id,user_id,scenario_id
    ),
    request_intervals AS
    (
        SELECT e.run_id AS run_id,e.user_id AS user_id,e.scenario_id AS scenario_id,
            e.subject_type AS subject_type,e.subject_id AS subject_id,e.video_id AS video_id,
            greatest(toUnixTimestamp64Milli(e.event_time),start_ms) AS interval_start,
            least(toUnixTimestamp64Milli(e.event_time)+toInt64(m.valid_model_ttls[1])*1000,end_ms)
                AS interval_end
        FROM all_events AS e
        INNER JOIN request_models AS m ON e.run_id=m.run_id AND e.user_id=m.user_id AND e.scenario_id=m.scenario_id
        WHERE e.event_type = 'TS_VALIDATE' AND e.auth_result = 1 AND length(m.valid_model_ttls) = 1
          AND toUnixTimestamp64Milli(e.event_time)+toInt64(m.valid_model_ttls[1])*1000 > start_ms
    ),
    request_interval_arrays AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,
            groupArray(tuple(interval_start,interval_end,video_id)) AS intervals,
            arraySort(arrayDistinct(arrayConcat(groupArray(interval_start),groupArray(interval_end)))) AS boundaries
        FROM request_intervals WHERE interval_end > interval_start
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id
    ),
    request_concurrency AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,
            arrayMap(t -> arrayUniq(arrayMap(x -> x.3,arrayFilter(x -> x.1 <= t AND x.2 > t,intervals))),
                boundaries) AS active_counts,
            arrayMap(i -> if(i < length(boundaries),boundaries[i+1]-boundaries[i],toInt64(0)),
                arrayEnumerate(boundaries)) AS spans
        FROM request_interval_arrays
    ),
    state_arrays AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,session_ref,
            arraySort(x -> (x.1,x.2),groupArray(tuple(toUnixTimestamp64Milli(event_time),event_id,
                ifNull(state,''),ifNull(toUnixTimestamp64Milli(state_valid_until),toInt64(-1)),video_id))) AS states,
            countIf(state_valid_until IS NULL) AS missing_expiry_count
        FROM all_events
        WHERE event_type = 'PLAYBACK_STATE' AND trusted_state = 1
          AND session_ref IS NOT NULL AND association_status = 'CONFIRMED'
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id,session_ref
    ),
    state_intervals AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,
            greatest(states[i].1,start_ms) AS interval_start,
            least(states[i].4,if(i < length(states),states[i+1].1,end_ms),end_ms) AS interval_end,
            states[i].5 AS interval_video
        FROM state_arrays ARRAY JOIN arrayEnumerate(states) AS i
        WHERE states[i].3 = 'PLAYING' AND states[i].4 >= 0
          AND states[i].1 < end_ms
          AND states[i].4 > start_ms
    ),
    interval_arrays AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,
            groupArray(tuple(interval_start,interval_end,interval_video)) AS intervals,
            arraySort(arrayDistinct(arrayConcat(groupArray(interval_start),groupArray(interval_end)))) AS boundaries
        FROM state_intervals WHERE interval_end > interval_start
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id
    ),
    concurrency AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,
            arrayMap(t -> arrayUniq(arrayMap(x -> x.3,arrayFilter(x -> x.1 <= t AND x.2 > t,intervals))),
                boundaries) AS active_counts,
            arrayMap(i -> if(i < length(boundaries),boundaries[i+1]-boundaries[i],toInt64(0)),
                arrayEnumerate(boundaries)) AS spans
        FROM interval_arrays
    ),
    state_counts AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,
            sum(length(states)) AS trusted_state_count,sum(missing_expiry_count) AS state_expiry_unknown_count,
            sum(length(states)-length(arrayDistinct(arrayMap(x -> x.1,states)))) AS state_order_ambiguous_count
        FROM state_arrays GROUP BY run_id,user_id,scenario_id,subject_type,subject_id
    ),
    subjects AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id FROM request_counts
        UNION DISTINCT
        SELECT run_id,user_id,scenario_id,subject_type,subject_id FROM state_counts
        UNION DISTINCT
        SELECT run_id,user_id,scenario_id,subject_type,subject_id FROM request_concurrency
    )
SELECT s.run_id AS run_id,s.user_id AS user_id,s.scenario_id AS scenario_id,
    s.subject_type AS subject_type,s.subject_id AS subject_id,
    p_start AS window_start,p_end AS window_end,
    'AVAILABLE' AS compute_status,'' AS reason_code,'LOWER_BOUND' AS value_kind,
    ifNull(r.observed_evidence_count,0) AS observed_evidence_count,
    ifNull(r.ts_observed_event_count,0) AS ts_observed_event_count,
    ifNull(r.cdn_observed_event_count,0) AS cdn_observed_event_count,
    ifNull(r.window_active_video_count_obs,0) AS window_active_video_count_obs,
    if(length(m.valid_model_ttls) = 1,ifNull(arrayMax(q.active_counts),toUInt64(0)),NULL)
        AS request_active_interval_overlap_proxy,
    if(length(m.valid_model_ttls) = 1,
        ifNull(arraySum(arrayMap((n,ms) -> if(n >= 2,ms,toInt64(0)),q.active_counts,q.spans)),0) / 1000.0,NULL)
        AS request_active_overlap_seconds_proxy,
    if(length(m.valid_model_ttls) = 1,m.valid_model_ttls[1],NULL) AS request_activity_ttl_seconds,
    if(length(m.valid_model_ttls) = 1,'AVAILABLE','UNAVAILABLE') AS request_overlap_compute_status,
    multiIf(length(m.valid_model_ttls) = 1,'',length(m.valid_model_ttls) > 1,'AMBIGUOUS_REQUEST_ACTIVITY_MODEL',
        'UNCALIBRATED_REQUEST_ACTIVITY_MODEL_OR_LOOKBACK_COVERAGE') AS request_overlap_reason_code,
    ifNull(t.trusted_state_count,0) AS trusted_state_count,
    ifNull(t.state_expiry_unknown_count,0) AS state_expiry_unknown_count,
    ifNull(t.state_order_ambiguous_count,0) AS state_order_ambiguous_count,
    if(t.trusted_state_count > 0 AND t.state_expiry_unknown_count = 0 AND t.state_order_ambiguous_count = 0,
        ifNull(arrayMax(c.active_counts),toUInt32(0)),NULL) AS playback_state_concurrent_video_count,
    if(t.trusted_state_count > 0 AND t.state_expiry_unknown_count = 0 AND t.state_order_ambiguous_count = 0,
        ifNull(arraySum(arrayMap((n,ms) -> if(n >= 2,ms,toInt64(0)),c.active_counts,c.spans)),0) / 1000.0,NULL)
        AS playback_state_overlap_seconds,
    multiIf(ifNull(t.trusted_state_count,0) = 0,'UNAVAILABLE',t.state_expiry_unknown_count > 0
        OR t.state_order_ambiguous_count > 0,
        'UNAVAILABLE','AVAILABLE') AS playback_state_compute_status,
    multiIf(ifNull(t.trusted_state_count,0) = 0,'MISSING_TRUSTED_STATE',t.state_expiry_unknown_count > 0,
        'MISSING_STATE_EXPIRY',t.state_order_ambiguous_count > 0,'AMBIGUOUS_STATE_ORDER','') AS playback_state_reason_code,
    'OBSERVED_PLAYER_STATE' AS playback_state_value_kind
FROM subjects AS s
LEFT JOIN request_counts AS r ON s.run_id=r.run_id AND s.user_id=r.user_id AND s.scenario_id=r.scenario_id
    AND s.subject_type=r.subject_type AND s.subject_id=r.subject_id
LEFT JOIN state_counts AS t ON s.run_id=t.run_id AND s.user_id=t.user_id AND s.scenario_id=t.scenario_id
    AND s.subject_type=t.subject_type AND s.subject_id=t.subject_id
LEFT JOIN concurrency AS c ON s.run_id=c.run_id AND s.user_id=c.user_id AND s.scenario_id=c.scenario_id
    AND s.subject_type=c.subject_type AND s.subject_id=c.subject_id
LEFT JOIN request_concurrency AS q ON s.run_id=q.run_id AND s.user_id=q.user_id AND s.scenario_id=q.scenario_id
    AND s.subject_type=q.subject_type AND s.subject_id=q.subject_id
LEFT JOIN request_models AS m ON s.run_id=m.run_id AND s.user_id=m.user_id AND s.scenario_id=m.scenario_id
ORDER BY s.scenario_id,s.subject_type,s.subject_id
