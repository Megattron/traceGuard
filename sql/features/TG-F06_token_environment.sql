-- TG-F06 / R4B. TS_VALIDATE only, with one comparable client IP/UA source.
-- Environment span overlap is an observation proxy; pair alternation is separate.
WITH
    base AS
    (
        SELECT * FROM da.tg_validation_event_features
        WHERE run_id = {run_id:String} AND user_id = {user_id:String}
          AND ({scenario_id:String} = '' OR scenario_id = {scenario_id:String})
          AND event_time >= {window_start:DateTime64(3)}
          AND event_time < {window_end:DateTime64(3)}
          AND event_type = 'TS_VALIDATE' AND is_client_event = 1 AND token_ref != ''
    ),
    counts AS
    (
        SELECT scenario_id, token_ref, count() AS observed_event_count,
            countIf(auth_result = 1) AS auth_pass_count_obs,
            countIf(isNull(env_ref)) AS unknown_env_count,
            countIf(isNull(user_agent) OR ua_family IN ('UNKNOWN', '')) AS unknown_ua_count,
            uniqExactIf(client_ip, isNotNull(client_ip)) AS token_ip_count_obs,
            uniqExactIf((ua_family, os_family, sdk_family), ua_family NOT IN ('UNKNOWN', '')) AS token_ua_class_count_obs,
            uniqExactIf(env_ref, isNotNull(env_ref)) AS token_env_count_obs,
            max(ifNull(sampling_rate, 0) < 1) AS sampled,
            groupUniqArray(10)(association_status) AS association_statuses
        FROM base GROUP BY scenario_id, token_ref
    ),
    environments AS
    (
        SELECT scenario_id, token_ref, assumeNotNull(env_ref) AS environment,
            min(event_time) AS first_ts, max(event_time) AS last_ts,
            count() AS environment_event_count,
            countIf(auth_result = 1) AS environment_auth_pass_count,
            any(ua_family) AS client_class, any(os_family) AS operating_system,
            any(sdk_family) AS sdk_class
        FROM base WHERE isNotNull(env_ref)
        GROUP BY scenario_id, token_ref, environment
    ),
    environment_arrays AS
    (
        SELECT scenario_id, token_ref,
            groupArray((environment, first_ts, last_ts, environment_event_count,
                        environment_auth_pass_count, client_class, operating_system, sdk_class))
                AS environment_details
        FROM environments GROUP BY scenario_id, token_ref
    ),
    time_groups AS
    (
        SELECT scenario_id, token_ref, event_time, count() AS timestamp_event_count,
            any(env_ref) AS environment
        FROM base GROUP BY scenario_id, token_ref, event_time
    ),
    sequences AS
    (
        SELECT scenario_id, token_ref,
            arraySort(x -> x.1,
                groupArray((event_time, timestamp_event_count, environment))) AS sequence
        FROM time_groups GROUP BY scenario_id, token_ref
    ),
    context AS
    (
        SELECT c.scenario_id AS scenario_id, c.token_ref AS token_ref,
            c.observed_event_count AS observed_event_count, c.auth_pass_count_obs AS auth_pass_count_obs,
            c.unknown_env_count AS unknown_env_count, c.unknown_ua_count AS unknown_ua_count,
            c.token_ip_count_obs AS token_ip_count_obs,
            c.token_ua_class_count_obs AS token_ua_class_count_obs,
            c.token_env_count_obs AS token_env_count_obs, c.sampled AS sampled,
            c.association_statuses AS association_statuses,
            e.environment_details AS environment_details, s.sequence AS sequence,
            arrayCount(i -> i > 1 AND sequence[i].2 = 1 AND sequence[i - 1].2 = 1
                AND isNotNull(sequence[i].3) AND isNotNull(sequence[i - 1].3)
                AND sequence[i].3 != sequence[i - 1].3, arrayEnumerate(sequence))
                AS env_switch_count,
            arrayFilter(p -> p.1.1 < p.2.1,
                arrayFlatten(arrayMap(a -> arrayMap(b -> tuple(a, b), environment_details),
                                      environment_details))) AS pairs
        FROM counts AS c
        LEFT JOIN environment_arrays AS e ON c.scenario_id = e.scenario_id AND c.token_ref = e.token_ref
        LEFT JOIN sequences AS s ON c.scenario_id = s.scenario_id AND c.token_ref = s.token_ref
    ),
    pair_sequences AS
    (
        SELECT scenario_id, token_ref, pair,
            -- Tied timestamp groups are excluded; no event-id tie breaking is invented.
            arrayFilter(x -> x.2 = 1 AND isNotNull(x.3)
                AND (x.3 = pair.1.1 OR x.3 = pair.2.1), sequence) AS pair_sequence,
            greatest(0, toUnixTimestamp64Milli(least(pair.1.3, pair.2.3))
                - toUnixTimestamp64Milli(greatest(pair.1.2, pair.2.2))) / 1000.0 AS overlap_s
        FROM context ARRAY JOIN pairs AS pair
    ),
    pair_metrics AS
    (
        SELECT *,
            arrayCount(i -> i > 1 AND pair_sequence[i].3 != pair_sequence[i - 1].3,
                       arrayEnumerate(pair_sequence)) AS pair_switch_count
        FROM pair_sequences
    ),
    pair_aggregates AS
    (
        SELECT scenario_id, token_ref,
            countIf(pair_switch_count >= 3) AS interleaved_env_pair_count,
            countIf(pair_switch_count >= 2) AS return_env_pair_count,
            max(overlap_s) AS max_env_observed_span_overlap_s,
            countIf(pair.1.6 != pair.2.6 OR pair.1.7 != pair.2.7 OR pair.1.8 != pair.2.8)
                AS declared_client_difference_pair_count,
            groupArray((pair.1.1, pair.2.1, overlap_s, pair_switch_count)) AS environment_pair_details
        FROM pair_metrics GROUP BY scenario_id, token_ref
    )
SELECT
    'TG-F06' AS feature_group, {run_id:String} AS run_id, {user_id:String} AS user_id,
    c.scenario_id AS scenario_id, 'TOKEN' AS subject_type, c.token_ref AS subject_id,
    c.token_ref AS token_ref,
    {window_start:DateTime64(3)} AS window_start,
    {window_end:DateTime64(3)} AS window_end,
    observed_event_count, auth_pass_count_obs, unknown_env_count, unknown_ua_count,
    token_env_count_obs, token_ip_count_obs, token_ua_class_count_obs,
    environment_details,
    env_switch_count, interleaved_env_pair_count, return_env_pair_count,
    max_env_observed_span_overlap_s AS env_observed_span_overlap_s,
    environment_pair_details, declared_client_difference_pair_count,
    arrayCount(x -> x.2 > 1, sequence) AS timestamp_tie_group_count,
    if(token_env_count_obs = 0, 'UNAVAILABLE', 'AVAILABLE') AS compute_status,
    multiIf(token_env_count_obs = 0, 'NO_KNOWN_ENVIRONMENT', unknown_env_count > 0,
            'PARTIAL_UNKNOWN_ENVIRONMENT', '') AS reason_code,
    if(sampled, 'LOWER_BOUND', 'OBSERVED') AS value_kind,
    'OBSERVED_SEQUENCE' AS sequence_value_kind,
    association_statuses
FROM context AS c
LEFT JOIN pair_aggregates AS p ON c.scenario_id = p.scenario_id AND c.token_ref = p.token_ref
ORDER BY scenario_id, token_ref
