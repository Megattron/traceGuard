-- R7 / scorecard v0.2. Read only, one tenant + batch + scenario + exact 10-minute window.
-- The MVP reads a fixed immutable validation batch. Scope before sorting to avoid
-- the global wide FINAL view. Stable event_id dedups exact reimports and replays.
-- This scoped optimization must not be reused for mutable/late-corrected events.
WITH deduplicated AS
(
  SELECT event_id, video_id, scenario_id, source, event_type, dataset_kind, auth_result
  FROM {database:Identifier}.tg_validation_events
  WHERE run_id = {run_id:String} AND user_id = {tenant_id:String}
    AND scenario_id = {scenario_id:String}
    AND dataset_kind = 'SYNTHETIC'
    AND event_type = 'TS_VALIDATE'
    AND event_time >= {window_start:DateTime64(3, 'Asia/Shanghai')}
    AND event_time < {window_end:DateTime64(3, 'Asia/Shanghai')}
  ORDER BY event_id, ingest_time DESC, record_id DESC
  LIMIT 1 BY event_id
), grouped AS
(
  SELECT video_id, scenario_id, source, event_type,
    groupUniqArray(dataset_kind) AS dataset_kinds,
    count() AS observed,
    countIf(auth_result = 1) AS passed,
    countIf(auth_result = 0) AS failed,
    countIf(auth_result NOT IN (0, 1)) AS unknown
  FROM deduplicated
  GROUP BY video_id, scenario_id, source, event_type
)
SELECT *, passed + failed AS known,
  failed / nullIf(known, 0) AS failure_ratio,
  if(known < 100 OR video_id = '', NULL,
    multiIf(failed >= 300 AND failure_ratio >= 0.8, 50,
            failed >= 100 AND failure_ratio >= 0.5, 25,
            failed >= 30 AND failure_ratio >= 0.2, 10, 0)) AS anomaly_score
FROM grouped
ORDER BY video_id, source, event_type
