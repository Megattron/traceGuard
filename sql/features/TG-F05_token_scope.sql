-- TG-F05 / R4A. Historical snapshot selection precedes expiry/revocation checks.
-- Native subject: TOKEN; event_type separates authorization and delivery stages.
WITH
    snapshots AS
    (
        SELECT scenario_id, token_ref,
            groupArray((effective_at, expires_at, revoked, allowed_video_ids, policy_version)) AS versions
        FROM da.tg_validation_token_snapshots FINAL
        WHERE run_id = {run_id:String} AND user_id = {user_id:String}
          AND ({scenario_id:String} = '' OR scenario_id = {scenario_id:String})
          AND effective_at < {window_end:DateTime64(3)}
        GROUP BY scenario_id, token_ref
    ),
    selected AS
    (
        SELECT e.*,
            arraySort(x -> x.1,
                arrayFilter(x -> x.1 <= e.event_time, s.versions)) AS eligible_versions
        FROM da.tg_validation_event_features AS e
        LEFT JOIN snapshots AS s USING (scenario_id, token_ref)
        WHERE e.run_id = {run_id:String} AND e.user_id = {user_id:String}
          AND ({scenario_id:String} = '' OR e.scenario_id = {scenario_id:String})
          AND e.event_time >= {window_start:DateTime64(3)}
          AND e.event_time < {window_end:DateTime64(3)}
          AND e.token_ref != ''
          AND e.event_type IN ('MANIFEST_REQUEST', 'HLS_KEY_VALIDATE', 'KEY_RESPONSE',
                               'TS_VALIDATE', 'CDN_MEDIA_ACCESS', 'REQUEST_REJECTED')
    ),
    evaluated AS
    (
        SELECT *,
            arrayElement(eligible_versions, -1) AS snapshot,
            notEmpty(eligible_versions) AS has_snapshot,
            multiIf(NOT has_snapshot, 'UNKNOWN', snapshot.3 = 1, 'REVOKED',
                    event_time >= snapshot.2, 'EXPIRED', 'VALID') AS token_validity_at_event,
            multiIf(NOT has_snapshot OR video_id = '', 'UNKNOWN',
                    has(snapshot.4, video_id), 'INSIDE', 'OUTSIDE') AS scope_relation
        FROM selected
    )
SELECT
    'TG-F05' AS feature_group, {run_id:String} AS run_id, {user_id:String} AS user_id,
    scenario_id, 'TOKEN' AS subject_type, token_ref AS subject_id, token_ref, event_type,
    {window_start:DateTime64(3)} AS window_start,
    {window_end:DateTime64(3)} AS window_end,
    count() AS observed_event_count,
    countIf(has_snapshot) AS eligible_count,
    countIf(NOT has_snapshot OR video_id = '') AS unknown_count,
    uniqExactIf(video_id, video_id != '') AS token_video_count_obs,
    countIf(token_validity_at_event = 'VALID') AS token_valid_event_count,
    countIf(token_validity_at_event = 'EXPIRED') AS token_expired_event_count,
    countIf(token_validity_at_event = 'REVOKED') AS token_revoked_event_count,
    countIf(token_validity_at_event = 'UNKNOWN') AS token_validity_unknown_count,
    countIf(scope_relation = 'OUTSIDE') AS out_of_scope_attempt_count_obs,
    uniqExactIf(video_id, scope_relation = 'OUTSIDE') AS out_of_scope_video_count_obs,
    countIf(scope_relation = 'OUTSIDE' AND auth_result = 1) AS out_of_scope_auth_pass_count_obs,
    countIf(scope_relation = 'OUTSIDE' AND event_type = 'CDN_MEDIA_ACCESS'
            AND http_status IN (200, 206) AND response_bytes > 0) AS out_of_scope_delivery_count_obs,
    groupArray(20)((event_id, token_validity_at_event, scope_relation,
                    if(has_snapshot, snapshot.5, 'UNKNOWN'))) AS event_scope_evidence,
    if(eligible_count = 0, 'UNAVAILABLE', 'AVAILABLE') AS compute_status,
    multiIf(eligible_count = 0, 'MISSING_TOKEN_HISTORY', unknown_count > 0,
            'PARTIAL_UNKNOWN_SCOPE', '') AS reason_code,
    'OBSERVED' AS value_kind,
    groupUniqArray(20)(association_status) AS association_statuses
FROM evaluated
GROUP BY scenario_id, token_ref, event_type
ORDER BY scenario_id, token_ref, event_type
