-- TG-F02 / R1. TS success is not media delivery. Missing observations are not bypasses.
-- Reliable session_ref narrows the context; otherwise use TOKEN_VIDEO observations.
-- requires_* does not specify terminal step order, so strict order violations are NULL.
WITH
    coverage AS
    (
        SELECT scenario_id,
            groupArray((event_type, coverage_start, coverage_end, is_complete,
                        requires_token, requires_manifest, requires_key,
                        key_validity_seconds, protocol_version, sampling_rate)) AS coverage_rows
        FROM da.tg_validation_source_coverage FINAL
        WHERE run_id = {run_id:String} AND user_id = {user_id:String}
          AND ({scenario_id:String} = '' OR scenario_id = {scenario_id:String})
          AND coverage_start < {window_end:DateTime64(3)}
        GROUP BY scenario_id
    ),
    snapshots AS
    (
        SELECT scenario_id, token_ref,
            groupArray((effective_at, original_issued_at, expires_at, revoked)) AS versions
        FROM da.tg_validation_token_snapshots FINAL
        WHERE run_id = {run_id:String} AND user_id = {user_id:String}
          AND ({scenario_id:String} = '' OR scenario_id = {scenario_id:String})
          AND effective_at < {window_end:DateTime64(3)}
        GROUP BY scenario_id, token_ref
    ),
    history AS
    (
        SELECT scenario_id, token_ref, video_id,
            groupArray((event_type, event_time, session_ref, auth_result, http_status,
                        response_completed, key_valid_until)) AS records
        FROM da.tg_validation_event_features
        WHERE run_id = {run_id:String} AND user_id = {user_id:String}
          AND ({scenario_id:String} = '' OR scenario_id = {scenario_id:String})
          AND event_time < {window_end:DateTime64(3)}
          AND event_type IN ('TOKEN_CREATE', 'TOKEN_RENEW', 'MANIFEST_REQUEST',
                             'HLS_KEY_VALIDATE', 'KEY_RESPONSE')
        GROUP BY scenario_id, token_ref, video_id
    ),
    inputs AS
    (
        SELECT e.scenario_id AS scenario_id, e.token_ref AS token_ref,
            e.video_id AS video_id, e.event_id AS event_id, e.event_time AS event_time,
            e.session_ref AS session_ref, e.association_status AS association_status,
            e.auth_result AS auth_result,
            c.coverage_rows AS coverage_rows,
            arrayFilter(x -> x.1 = 'TS_VALIDATE' AND x.2 <= e.event_time
                            AND x.3 > e.event_time, c.coverage_rows) AS protocol_rows,
            arraySort(x -> x.1, arrayFilter(x -> x.1 <= e.event_time, s.versions)) AS prior_versions,
            arraySort(x -> x.2, arrayFilter(x -> x.2 <= e.event_time
                AND (isNull(e.session_ref) OR isNull(x.3) OR x.3 = e.session_ref
                     OR x.1 IN ('TOKEN_CREATE', 'TOKEN_RENEW')), h.records)) AS prior_records
        FROM da.tg_validation_event_features AS e
        LEFT JOIN coverage AS c ON e.scenario_id = c.scenario_id
        LEFT JOIN snapshots AS s ON e.scenario_id = s.scenario_id AND e.token_ref = s.token_ref
        LEFT JOIN history AS h ON e.scenario_id = h.scenario_id AND e.token_ref = h.token_ref
            AND e.video_id = h.video_id
        WHERE e.run_id = {run_id:String} AND e.user_id = {user_id:String}
          AND ({scenario_id:String} = '' OR e.scenario_id = {scenario_id:String})
          AND e.event_time >= {window_start:DateTime64(3)}
          AND e.event_time < {window_end:DateTime64(3)}
          AND e.event_type = 'TS_VALIDATE'
    ),
    context AS
    (
        SELECT *, arrayElement(protocol_rows, -1) AS protocol,
            length(protocol_rows) = 1 AND protocol.9 != '' AS protocol_known,
            arrayElement(prior_versions, -1) AS snapshot,
            notEmpty(prior_versions) AS has_snapshot,
            arrayFilter(x -> x.1 = 'KEY_RESPONSE' AND x.2 < event_time AND x.5 = 200
                AND x.6 = 1 AND ((isNotNull(x.7) AND x.7 > event_time)
                    OR (isNull(x.7) AND protocol_known AND protocol.8 > 0
                        AND addSeconds(x.2, protocol.8) > event_time)), prior_records) AS keys,
            arrayFilter(x -> x.1 = 'MANIFEST_REQUEST' AND x.2 < event_time
                AND x.5 = 200, prior_records) AS manifests,
            arrayFilter(x -> x.1 IN ('TOKEN_CREATE', 'TOKEN_RENEW') AND x.2 < event_time
                AND x.4 = 1, prior_records) AS tokens,
            arrayExists(x -> x.1 = 'KEY_RESPONSE' AND x.2 = event_time AND x.5 = 200,
                        prior_records) AS key_time_tie,
            arrayExists(x -> x.1 = 'MANIFEST_REQUEST' AND x.2 = event_time AND x.5 = 200,
                        prior_records) AS manifest_time_tie,
            arrayExists(x -> x.1 IN ('TOKEN_CREATE', 'TOKEN_RENEW') AND x.2 = event_time
                AND x.4 = 1, prior_records) AS token_time_tie,
            arrayExists(x -> x.1 = 'KEY_RESPONSE' AND x.4 = 1 AND x.10 = 1
                AND x.2 <= subtractSeconds(event_time, protocol.8)
                AND x.3 > event_time, coverage_rows) AS complete_key_lookback,
            arrayExists(x -> x.1 = 'MANIFEST_REQUEST' AND x.4 = 1 AND x.10 = 1
                AND has_snapshot AND x.2 <= snapshot.2 AND x.3 > event_time,
                coverage_rows) AS complete_manifest_lookback,
            arrayExists(x -> x.1 = 'TOKEN_CREATE' AND x.4 = 1 AND x.10 = 1
                AND has_snapshot AND x.2 <= snapshot.2 AND x.3 > event_time,
                coverage_rows) AS complete_token_lookback
        FROM inputs
    ),
    steps AS
    (
        SELECT *,
            if(notEmpty(tokens), toNullable(toUInt8(1)),
                if(complete_token_lookback AND NOT token_time_tie, toNullable(toUInt8(0)), NULL))
                AS token_present,
            if(notEmpty(manifests), toNullable(toUInt8(1)),
                if(complete_manifest_lookback AND NOT manifest_time_tie, toNullable(toUInt8(0)), NULL))
                AS manifest_present,
            if(notEmpty(keys), toNullable(toUInt8(1)),
                if(protocol_known AND protocol.8 > 0 AND complete_key_lookback
                    AND NOT key_time_tie, toNullable(toUInt8(0)), NULL)) AS key_present,
            arrayElement(keys, -1) AS linked_key,
            arrayFilter(x -> x.2 < linked_key.2, manifests) AS linked_manifests,
            arrayElement(linked_manifests, -1) AS linked_manifest,
            arrayFilter(x -> x.2 < linked_manifest.2, tokens) AS linked_tokens,
            arrayElement(linked_tokens, -1) AS linked_token,
            if(notEmpty(keys), toUnixTimestamp64Milli(event_time) - toUnixTimestamp64Milli(linked_key.2), NULL)
                AS key_to_ts,
            if(notEmpty(keys) AND notEmpty(linked_manifests),
                toUnixTimestamp64Milli(linked_key.2) - toUnixTimestamp64Milli(linked_manifest.2), NULL) AS manifest_to_key,
            if(notEmpty(linked_manifests) AND notEmpty(linked_tokens),
                toUnixTimestamp64Milli(linked_manifest.2) - toUnixTimestamp64Milli(linked_token.2), NULL) AS token_to_manifest,
            multiIf(token_ref = '' OR video_id = '', 'UNKNOWN',
                isNotNull(session_ref) AND association_status = 'CONFIRMED',
                'SESSION', 'TOKEN_VIDEO') AS chain_subject_type,
            multiIf(chain_subject_type = 'UNKNOWN', event_id,
                chain_subject_type = 'SESSION', assumeNotNull(session_ref),
                concat(token_ref, '|', video_id)) AS chain_subject_id
        FROM context
    ),
    evaluated AS
    (
        SELECT *,
            protocol_known AND token_ref != '' AND video_id != ''
                AND (protocol.5 = 0 OR isNotNull(token_present))
                AND (protocol.6 = 0 OR isNotNull(manifest_present))
                AND (protocol.7 = 0 OR isNotNull(key_present)) AS missing_steps_computable,
            protocol.5 = 1 AND token_present = 0 AS missing_token,
            protocol.6 = 1 AND manifest_present = 0 AS missing_manifest,
            protocol.7 = 1 AND key_present = 0 AS missing_key
        FROM steps
    )
SELECT
    'TG-F02' AS feature_group, {run_id:String} AS run_id, {user_id:String} AS user_id,
    scenario_id, chain_subject_type AS subject_type, chain_subject_id AS subject_id,
    token_ref, video_id,
    {window_start:DateTime64(3)} AS window_start,
    {window_end:DateTime64(3)} AS window_end,
    count() AS observed_event_count,
    countIf(auth_result = 1) AS auth_pass_count_obs,
    if(countIf(token_present = 1) > 0, toNullable(toUInt8(1)),
        if(countIf(isNull(token_present)) = 0, toNullable(toUInt8(0)), NULL)) AS has_token_record,
    if(countIf(manifest_present = 1) > 0, toNullable(toUInt8(1)),
        if(countIf(isNull(manifest_present)) = 0, toNullable(toUInt8(0)), NULL)) AS has_manifest_record,
    if(countIf(key_present = 1) > 0, toNullable(toUInt8(1)),
        if(countIf(isNull(key_present)) = 0, toNullable(toUInt8(0)), NULL)) AS has_key_record,
    countIf(auth_result = 1 AND empty(keys)) AS auth_pass_segment_without_prior_key_obs,
    countIf(missing_steps_computable) AS missing_steps_eligible_count,
    countIf(NOT missing_steps_computable) AS missing_steps_unknown_count,
    if(missing_steps_unknown_count = 0,
        toNullable(toUInt8(max(ifNull(missing_token, 0)) + max(ifNull(missing_manifest, 0))
                            + max(ifNull(missing_key, 0)))), NULL) AS chain_missing_required_step_count,
    if(missing_steps_unknown_count = 0, 'AVAILABLE', 'UNAVAILABLE') AS missing_steps_compute_status,
    if(missing_steps_unknown_count = 0, '', 'SOURCE_OR_VALIDITY_NOT_COMPLETE')
        AS missing_steps_reason_code,
    CAST(NULL, 'Nullable(UInt64)') AS chain_order_violation_count,
    'UNAVAILABLE' AS chain_order_compute_status,
    'MISSING_PROTOCOL_ORDER_MODEL' AS chain_order_reason_code,
    if(countIf(isNotNull(token_to_manifest)) > 0, avg(token_to_manifest), NULL)
        AS token_to_manifest_mean_ms,
    if(countIf(isNotNull(manifest_to_key)) > 0, avg(manifest_to_key), NULL)
        AS manifest_to_key_mean_ms,
    if(countIf(isNotNull(key_to_ts)) > 0, avg(key_to_ts), NULL) AS key_to_ts_mean_ms,
    countIf(key_time_tie OR manifest_time_tie OR token_time_tie) AS step_time_tie_count,
    groupArray(20)((event_id, token_present, manifest_present, key_present,
                    token_to_manifest, manifest_to_key, key_to_ts)) AS chain_evidence,
    groupUniqArray(10)(association_status) AS association_statuses,
    'AVAILABLE' AS compute_status,
    'SEE_PER_FEATURE_STATUS' AS reason_code,
    'OBSERVED' AS value_kind
FROM evaluated
GROUP BY scenario_id, chain_subject_type, chain_subject_id, token_ref, video_id
ORDER BY scenario_id, subject_type, subject_id, token_ref, video_id
