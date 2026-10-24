-- TG-F11 / R9: zero-score single-event night labels, then subject/stage/result aggregates.
-- Baseline: previous eight same weekdays, >=4 completely covered and comparable historical windows.
-- Zero historical activity participates only with an explicit complete coverage record.
-- This validation dataset contract supports Asia/Shanghai (or explicitly missing timezone).
WITH
    {run_id:String} AS p_run,{user_id:String} AS p_user,{scenario_id:String} AS p_scenario,
    {window_start:DateTime64(3)} AS p_start,{window_end:DateTime64(3)} AS p_end,
    toUnixTimestamp64Milli(p_start) AS start_ms,toUnixTimestamp64Milli(p_end) AS end_ms,
    (end_ms-start_ms) / 1000.0 AS window_s,
    input AS
    (
        SELECT * FROM da.tg_validation_event_features
        WHERE run_id = p_run AND user_id = p_user
          AND (p_scenario = '' OR scenario_id = p_scenario)
          AND event_time >= p_start - INTERVAL 56 DAY AND event_time < p_end
          AND subject_id IS NOT NULL AND video_id != '' AND is_client_event = 1
    ),
    current AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,event_type,source,auth_result,
            sampling_method,sampling_unit,sampling_rate,
            count() AS observed_event_count,
            countIf(is_off_hours IS NULL) AS off_hours_unknown_count,
            countIf(is_off_hours = 1) AS night_event_n,
            uniqExactIf(video_id,is_off_hours = 1) AS night_active_video_n,
            arraySort(groupUniqArrayIf(intDiv(toUnixTimestamp64Milli(event_time),60000),is_off_hours = 1))
                AS active_minutes,
            countIf(is_off_hours = 1 AND media_mapped != 1) AS night_manifest_unknown_count
        FROM input WHERE event_time >= p_start
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id,event_type,source,auth_result,
            sampling_method,sampling_unit,sampling_rate
    ),
    historical AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,event_type,source,auth_result,
            sampling_method,sampling_unit,sampling_rate,
            groupArray(tuple(toUnixTimestamp64Milli(event_time),ifNull(is_off_hours,toUInt8(0)),
                toUInt8(is_off_hours IS NULL))) AS history_events
        FROM input WHERE event_time < p_start
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id,event_type,source,auth_result,
            sampling_method,sampling_unit,sampling_rate
    ),
    coverage AS
    (
        SELECT run_id,user_id,scenario_id,event_type,
            groupArray(tuple(toUnixTimestamp64Milli(coverage_start),toUnixTimestamp64Milli(coverage_end),
                is_complete,ifNull(sampling_rate,-1),sampling_method)) AS coverage_intervals
        FROM da.tg_validation_source_coverage FINAL
        WHERE run_id = p_run AND user_id = p_user
          AND (p_scenario = '' OR scenario_id = p_scenario)
          AND coverage_end > p_start - INTERVAL 56 DAY AND coverage_start < p_end
        GROUP BY run_id,user_id,scenario_id,event_type
    ),
    configs AS
    (
        SELECT run_id,user_id,scenario_id,
            argMax(tuple(timezone,off_hours_start_min,off_hours_end_min,config_version),valid_from) AS cfg
        FROM da.tg_validation_business_config FINAL
        WHERE run_id = p_run AND user_id = p_user
          AND (p_scenario = '' OR scenario_id = p_scenario)
          AND valid_from <= p_start AND valid_to >= p_end
        GROUP BY run_id,user_id,scenario_id
    ),
    config_history AS
    (
        SELECT run_id,user_id,scenario_id,
            groupArray(tuple(toUnixTimestamp64Milli(valid_from),toUnixTimestamp64Milli(valid_to),
                timezone,off_hours_start_min,off_hours_end_min)) AS historical_configs
        FROM da.tg_validation_business_config FINAL
        WHERE run_id = p_run AND user_id = p_user
          AND (p_scenario = '' OR scenario_id = p_scenario)
          AND valid_to > p_start - INTERVAL 56 DAY AND valid_from < p_end
        GROUP BY run_id,user_id,scenario_id
    ),
    night_content AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,event_type,source,auth_result,
            sampling_method,sampling_unit,sampling_rate,video_id,content_version,
            intervalLengthSumIf(toFloat64(ifNull(media_start_s,0)),toFloat64(ifNull(media_end_s,0)),
                media_mapped = 1) AS union_seconds
        FROM input WHERE event_time >= p_start AND is_off_hours = 1
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id,event_type,source,auth_result,
            sampling_method,sampling_unit,sampling_rate,video_id,content_version
    ),
    night_totals AS
    (
        SELECT run_id,user_id,scenario_id,subject_type,subject_id,event_type,source,auth_result,
            sampling_method,sampling_unit,sampling_rate,sum(union_seconds) AS night_unique_media_seconds
        FROM night_content
        GROUP BY run_id,user_id,scenario_id,subject_type,subject_id,event_type,source,auth_result,
            sampling_method,sampling_unit,sampling_rate
    ),
    combined AS
    (
        SELECT c.run_id AS run_id,c.user_id AS user_id,c.scenario_id AS scenario_id,
            c.subject_type AS subject_type,c.subject_id AS subject_id,c.event_type AS event_type,
            c.source AS source,c.auth_result AS auth_result,c.sampling_method AS sampling_method,
            c.sampling_unit AS sampling_unit,c.sampling_rate AS sampling_rate,
            c.observed_event_count AS observed_event_count,c.off_hours_unknown_count AS off_hours_unknown_count,
            c.night_event_n AS night_event_n,c.night_active_video_n AS night_active_video_n,
            c.active_minutes AS active_minutes,c.night_manifest_unknown_count AS night_manifest_unknown_count,
            h.history_events AS history_events,v.coverage_intervals AS coverage_intervals,
            f.cfg AS cfg,g.historical_configs AS historical_configs,
            n.night_unique_media_seconds AS night_unique_media_seconds,
            arrayMap(i -> tuple(start_ms-toInt64(i)*604800000,end_ms-toInt64(i)*604800000),range(1,9))
                AS historical_windows,
            arrayMap(i -> intDiv(start_ms,60000)*60000+toInt64(i)*60000,
                range(toUInt32(greatest(0,intDiv(end_ms-1,60000)-intDiv(start_ms,60000)+1))))
                AS minute_starts
        FROM current AS c
        LEFT JOIN historical AS h ON c.run_id=h.run_id AND c.user_id=h.user_id AND c.scenario_id=h.scenario_id
            AND c.subject_type=h.subject_type AND c.subject_id=h.subject_id AND c.event_type=h.event_type
            AND c.source=h.source AND c.auth_result=h.auth_result AND c.sampling_method=h.sampling_method
            AND c.sampling_unit=h.sampling_unit AND ifNull(c.sampling_rate,-1)=ifNull(h.sampling_rate,-1)
        LEFT JOIN coverage AS v ON c.run_id=v.run_id AND c.user_id=v.user_id AND c.scenario_id=v.scenario_id
            AND c.event_type=v.event_type
        LEFT JOIN configs AS f ON c.run_id=f.run_id AND c.user_id=f.user_id AND c.scenario_id=f.scenario_id
        LEFT JOIN config_history AS g ON c.run_id=g.run_id AND c.user_id=g.user_id AND c.scenario_id=g.scenario_id
        LEFT JOIN night_totals AS n ON c.run_id=n.run_id AND c.user_id=n.user_id AND c.scenario_id=n.scenario_id
            AND c.subject_type=n.subject_type AND c.subject_id=n.subject_id AND c.event_type=n.event_type
            AND c.source=n.source AND c.auth_result=n.auth_result AND c.sampling_method=n.sampling_method
            AND c.sampling_unit=n.sampling_unit AND ifNull(c.sampling_rate,-1)=ifNull(n.sampling_rate,-1)
    ),
    evaluated AS
    (
        SELECT *,
            arrayFilter(w -> arrayReduce('intervalLengthSum',
                    arrayMap(v -> greatest(v.1,w.1),arrayFilter(v -> v.1 < w.2 AND v.2 > w.1 AND v.3 = 1
                        AND v.4 = ifNull(sampling_rate,-1) AND v.5 = sampling_method,coverage_intervals)),
                    arrayMap(v -> least(v.2,w.2),arrayFilter(v -> v.1 < w.2 AND v.2 > w.1 AND v.3 = 1
                        AND v.4 = ifNull(sampling_rate,-1) AND v.5 = sampling_method,coverage_intervals))) >= w.2-w.1
                AND arrayExists(g -> g.1 <= w.1 AND g.2 >= w.2 AND g.3 IS NOT NULL
                    AND g.4 IS NOT NULL AND g.5 IS NOT NULL
                    AND ifNull(g.3,'') = ifNull(cfg.1,'') AND ifNull(g.4,65535) = ifNull(cfg.2,65535)
                    AND ifNull(g.5,65535) = ifNull(cfg.3,65535),historical_configs)
                AND NOT arrayExists(e -> e.1 >= w.1 AND e.1 < w.2 AND e.3 = 1,history_events),
                historical_windows) AS valid_history_windows,
            if(cfg.1 = 'Asia/Shanghai' AND cfg.2 IS NOT NULL AND cfg.3 IS NOT NULL,
                arraySum(arrayMap(t -> if(
                    if(cfg.2 <= cfg.3,
                        toHour(toDateTime(intDiv(t,1000),'Asia/Shanghai'))*60
                            + toMinute(toDateTime(intDiv(t,1000),'Asia/Shanghai')) >= cfg.2
                        AND toHour(toDateTime(intDiv(t,1000),'Asia/Shanghai'))*60
                            + toMinute(toDateTime(intDiv(t,1000),'Asia/Shanghai')) < cfg.3,
                        toHour(toDateTime(intDiv(t,1000),'Asia/Shanghai'))*60
                            + toMinute(toDateTime(intDiv(t,1000),'Asia/Shanghai')) >= cfg.2
                        OR toHour(toDateTime(intDiv(t,1000),'Asia/Shanghai'))*60
                            + toMinute(toDateTime(intDiv(t,1000),'Asia/Shanghai')) < cfg.3),
                    greatest(toInt64(0),least(t+60000,end_ms)-greatest(t,start_ms)),toInt64(0)),minute_starts))
                    / 1000.0,NULL) AS night_window_seconds
        FROM combined
    ),
    baseline AS
    (
        SELECT *,arrayMap(w -> toFloat64(arrayCount(e -> e.1 >= w.1 AND e.1 < w.2 AND e.2 = 1,
            history_events)),valid_history_windows) AS baseline_counts
        FROM evaluated
    ),
    measured AS
    (
        SELECT *,if(length(baseline_counts) >= 4 AND window_s > 0 AND window_s <= 86400
                AND off_hours_unknown_count = 0 AND cfg.1 = 'Asia/Shanghai',
            (arraySort(baseline_counts)[intDiv(length(baseline_counts)+1,2)]
                + arraySort(baseline_counts)[intDiv(length(baseline_counts),2)+1]) / 2.0,NULL) AS baseline_median
        FROM baseline
    )
SELECT run_id,user_id,scenario_id,subject_type,subject_id,event_type,source,auth_result,
    sampling_method,sampling_unit,sampling_rate,p_start AS window_start,p_end AS window_end,
    if(off_hours_unknown_count = 0,'AVAILABLE','UNAVAILABLE') AS compute_status,
    if(off_hours_unknown_count = 0,'','MISSING_TIMEZONE_OR_OFF_HOURS_CONFIG') AS reason_code,
    'OBSERVED' AS value_kind,observed_event_count,off_hours_unknown_count,
    cfg.1 AS business_timezone,cfg.4 AS off_hours_config_version,
    if(off_hours_unknown_count = 0,night_event_n,NULL) AS off_hours_event_count,
    if(off_hours_unknown_count = 0,night_active_video_n,NULL) AS active_video_count_obs,
    if(off_hours_unknown_count = 0,length(active_minutes),NULL) AS off_hours_active_minutes,
    if(off_hours_unknown_count = 0,if(length(active_minutes) > 0,
        arrayMax(arrayMap(x -> length(x),arraySplit((m,d) -> d != 1,active_minutes,arrayDifference(active_minutes)))),0),NULL)
        AS longest_active_run,
    if(off_hours_unknown_count = 0,night_event_n / nullIf(toFloat64(observed_event_count),0),NULL)
        AS off_hours_activity_ratio_obs,
    night_window_seconds,
    if(event_type = 'TS_VALIDATE' AND auth_result = 1 AND off_hours_unknown_count = 0
        AND night_manifest_unknown_count = 0 AND night_window_seconds > 0,
        ifNull(night_unique_media_seconds,0) / nullIf(night_window_seconds,0),NULL) AS off_hours_speed_ratio,
    if(event_type = 'TS_VALIDATE' AND auth_result = 1 AND off_hours_unknown_count = 0
        AND night_manifest_unknown_count = 0,ifNull(night_unique_media_seconds,0),NULL)
        AS off_hours_unique_media_seconds_obs,
    length(baseline_counts) AS baseline_history_days,
    baseline_median AS off_hours_baseline_median,
    if(baseline_median IS NOT NULL,night_event_n-baseline_median,NULL) AS off_hours_baseline_delta,
    if(baseline_median > 0,night_event_n / nullIf(baseline_median,0),NULL) AS off_hours_baseline_multiplier,
    multiIf(window_s <= 0 OR window_s > 86400,'UNSUPPORTED_BASELINE_WINDOW',off_hours_unknown_count > 0
        OR ifNull(cfg.1,'') != 'Asia/Shanghai','MISSING_OR_UNSUPPORTED_TIMEZONE_CONFIG',
        length(baseline_counts) < 4,'INSUFFICIENT_HISTORY','AVAILABLE') AS baseline_status,
    multiIf(baseline_median IS NULL,'UNAVAILABLE',baseline_median = 0,'ZERO_BASELINE','AVAILABLE') AS multiplier_status,
    'PREVIOUS_8_SAME_WEEKDAYS_MIN_4_COVERED_WINDOWS' AS baseline_method,
    toUInt8(0) AS single_event_risk_score
FROM measured
ORDER BY scenario_id,subject_type,subject_id,event_type,source,auth_result
