"""Independent, deterministic inputs and hand-calculated feature expectations.

This module never queries ClickHouse. Expectations are declared before inputs;
the SQL verifier must compare against them rather than regenerate them.
"""

from datetime import datetime, timedelta


IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"
ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile Safari/537.36"


def build_fixtures(user_id: str, run_id: str, video_ids: list[str]) -> dict:
    videos = list(dict.fromkeys(video_ids))
    if not videos:
        raise ValueError("At least one source video_id is required")
    while len(videos) < 3:
        videos.append(f"synthetic_resource_fixture_{len(videos) + 1}")
    video = videos[0]
    output = {key: [] for key in (
        "events", "media_segments", "token_snapshots", "source_coverage",
        "business_config", "ip_info", "cases",
    )}

    def case(case_id, group, scenario, expected, *, start="2026-10-16 10:00:00.000",
             end="2026-10-16 10:10:00.000", where=None):
        output["cases"].append({
            "case_id": case_id, "feature_group": group, "scenario_id": scenario,
            "window_start": start, "window_end": end,
            "where": where or {}, "expected": expected,
        })

    # Fixed expected values: these are deliberately independent of input loops.
    case("V01_REPLAY_AND_RETRY", "TG-F03", "fx_replay_retry", {
        "ts_auth_pass_count_obs": 3,
        "auth_request_equivalent_seconds_obs": 30,
        "auth_unique_media_seconds_obs": 10,
        "auth_unique_speed_ratio": 1 / 60,
    }, where={"video_scope": "ALL_VIDEOS"})
    case("V02_MEDIA_UNION", "TG-F03", "fx_media_union", {
        "ts_auth_pass_count_obs": 4,
        "auth_request_equivalent_seconds_obs": 40,
        "auth_unique_media_seconds_obs": 15,
    }, where={"video_scope": "ALL_VIDEOS"})
    case("V03_SEPARATE_CONTENT_VERSION", "TG-F03", "fx_content_versions", {
        "auth_request_equivalent_seconds_obs": 20,
        "auth_unique_media_seconds_obs": 20,
    }, where={"video_scope": "ALL_VIDEOS"})
    case("V04_PARTIAL_CDN", "TG-F03", "fx_partial_cdn", {
        "cdn_response_media_seconds_obs": 20,
        "fully_served_media_seconds": 10,
    }, where={"video_scope": "ALL_VIDEOS"})
    case("V05_UNKNOWN_IS_NOT_FAIL", "TG-F09", "fx_unknown_results", {
        "auth_pass_count_obs": 3, "auth_fail_count_obs": 2,
        "auth_unknown_count_obs": 5, "auth_known_result_count_obs": 5,
        "auth_failure_ratio_obs": 0.4,
    })
    case("V06_ZERO_DENOMINATOR", "TG-F09", "fx_only_unknown", {
        "auth_pass_count_obs": 0, "auth_fail_count_obs": 0,
        "auth_unknown_count_obs": 3, "auth_known_result_count_obs": 0,
        "auth_failure_ratio_obs": None,
        "auth_failure_ratio_status": "ZERO_DENOMINATOR",
    })
    case("V07_FAILURE_CONCENTRATION", "TG-F09", "fx_failure_sources", {
        "auth_fail_count_obs": 4, "failed_token_count_obs": 2,
        "failed_ip_count_obs": 2, "top1_failed_token_share_obs": 0.75,
        "top1_failed_ip_share_obs": 0.5,
    })
    case("V08_SEQUENCE", "TG-F08", "fx_sequence", {
        "unique_segment_count_obs": 3, "total_segments": 4,
        "coverage_ratio_obs": 0.75, "monotonic_ratio_obs": 0.5,
        "repeat_segment_count": 2, "backward_step_count": 1,
        "request_gap_mean_ms": 10000, "request_gap_std_ms": 0,
        "interval_cv_obs": 0,
    })
    case("V09_TIED_SEQUENCE", "TG-F08", "fx_sequence_tie", {
        "monotonic_ratio_obs": None, "timestamp_tie_count": 1,
        "order_unknown_pair_count": 1, "interval_cv_obs": None,
    })
    case("V10_SEQUENTIAL_VIDEOS", "TG-F04", "fx_sequential_videos", {
        "window_active_video_count_obs": 3,
        "playback_state_concurrent_video_count": 1,
    }, end="2026-10-16 10:05:00.000")
    case("V11_NO_TRUSTED_STATE", "TG-F04", "fx_no_state", {
        "window_active_video_count_obs": 3,
        "playback_state_concurrent_video_count": None,
        "request_active_interval_overlap_proxy": None,
        "playback_state_compute_status": "UNAVAILABLE",
        "playback_state_reason_code": "MISSING_TRUSTED_STATE",
    }, end="2026-10-16 10:05:00.000")
    case("V12_CONCURRENT_STATE", "TG-F04", "fx_concurrent_state", {
        "window_active_video_count_obs": 3,
        "playback_state_concurrent_video_count": 3,
    }, end="2026-10-16 10:05:00.000")
    case("V13_ENV_SINGLE_SWITCH", "TG-F06", "fx_env_switch", {
        "token_env_count_obs": 2, "env_switch_count": 1,
        "interleaved_env_pair_count": 0,
    })
    case("V14_ENV_INTERLEAVED", "TG-F06", "fx_env_interleaved", {
        "token_env_count_obs": 2, "token_ip_count_obs": 2,
        "token_ua_class_count_obs": 2, "env_switch_count": 19,
        "interleaved_env_pair_count": 1,
        "env_observed_span_overlap_s": 170,
    })
    case("V15_ENV_TIED", "TG-F06", "fx_env_tie", {
        "token_env_count_obs": 2, "env_switch_count": 0,
        "interleaved_env_pair_count": 0,
    })
    case("V16_ENV_MISSING_UA", "TG-F07", "fx_missing_ua", {
        "subject_ip_count_obs": 1, "ua_class_count_obs": 0,
        "env_count_obs": 0, "unknown_ua_count": 2,
    }, start="2026-10-16 10:00:00.000", end="2026-10-16 11:00:00.000")
    case("V17_SCOPE_HISTORY", "TG-F05", "fx_scope_history", {
        "token_video_count_obs": 2, "out_of_scope_attempt_count_obs": 1,
        "out_of_scope_video_count_obs": 1,
        "out_of_scope_auth_pass_count_obs": 1,
        "token_valid_event_count": 3, "token_expired_event_count": 3,
    }, start="2026-10-16 09:00:00.000", end="2026-10-16 09:40:00.000",
         where={"event_type": "TS_VALIDATE"})
    case("V18_ACTIVE_MINUTES", "TG-F10", "fx_active_minutes", {
        "active_minute_count_obs": 4, "longest_observed_active_minute_run": 3,
        "max_observed_request_gap_s": 120,
        "active_minute_fraction_obs": 4 / 1440,
        "unique_media_seconds_24h": 50, "request_equivalent_seconds_24h": 50,
    }, start="2026-10-16 00:00:00.000", end="2026-10-17 00:00:00.000")
    case("V19_NIGHT_BOUNDARIES", "TG-F11", "fx_night_boundary", {
        "off_hours_event_count": 2, "off_hours_activity_ratio_obs": 0.5,
        "off_hours_active_minutes": 2, "baseline_history_days": 0,
        "off_hours_baseline_median": None,
        "baseline_status": "INSUFFICIENT_HISTORY",
    }, start="2026-10-16 00:00:00.000", end="2026-10-17 00:00:00.000",
         where={"event_type": "TS_VALIDATE", "auth_result": 1})
    case("V20_NIGHT_HISTORY_MEDIAN", "TG-F11", "fx_night_history", {
        "off_hours_event_count": 40, "baseline_history_days": 4,
        "off_hours_baseline_median": 25, "off_hours_baseline_delta": 15,
        "off_hours_baseline_multiplier": 1.6,
        "baseline_status": "AVAILABLE", "multiplier_status": "AVAILABLE",
    }, start="2026-10-16 00:00:00.000", end="2026-10-17 00:00:00.000",
         where={"event_type": "TS_VALIDATE", "auth_result": 1})
    case("V21_ZERO_BASELINE", "TG-F11", "fx_zero_baseline", {
        "off_hours_event_count": 10, "baseline_history_days": 4,
        "off_hours_baseline_median": 0, "off_hours_baseline_delta": 10,
        "off_hours_baseline_multiplier": None,
        "baseline_status": "AVAILABLE", "multiplier_status": "ZERO_BASELINE",
    }, start="2026-10-16 00:00:00.000", end="2026-10-17 00:00:00.000",
         where={"event_type": "TS_VALIDATE", "auth_result": 1})
    case("V22_SERVER_CURL", "TG-F12", "fx_server_curl", {
        "tool_event_count_obs": 0, "tool_request_stage_count_obs": 0,
    }, where={"subject_type": "VIEWER", "subject_id": "fx_viewer_fx_server_curl"})
    case("V23_CLIENT_TOOL", "TG-F12", "fx_client_tool", {
        "tool_event_count_obs": 3, "tool_request_stage_count_obs": 3,
    })
    case("V24_LATE_EVENT_TIME", "TG-F03", "fx_late", {
        "ts_auth_pass_count_obs": 1,
        "auth_request_equivalent_seconds_obs": 10,
    }, where={"video_scope": "ALL_VIDEOS"})
    case("V25_WINDOW_END_EXCLUDED", "TG-F03", "fx_window_edge", {
        "ts_auth_pass_count_obs": 1,
        "auth_request_equivalent_seconds_obs": 10,
    }, where={"video_scope": "ALL_VIDEOS"})
    case("V26_SAMPLING_LOWER_BOUND", "TG-F03", "fx_sampled", {
        "ts_auth_pass_count_obs": 2,
        "auth_request_equivalent_seconds_obs": 20,
        "auth_request_equivalent_seconds_est": 200,
        "auth_unique_media_seconds_obs": 20,
        "auth_unique_value_kind": "LOWER_BOUND",
        "estimate_status": "AVAILABLE",
    }, where={"video_scope": "ALL_VIDEOS"})
    case("V27_TWO_SOURCES", "TG-F03", "fx_two_sources", {
        "ts_auth_pass_count_obs": 1,
        "auth_request_equivalent_seconds_obs": 10,
        "auth_unique_media_seconds_obs": 10,
        "cdn_response_media_seconds_obs": 10,
        "fully_served_media_seconds": 10,
    }, where={"video_scope": "ALL_VIDEOS"})
    case("V28_KEY_CACHE_LOOKBACK", "TG-F02", "fx_cached_key", {
        "has_token_record": 1, "has_manifest_record": 1, "has_key_record": 1,
        "auth_pass_segment_without_prior_key_obs": 0,
        "chain_missing_required_step_count": 0,
        "missing_steps_compute_status": "AVAILABLE",
        "token_to_manifest_mean_ms": 60000, "manifest_to_key_mean_ms": 240000,
        "key_to_ts_mean_ms": 300000,
    })
    case("V29_KEY_CONFIRMED_MISSING", "TG-F02", "fx_missing_key_complete", {
        "has_token_record": 1, "has_manifest_record": 1, "has_key_record": 0,
        "auth_pass_segment_without_prior_key_obs": 1,
        "chain_missing_required_step_count": 1,
        "missing_steps_compute_status": "AVAILABLE",
    })
    case("V30_KEY_SOURCE_GAP", "TG-F02", "fx_missing_key_incomplete", {
        "has_key_record": None, "auth_pass_segment_without_prior_key_obs": 1,
        "chain_missing_required_step_count": None,
        "missing_steps_compute_status": "UNAVAILABLE",
    })
    case("V31_RAW_REPLAY_QUALITY", "TG-F00", "fx_replay_retry", {
        "source_observed_record_count": 4, "business_event_count": 3,
        "replay_record_count": 1, "observed_event_count": 3,
        "ingest_delay_max_ms": 60000,
    }, where={"event_type": "TS_VALIDATE"})
    for index, expected in enumerate([
        {"is_off_hours": 0, "local_hour": 1},
        {"is_off_hours": 1, "local_hour": 2},
        {"is_off_hours": 1, "local_hour": 5},
        {"is_off_hours": 0, "local_hour": 6},
    ]):
        case(f"V32_{index}_NIGHT_EVENT_BOUNDARY", "TG-F01", "fx_night_boundary", expected,
             start="2026-10-16 00:00:00.000", end="2026-10-17 00:00:00.000",
             where={"event_id": f"fx_night_boundary:event:{index}"})
    case("V33_MISSING_TIMEZONE", "TG-F01", "fx_missing_timezone", {
        "is_off_hours": None,
    }, start="2026-10-16 00:00:00.000", end="2026-10-17 00:00:00.000")
    case("V34_CREDENTIAL_IDENTITY", "TG-F01", "fx_credential_only", {
        "subject_type": "CREDENTIAL_VIEWER", "viewer_id": None,
        "subject_id": "fx_bound_viewer",
    })
    case("V35_MEDIA_DEPENDENCY_MISSING", "TG-F03", "fx_missing_manifest", {
        "ts_auth_pass_count_obs": 1, "auth_request_equivalent_seconds_obs": None,
        "auth_unique_media_seconds_obs": None, "auth_media_status": "MISSING_MANIFEST",
    }, where={"video_scope": "ALL_VIDEOS"})
    case("V36_ENV_RETURN_ONLY", "TG-F06", "fx_env_return", {
        "token_env_count_obs": 2, "env_switch_count": 2,
        "return_env_pair_count": 1, "interleaved_env_pair_count": 0,
    })
    case("V37_SCOPE_UNKNOWN", "TG-F05", "fx_scope_unknown", {
        "token_video_count_obs": 2, "token_validity_unknown_count": 2,
        "compute_status": "UNAVAILABLE", "reason_code": "MISSING_TOKEN_HISTORY",
    }, where={"event_type": "TS_VALIDATE"})
    case("V38_SAMPLING_ESTIMATE_DISABLED", "TG-F03", "fx_unknown_sampling", {
        "ts_auth_pass_count_obs": 2, "auth_request_equivalent_seconds_obs": 20,
        "auth_unique_media_seconds_obs": 20,
        "auth_request_equivalent_seconds_est": None,
        "estimate_status": "SAMPLING_ESTIMATE_DISABLED",
        "auth_unique_value_kind": "LOWER_BOUND",
    }, where={"video_scope": "ALL_VIDEOS"})
    case("V39_SAMPLED_ENV_POSITIVE", "TG-F06", "fx_sampled_environment", {
        "auth_pass_count_obs": 20, "token_env_count_obs": 2,
        "env_switch_count": 19, "interleaved_env_pair_count": 1,
        "env_observed_span_overlap_s": 170, "value_kind": "LOWER_BOUND",
    })
    case("V40_LEGITIMATE_TOOL", "TG-F12", "fx_legitimate_tool", {
        "tool_event_count_obs": 1, "tool_request_stage_count_obs": 1,
        "known_legitimate_tool_event_count": 1,
    })
    case("V41_TOKEN_REVOKED", "TG-F05", "fx_revoked_token", {
        "token_valid_event_count": 1, "token_revoked_event_count": 1,
        "token_expired_event_count": 0,
    }, where={"event_type": "TS_VALIDATE"})
    case("V42_NO_FAILURES", "TG-F09", "fx_no_failures", {
        "auth_pass_count_obs": 3, "auth_fail_count_obs": 0,
        "auth_known_result_count_obs": 3, "auth_failure_ratio_obs": 0,
        "top1_failed_token_share_obs": None, "top1_failed_ip_share_obs": None,
    })

    sequence = {}

    def stamp(value):
        if isinstance(value, datetime):
            return value.isoformat(sep=" ", timespec="milliseconds")
        return value

    def event(scenario, at, event_type="TS_VALIDATE", **fields):
        index = sequence.get(scenario, 0)
        sequence[scenario] = index + 1
        at = stamp(at)
        row = {
            "run_id": run_id, "user_id": user_id, "dataset_kind": "FIXTURE",
            "scenario_id": scenario, "record_id": f"{scenario}:record:{index}",
            "event_id": f"{scenario}:event:{index}",
            "source_event_id": f"{scenario}:source:{index}",
            "event_time": at, "ingest_time": at,
            "event_type": event_type,
            "source": {"CDN_MEDIA_ACCESS": "cdn_access", "TS_VALIDATE": "ts_auth"}.get(event_type, "fixture_audit"),
            "viewer_id": f"fx_viewer_{scenario}",
            "credential_viewer_id": f"fx_viewer_{scenario}",
            "identity_basis": "AUTHENTICATED_VIEWER",
            "video_id": video, "token_ref": f"fx_token_{scenario}",
            "session_ref": f"fx_session_{scenario}", "association_status": "CONFIRMED",
            "request_ref": f"{scenario}:request:{index}", "request_ip": "192.0.2.10",
            "viewer_ip": "192.0.2.10", "ip_basis": "TRUSTED_REQUEST",
            "user_agent": IOS_UA, "request_url": f"https://fixture.invalid/{scenario}/segment_0.ts",
            "auth_result": 1, "sampling_rate": 1.0,
            "sampling_method": "CENSUS", "sampling_unit": "AUTH_EVENT",
            "parse_status": "OK", "raw_log_ref": f"fixture://{scenario}/{index}",
            "quality_flags": ["SYNTHETIC_FIXTURE"], "load_part": "fixtures",
        }
        row.update(fields)
        output["events"].append(row)
        return row

    def media(scenario, key, start, end, **fields):
        path = f"/{scenario}/{key}.ts"
        row = {
            "run_id": run_id, "user_id": user_id, "dataset_kind": "FIXTURE",
            "scenario_id": scenario, "row_key": f"{scenario}:media:{key}",
            "video_id": video, "resource_version": "fixture_v1",
            "content_version": "fixture_content_v1", "playlist_ref": f"{scenario}:playlist",
            "rendition_ref": "720p", "track_type": "VIDEO", "object_path": path,
            "segment_index": 0, "media_start_s": start, "media_end_s": end,
            "segment_duration_s": end - start, "total_segments": 4,
            "expected_object_bytes": 1000, "manifest_available": 1,
        }
        row.update(fields)
        output["media_segments"].append(row)
        return f"https://fixture.invalid{path}"

    def coverage(scenario, event_types, *, day="2026-10-16", complete=1,
                 dataset_kind="FIXTURE", start=None, end=None, **fields):
        start = start or f"{day} 00:00:00.000"
        end = end or stamp(datetime.fromisoformat(start) + timedelta(days=1))
        for event_type in event_types:
            row = {
                "run_id": run_id, "user_id": user_id, "dataset_kind": dataset_kind,
                "scenario_id": scenario, "row_key": f"{scenario}:{event_type}:{start}",
                "event_type": event_type, "coverage_start": start, "coverage_end": end,
                "is_complete": complete, "sampling_rate": 1.0, "sampling_method": "CENSUS",
                "requires_token": 1, "requires_manifest": 1, "requires_key": 1,
                "key_validity_seconds": 3600, "request_activity_ttl_seconds": None,
                "protocol_version": "FIXTURE_HLS_V1",
            }
            row.update(fields)
            output["source_coverage"].append(row)

    def snapshot(scenario, effective, expires, **fields):
        row = {
            "run_id": run_id, "user_id": user_id, "dataset_kind": "FIXTURE",
            "scenario_id": scenario, "row_key": f"{scenario}:snapshot:{effective}",
            "token_ref": f"fx_token_{scenario}", "effective_at": effective,
            "expires_at": expires, "revoked": 0, "allowed_video_ids": [video],
            "credential_viewer_id": f"fx_viewer_{scenario}",
            "original_issued_at": effective, "last_renewed_at": effective,
            "policy_version": "FIXTURE_POLICY_V1",
        }
        row.update(fields)
        output["token_snapshots"].append(row)

    base = datetime(2026, 10, 16, 10)
    scenario = "fx_replay_retry"
    url = media(scenario, "same_segment", 0, 10)
    first = event(scenario, base, request_url=url)
    event(scenario, base + timedelta(seconds=10), request_url=url)
    event(scenario, base + timedelta(seconds=20), request_url=url)
    replay = dict(first, record_id=f"{scenario}:record:replay", ingest_time="2026-10-16 10:01:00.000")
    output["events"].append(replay)

    scenario = "fx_media_union"
    for index, (start, end, track, rendition) in enumerate([
        (0, 10, "VIDEO", "720p"), (0, 10, "AUDIO", "audio"),
        (0, 10, "VIDEO", "1080p"), (5, 15, "VIDEO", "720p"),
    ]):
        url = media(scenario, f"object_{index}", start, end, track_type=track,
                    rendition_ref=rendition, playlist_ref=f"{scenario}:{track}:{rendition}")
        event(scenario, base + timedelta(seconds=index), request_url=url)

    scenario = "fx_content_versions"
    for index in range(2):
        url = media(scenario, f"version_{index}", 0, 10,
                    content_version=f"unrelated_content_{index}")
        event(scenario, base + timedelta(seconds=index), request_url=url)

    scenario = "fx_partial_cdn"
    for index in range(2):
        url = media(scenario, f"segment_{index}", index * 10, (index + 1) * 10)
        event(scenario, base + timedelta(seconds=index), "CDN_MEDIA_ACCESS", request_url=url,
              http_status=200 if index == 0 else 206, response_bytes=1000 if index == 0 else 500,
              object_size=1000, response_completed=1, range_start=0,
              range_end=999 if index == 0 else 499)

    for scenario, results in [("fx_unknown_results", [1] * 3 + [0] * 2 + [-1] * 5),
                               ("fx_only_unknown", [-1] * 3)]:
        for index, result in enumerate(results):
            event(scenario, base + timedelta(seconds=index), auth_result=result)

    scenario = "fx_failure_sources"
    for index in range(4):
        event(scenario, base + timedelta(seconds=index), auth_result=0,
              token_ref=f"fx_token_{scenario}_{'A' if index < 3 else 'B'}",
              request_ip="192.0.2.10" if index < 2 else "198.51.100.20")

    scenario = "fx_sequence"
    urls = [media(scenario, f"segment_{index}", index * 10, (index + 1) * 10,
                  segment_index=index) for index in range(4)]
    for index, segment in enumerate([0, 1, 1, 0, 2]):
        event(scenario, base + timedelta(seconds=index * 10), request_url=urls[segment])

    scenario = "fx_sequence_tie"
    for index in range(2):
        url = media(scenario, f"segment_{index}", index * 10, (index + 1) * 10,
                    segment_index=index)
        event(scenario, base, request_url=url, native_sequence=None)

    for scenario in ("fx_sequential_videos", "fx_no_state", "fx_concurrent_state"):
        for index in range(3):
            start_at = base if scenario == "fx_concurrent_state" else base + timedelta(seconds=80 * index)
            url = media(scenario, f"video_{index}", 0, 10, video_id=videos[index])
            event(scenario, start_at, video_id=videos[index], request_url=url)
            if scenario != "fx_no_state":
                event(scenario, start_at, "PLAYBACK_STATE", video_id=videos[index], state="PLAYING",
                      session_ref=f"fx_session_{scenario}_{index}",
                      trusted_state=1, state_valid_until=stamp(start_at + timedelta(seconds=70)))

    for scenario, labels, same_time in [
        ("fx_env_switch", ["A"] * 10 + ["B"] * 10, False),
        ("fx_env_interleaved", ["A", "B"] * 10, False),
        ("fx_env_tie", ["A", "B"], True),
        ("fx_env_return", ["A", "B", "A"], False),
        ("fx_sampled_environment", ["A", "B"] * 10, False),
    ]:
        snapshot(scenario, "2026-10-16 09:00:00.000", "2026-10-16 12:00:00.000")
        for index, label in enumerate(labels):
            event(scenario, base if same_time else base + timedelta(seconds=index * 10),
                  request_ip="192.0.2.10" if label == "A" else "198.51.100.20",
                  user_agent=IOS_UA if label == "A" else ANDROID_UA, native_sequence=None,
                  sampling_rate=0.1 if scenario == "fx_sampled_environment" else 1.0,
                  sampling_method="BERNOULLI" if scenario == "fx_sampled_environment" else "CENSUS")

    for index in range(2):
        event("fx_missing_ua", base + timedelta(seconds=index), user_agent=None)

    scenario = "fx_scope_history"
    snapshot(scenario, "2026-10-16 09:00:00.000", "2026-10-16 09:10:00.000")
    snapshot(scenario, "2026-10-16 09:20:00.000", "2026-10-16 09:30:00.000",
             allowed_video_ids=[videos[1]], original_issued_at="2026-10-16 09:00:00.000")
    for time, target, result in [
        ("09:05:00", video, 1), ("09:10:00", video, 0), ("09:15:00", video, 0),
        ("09:20:00", videos[1], 1), ("09:25:00", video, 1), ("09:30:00", videos[1], 0),
    ]:
        event(scenario, f"2026-10-16 {time}.000", video_id=target, auth_result=result)

    for scenario, complete, fetched_at in [
        ("fx_cached_key", 1, "2026-10-16 09:55:00.000"),
        ("fx_missing_key_complete", 1, None),
        ("fx_missing_key_incomplete", 0, None),
    ]:
        snapshot(scenario, "2026-10-16 09:00:00.000", "2026-10-16 12:00:00.000")
        event(scenario, "2026-10-16 09:50:00.000", "TOKEN_CREATE", http_status=200)
        event(scenario, "2026-10-16 09:51:00.000", "MANIFEST_REQUEST", http_status=200)
        if fetched_at:
            event(scenario, fetched_at, "HLS_KEY_VALIDATE", http_status=200,
                  key_valid_until="2026-10-16 10:55:00.000")
            event(scenario, fetched_at, "KEY_RESPONSE", http_status=200, response_completed=1,
                  key_valid_until="2026-10-16 10:55:00.000")
        url = media(scenario, "segment_0", 0, 10)
        event(scenario, base, request_url=url)
        coverage(scenario, ["HLS_KEY_VALIDATE", "KEY_RESPONSE"], complete=complete)

    scenario = "fx_active_minutes"
    for index, offset in enumerate([0, 60, 60, 120, 240]):
        url = media(scenario, f"segment_{index}", index * 10, (index + 1) * 10,
                    segment_index=index, total_segments=5)
        event(scenario, datetime(2026, 10, 16, 1) + timedelta(seconds=offset), request_url=url)

    scenario = "fx_night_boundary"
    for index, time in enumerate(["01:59:59.999", "02:00:00.000", "05:59:59.999", "06:00:00.000"]):
        url = media(scenario, f"segment_{index}", index * 10, (index + 1) * 10,
                    segment_index=index)
        event(scenario, f"2026-10-16 {time}", request_url=url)

    history_days = ["2026-09-18", "2026-09-25", "2026-10-02", "2026-10-09"]
    for scenario, history_counts, current_count in [
        ("fx_night_history", [10, 20, 30, 40], 40),
        ("fx_zero_baseline", [0, 0, 0, 0], 10),
    ]:
        url = media(scenario, "same_segment", 0, 10)
        for day, count in zip(history_days + ["2026-10-16"], history_counts + [current_count]):
            kind = "FIXTURE" if day == "2026-10-16" else "HISTORY_FIXTURE"
            if kind == "HISTORY_FIXTURE":
                coverage(scenario, ["TS_VALIDATE"], day=day, dataset_kind=kind)
            for index in range(count):
                event(scenario, datetime.fromisoformat(f"{day} 02:00:00") + timedelta(seconds=index),
                      request_url=url, dataset_kind=kind)

    scenario = "fx_server_curl"
    event(scenario, base, "TOKEN_CREATE", user_agent="curl/8.7.1", identity_basis="CUSTOMER_SERVER",
          viewer_id=None, request_ip="203.0.113.30", ip_basis="SERVER_SOURCE")
    event(scenario, base + timedelta(seconds=1))

    scenario = "fx_client_tool"
    for index, event_type in enumerate(["MANIFEST_REQUEST", "HLS_KEY_VALIDATE", "TS_VALIDATE"]):
        event(scenario, base + timedelta(seconds=index), event_type, user_agent="python-requests/2.32.3")

    scenario = "fx_late"
    url = media(scenario, "segment_0", 0, 10)
    event(scenario, base, request_url=url, ingest_time="2026-10-17 10:00:00.000")

    scenario = "fx_window_edge"
    url = media(scenario, "segment_0", 0, 10)
    event(scenario, base, request_url=url)
    event(scenario, base + timedelta(minutes=10), request_url=url)

    scenario = "fx_sampled"
    for index in range(2):
        url = media(scenario, f"segment_{index}", index * 10, (index + 1) * 10,
                    segment_index=index)
        event(scenario, base + timedelta(seconds=index), request_url=url, sampling_rate=0.1,
              sampling_method="BERNOULLI", sampling_unit="AUTH_EVENT")
    coverage(scenario, ["TS_VALIDATE"], sampling_rate=0.1, sampling_method="BERNOULLI")

    scenario = "fx_two_sources"
    url = media(scenario, "segment_0", 0, 10)
    event(scenario, base, request_url=url, request_ref=f"{scenario}:shared_request")
    event(scenario, base, "CDN_MEDIA_ACCESS", request_url=url,
          request_ref=f"{scenario}:shared_request", http_status=200,
          response_bytes=1000, object_size=1000, response_completed=1,
          range_start=None, range_end=None)

    event("fx_missing_timezone", "2026-10-16 02:00:00.000")
    event("fx_credential_only", base, viewer_id=None, credential_viewer_id="fx_bound_viewer",
          identity_basis="TOKEN_BOUND_VIEWER")
    event("fx_missing_manifest", base)
    event("fx_scope_unknown", base, video_id=videos[0])
    event("fx_scope_unknown", base + timedelta(seconds=1), video_id=videos[1])
    scenario = "fx_unknown_sampling"
    for index in range(2):
        url = media(scenario, f"segment_{index}", index * 10, (index + 1) * 10,
                    segment_index=index)
        event(scenario, base + timedelta(seconds=index), request_url=url,
              sampling_rate=0.1, sampling_method="UNKNOWN", sampling_unit="UNKNOWN")
    coverage(scenario, ["TS_VALIDATE"], sampling_rate=0.1, sampling_method="UNKNOWN")
    coverage("fx_sampled_environment", ["TS_VALIDATE"], sampling_rate=0.1,
             sampling_method="BERNOULLI")
    event("fx_legitimate_tool", base, source="HEALTH_CHECK", user_agent="curl/8.7.1")
    scenario = "fx_revoked_token"
    snapshot(scenario, "2026-10-16 09:00:00.000", "2026-10-16 12:00:00.000")
    snapshot(scenario, "2026-10-16 10:05:00.000", "2026-10-16 12:00:00.000", revoked=1,
             original_issued_at="2026-10-16 09:00:00.000")
    event(scenario, base)
    event(scenario, base + timedelta(minutes=5), auth_result=0)
    for index in range(3):
        event("fx_no_failures", base + timedelta(seconds=index))

    # Every scenario has explicit configuration and per-source day coverage.
    scenarios = sorted({row["scenario_id"] for row in output["events"]})
    existing_coverage = {(row["scenario_id"], row["event_type"], row["coverage_start"])
                         for row in output["source_coverage"]}
    for scenario in scenarios:
        output["business_config"].append({
            "run_id": run_id, "user_id": user_id, "dataset_kind": "FIXTURE",
            "scenario_id": scenario, "row_key": f"{scenario}:business_config",
            "timezone": None if scenario == "fx_missing_timezone" else "Asia/Shanghai",
            "off_hours_start_min": 120,
            "off_hours_end_min": 360, "config_version": "FIXTURE_NIGHT_V1",
            "valid_from": "2026-08-01 00:00:00.000", "valid_to": "2026-10-24 00:00:00.000",
        })
        event_types = {row["event_type"] for row in output["events"] if row["scenario_id"] == scenario}
        if scenario.startswith("fx_"):
            event_types.update(["TOKEN_CREATE", "MANIFEST_REQUEST", "HLS_KEY_VALIDATE", "KEY_RESPONSE", "TS_VALIDATE"])
        for event_type in sorted(event_types):
            if (scenario, event_type, "2026-10-16 00:00:00.000") not in existing_coverage:
                coverage(scenario, [event_type])
    for ip, country, province, isp in [
        ("192.0.2.10", "TEST", "FIXTURE_A", "FIXTURE_ISP_A"),
        ("198.51.100.20", "TEST", "FIXTURE_B", "FIXTURE_ISP_B"),
        ("203.0.113.30", "TEST", "FIXTURE_SERVER", "FIXTURE_ISP_SERVER"),
    ]:
        output["ip_info"].append({
            "run_id": run_id, "dataset_kind": "FIXTURE", "row_key": f"fixture_ip:{ip}",
            "request_ip": ip, "country": country, "province": province,
            "isp": isp, "mapping_version": "FIXTURE_IP_V1",
        })
    return output
