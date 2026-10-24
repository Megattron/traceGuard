-- Narrow immutable-batch read: aggregate in ClickHouse, never download a full day's raw events.
WITH
  events AS (
    SELECT event_id, record_id, ingest_time, event_time, video_id, request_url, source,
      viewer_id, credential_viewer_id, identity_basis, association_status,
      parse_status, sampling_rate, sampling_method
    FROM {database:Identifier}.tg_validation_events
    WHERE run_id = {run_id:String} AND user_id = {tenant_id:String}
      AND scenario_id = {scenario_id:String} AND dataset_kind = 'SYNTHETIC'
      AND event_type = 'TS_VALIDATE' AND auth_result = 1
      AND event_time >= {window_start:DateTime64(3, 'Asia/Shanghai')}
      AND event_time < {window_end:DateTime64(3, 'Asia/Shanghai')}
    ORDER BY event_id, ingest_time DESC, record_id DESC
    LIMIT 1 BY event_id
  ),
  media AS (
    SELECT object_path, count() AS mappings, any(video_id) AS media_video,
      any(content_version) AS content_version, any(media_start_s) AS media_start_s,
      any(media_end_s) AS media_end_s, any(manifest_available) AS manifest_available
    FROM {database:Identifier}.tg_validation_media_segments FINAL
    WHERE run_id = {run_id:String} AND user_id = {tenant_id:String}
      AND scenario_id = {scenario_id:String} AND dataset_kind = 'SYNTHETIC'
    GROUP BY object_path
  ),
  mapped AS (
    SELECT e.*,
      identity_basis = 'AUTHENTICATED_VIEWER' AND notEmpty(ifNull(viewer_id,'')) AND association_status = 'CONFIRMED' AS identity_verified,
      if(identity_verified, ifNull(viewer_id,''), ifNull(credential_viewer_id,'')) AS subject_id,
      m.content_version AS content_version, m.media_start_s AS media_start_s, m.media_end_s AS media_end_s,
      m.mappings = 1 AND m.media_video = e.video_id AND m.content_version != ''
        AND m.manifest_available = 1 AND isFinite(m.media_start_s) AND isFinite(m.media_end_s)
        AND m.media_end_s > m.media_start_s AS mapped_ok
    FROM events AS e LEFT JOIN media AS m ON
      if(startsWith(e.request_url,'/'),cutQueryString(e.request_url),path(e.request_url)) = m.object_path
  ),
  activity AS (
    SELECT subject_id, identity_verified, source, count() AS observed,
      uniqExact(toStartOfMinute(event_time)) AS active_minutes,
      countIf(NOT mapped_ok) AS mapped_unknown,
      countIf(parse_status != 'OK' OR ifNull(sampling_rate,0) != 1 OR sampling_method != 'CENSUS' OR source != 'SIMULATOR') AS quality_invalid,
      groupUniqArray(20)(video_id) AS video_ids
    FROM mapped GROUP BY subject_id, identity_verified, source
  ),
  content AS (
    SELECT subject_id, identity_verified, source, video_id, content_version,
      intervalLengthSumIf(toFloat64(media_start_s), toFloat64(media_end_s), mapped_ok) AS seconds
    FROM mapped GROUP BY subject_id, identity_verified, source, video_id, content_version
  ),
  totals AS (
    SELECT subject_id, identity_verified, source, sum(seconds) AS content_seconds
    FROM content GROUP BY subject_id, identity_verified, source
  )
SELECT a.subject_id AS subject_id, a.identity_verified AS identity_verified, a.source AS source,
  a.observed AS observed, a.active_minutes AS active_minutes, a.mapped_unknown AS mapped_unknown,
  a.quality_invalid AS quality_invalid, a.video_ids AS video_ids, t.content_seconds AS content_seconds
FROM activity AS a LEFT JOIN totals AS t USING (subject_id, identity_verified, source)
