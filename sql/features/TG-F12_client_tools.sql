-- TG-F12 / R10. Tool signatures are declarations, not proof of piracy.
-- Backend API UA is explicitly excluded; legitimate-tool labels remain visible.
WITH base AS
(
    SELECT * FROM da.tg_validation_event_features
    WHERE run_id = {run_id:String} AND user_id = {user_id:String}
      AND ({scenario_id:String} = '' OR scenario_id = {scenario_id:String})
      AND event_time >= {window_start:DateTime64(3)}
      AND event_time < {window_end:DateTime64(3)}
)
SELECT
    'TG-F12' AS feature_group, {run_id:String} AS run_id, {user_id:String} AS user_id,
    scenario_id, subject_type, subject_id, video_id, token_ref, session_ref,
    {window_start:DateTime64(3)} AS window_start,
    {window_end:DateTime64(3)} AS window_end,
    count() AS observed_event_count,
    countIf(is_client_event = 1) AS eligible_count,
    countIf(is_client_event = 0) AS excluded_server_event_count,
    countIf(is_client_event = 1 AND (isNull(user_agent) OR ua_family IN ('UNKNOWN', '')))
        AS unknown_ua_count,
    countIf(is_client_event = 1 AND is_tool_ua = 1) AS tool_event_count_obs,
    uniqExactIf(event_type, is_client_event = 1 AND is_tool_ua = 1)
        AS tool_request_stage_count_obs,
    countIf(is_client_event = 1 AND is_tool_ua = 1 AND known_legitimate_tool = 1)
        AS known_legitimate_tool_event_count,
    groupUniqArrayIf(20)(tool_signature_code, is_client_event = 1 AND is_tool_ua = 1)
        AS tool_signature_codes,
    groupUniqArrayIf(10)(ua_parser_version, is_client_event = 1) AS ua_parser_versions,
    groupArrayIf(20)((event_id, event_type, user_agent, tool_signature_code,
                     known_legitimate_tool), is_client_event = 1 AND is_tool_ua = 1)
        AS tool_event_evidence,
    if(eligible_count = 0, 'UNAVAILABLE', 'AVAILABLE') AS compute_status,
    multiIf(eligible_count = 0, 'NO_CLIENT_EVENTS', unknown_ua_count > 0,
            'PARTIAL_UNKNOWN_UA', '') AS reason_code,
    'OBSERVED' AS value_kind,
    groupUniqArray(10)(identity_basis) AS identity_bases,
    groupUniqArray(10)(association_status) AS association_statuses
FROM base
GROUP BY scenario_id, subject_type, subject_id, video_id, token_ref, session_ref
ORDER BY scenario_id, subject_type, subject_id, video_id, token_ref, session_ref
