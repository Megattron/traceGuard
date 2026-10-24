-- TG-F07 / R5. VIEWER and CREDENTIAL_VIEWER are separate identity scopes.
-- Only client-side TS_VALIDATE events participate in environment comparisons.
WITH
    base AS
    (
        SELECT * FROM da.tg_validation_event_features
        WHERE run_id = {run_id:String} AND user_id = {user_id:String}
          AND ({scenario_id:String} = '' OR scenario_id = {scenario_id:String})
          AND event_time >= {window_start:DateTime64(3)}
          AND event_time < {window_end:DateTime64(3)}
          AND event_type = 'TS_VALIDATE' AND is_client_event = 1
    ),
    ip_map AS
    (
        SELECT request_ip, any(country) AS country, any(province) AS province,
            any(isp) AS isp, any(mapping_version) AS mapping_version
        FROM da.tg_validation_ip_info FINAL
        WHERE run_id = {run_id:String}
        GROUP BY request_ip
    ),
    time_groups AS
    (
        SELECT scenario_id, subject_type, subject_id, event_time,
            count() AS timestamp_event_count, any(env_ref) AS env
        FROM base GROUP BY scenario_id, subject_type, subject_id, event_time
    ),
    sequences AS
    (
        SELECT scenario_id, subject_type, subject_id,
            arraySort(x -> x.1, groupArray((event_time, timestamp_event_count, env))) AS seq
        FROM time_groups GROUP BY scenario_id, subject_type, subject_id
    ),
    transitions AS
    (
        SELECT *, arrayFilter(i -> i > 1 AND seq[i].2 = 1 AND seq[i - 1].2 = 1
                AND isNotNull(seq[i].3) AND isNotNull(seq[i - 1].3)
                AND seq[i].3 != seq[i - 1].3, arrayEnumerate(seq)) AS changed_positions
        FROM sequences
    ),
    counts AS
    (
        SELECT b.scenario_id AS scenario_id, b.subject_type AS subject_type,
            b.subject_id AS subject_id, count() AS observed_event_count,
            countIf(isNull(b.env_ref)) AS unknown_env_count,
            countIf(isNull(b.user_agent) OR b.ua_family IN ('UNKNOWN', '')) AS unknown_ua_count,
            uniqExactIf(b.client_ip, isNotNull(b.client_ip)) AS ip_count,
            uniqExactIf((b.ua_family, b.os_family, b.sdk_family), b.ua_family NOT IN ('UNKNOWN', '')) AS ua_count,
            uniqExactIf(b.env_ref, isNotNull(b.env_ref)) AS environment_count,
            countIf(m.mapping_version != '') AS ip_enriched_event_count,
            uniqExactIf(concat(m.country, '/', m.province), m.mapping_version != '') AS region_count,
            uniqExactIf(m.isp, m.mapping_version != '' AND m.isp != '') AS isp_count,
            max(ifNull(b.sampling_rate, 0) < 1) AS sampled,
            groupUniqArray(10)(b.identity_basis) AS identity_bases
        FROM base AS b LEFT JOIN ip_map AS m ON b.client_ip = m.request_ip
        GROUP BY b.scenario_id, b.subject_type, b.subject_id
    )
SELECT
    'TG-F07' AS feature_group, {run_id:String} AS run_id, {user_id:String} AS user_id,
    c.scenario_id AS scenario_id, c.subject_type AS subject_type, c.subject_id AS subject_id,
    {window_start:DateTime64(3)} AS window_start,
    {window_end:DateTime64(3)} AS window_end,
    observed_event_count, unknown_env_count, unknown_ua_count,
    if(c.subject_type = 'UNKNOWN', NULL, ip_count) AS subject_ip_count_obs,
    if(c.subject_type = 'UNKNOWN', NULL, ua_count) AS ua_class_count_obs,
    if(c.subject_type = 'UNKNOWN', NULL, environment_count) AS env_count_obs,
    if(c.subject_type = 'UNKNOWN', NULL, length(changed_positions)) AS env_transition_count,
    arrayMap(i -> toUnixTimestamp64Milli(seq[i].1) - toUnixTimestamp64Milli(seq[i - 1].1), changed_positions)
        AS env_transition_gap_ms,
    if(c.subject_type = 'UNKNOWN' OR ip_enriched_event_count = 0, NULL, region_count)
        AS region_count_obs,
    if(c.subject_type = 'UNKNOWN' OR ip_enriched_event_count = 0, NULL, isp_count)
        AS isp_count_obs,
    ip_enriched_event_count,
    if(ip_enriched_event_count = 0, 'UNAVAILABLE', 'AVAILABLE') AS ip_enrichment_status,
    arrayCount(x -> x.2 > 1, seq) AS timestamp_tie_group_count,
    identity_bases,
    if(c.subject_type = 'UNKNOWN', 'UNAVAILABLE', 'AVAILABLE') AS compute_status,
    multiIf(c.subject_type = 'UNKNOWN', 'IDENTITY_UNKNOWN', unknown_env_count > 0,
            'PARTIAL_UNKNOWN_ENVIRONMENT', '') AS reason_code,
    if(sampled, 'LOWER_BOUND', 'OBSERVED') AS value_kind
FROM counts AS c
LEFT JOIN transitions AS t USING (scenario_id, subject_type, subject_id)
ORDER BY scenario_id, subject_type, subject_id
