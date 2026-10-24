-- ClickHouse 23.2: no non-equality JOIN conditions or arrayFold.
-- A physical replay may have a different record_id, but the same event_id.
CREATE VIEW IF NOT EXISTS da.tg_validation_events_dedup AS
SELECT * FROM da.tg_validation_events FINAL
ORDER BY run_id,event_id,ingest_time DESC,record_id DESC
LIMIT 1 BY run_id,event_id;

CREATE VIEW IF NOT EXISTS da.tg_validation_event_features AS
WITH
 ua AS
 (
  SELECT *,
   multiIf(match(lowerUTF8(ifNull(user_agent,'')),'curl/|wget/|python-requests|ffmpeg|libavformat|aria2'), 'TOOL',
           positionCaseInsensitive(ifNull(user_agent,''),'Android')>0,'ANDROID',
           match(ifNull(user_agent,''),'iPhone|iPad'),'IOS',
           positionCaseInsensitive(ifNull(user_agent,''),'Chrome/')>0,'CHROME',
           positionCaseInsensitive(ifNull(user_agent,''),'Safari/')>0,'SAFARI','UNKNOWN') AS ua_family,
   multiIf(positionCaseInsensitive(ifNull(user_agent,''),'Android')>0,'ANDROID',
           match(ifNull(user_agent,''),'iPhone|iPad'),'IOS',
           positionCaseInsensitive(ifNull(user_agent,''),'Windows')>0,'WINDOWS',
           positionCaseInsensitive(ifNull(user_agent,''),'Macintosh')>0,'MACOS',
           positionCaseInsensitive(ifNull(user_agent,''),'Linux')>0,'LINUX','UNKNOWN') AS os_family,
   if(positionCaseInsensitive(ifNull(user_agent,''),'TraceGuardSDK/')>0,'TRACEGUARD_SDK','NONE') AS sdk_family,
   if(startsWith(request_url,'/'),cutQueryString(request_url),path(request_url)) AS object_path,
   if(identity_basis='AUTHENTICATED_VIEWER' AND notEmpty(ifNull(viewer_id,'')),'VIEWER',
      if(notEmpty(ifNull(credential_viewer_id,'')),'CREDENTIAL_VIEWER','UNKNOWN')) AS subject_type,
   if(identity_basis='AUTHENTICATED_VIEWER' AND notEmpty(ifNull(viewer_id,'')),
      viewer_id,nullIf(credential_viewer_id,'')) AS subject_id,
   CAST(event_type IN ('MANIFEST_REQUEST','HLS_KEY_VALIDATE','KEY_RESPONSE','TS_VALIDATE','CDN_MEDIA_ACCESS','PLAYBACK_STATE','REQUEST_REJECTED') AS UInt8) AS is_client_event
  FROM da.tg_validation_events_dedup
 ), enriched AS
 (
 SELECT e.run_id AS run_id,
  e.dataset_kind AS dataset_kind,
  e.scenario_id AS scenario_id,
  e.record_id AS record_id,
  e.event_id AS event_id,
  e.source_event_id AS source_event_id,
  e.event_time AS event_time,
  e.ingest_time AS ingest_time,
  e.event_type AS event_type,
  e.source AS source,
  e.user_id AS user_id,
  e.viewer_id AS viewer_id,
  e.credential_viewer_id AS credential_viewer_id,
  e.identity_basis AS identity_basis,
  e.video_id AS video_id,
  e.token_ref AS token_ref,
  e.session_ref AS session_ref,
  e.association_status AS association_status,
  e.request_ref AS request_ref,
  e.request_ip AS request_ip,
  e.viewer_ip AS viewer_ip,
  e.ip_basis AS ip_basis,
  e.user_agent AS user_agent,
  e.request_url AS request_url,
  e.segment_index_raw AS segment_index_raw,
  e.auth_result AS auth_result,
  e.http_status AS http_status,
  e.failure_reason AS failure_reason,
  e.token_action AS token_action,
  e.key_valid_until AS key_valid_until,
  e.response_bytes AS response_bytes,
  e.object_size AS object_size,
  e.response_completed AS response_completed,
  e.range_start AS range_start,
  e.range_end AS range_end,
  e.state AS state,
  e.current_time_s AS current_time_s,
  e.playback_rate AS playback_rate,
  e.state_valid_until AS state_valid_until,
  e.trusted_state AS trusted_state,
  e.native_sequence AS native_sequence,
  e.sampling_rate AS sampling_rate,
  e.sampling_method AS sampling_method,
  e.sampling_unit AS sampling_unit,
  e.parse_status AS parse_status,
  e.quality_flags AS quality_flags,
  e.raw_log_ref AS raw_log_ref,
  e.load_part AS load_part,
  e.ua_family AS ua_family,
  e.os_family AS os_family,
  e.sdk_family AS sdk_family,
  e.object_path AS object_path,
  e.subject_type AS subject_type,
  e.subject_id AS subject_id,
  e.is_client_event AS is_client_event,
  nullIf(e.request_ip,'') AS client_ip,
  if(e.ip_basis IN ('TRUSTED_REQUEST','VERIFIED_PROXY','DIRECT_CLIENT') AND notEmpty(ifNull(e.request_ip,'')) AND e.ua_family!='UNKNOWN',
     concat('env_',toString(cityHash64(concat(ifNull(e.request_ip,''),'|',e.ua_family,'|',e.os_family,'|',e.sdk_family)))),NULL) AS env_ref,
  CAST(e.ua_family='TOOL' AS UInt8) AS is_tool_ua,
  multiIf(positionCaseInsensitive(ifNull(e.user_agent,''),'curl/')>0,'CURL',
   positionCaseInsensitive(ifNull(e.user_agent,''),'wget/')>0,'WGET',
   positionCaseInsensitive(ifNull(e.user_agent,''),'python-requests')>0,'PYTHON_REQUESTS',
   match(lowerUTF8(ifNull(e.user_agent,'')),'ffmpeg|libavformat'),'FFMPEG',
   positionCaseInsensitive(ifNull(e.user_agent,''),'aria2')>0,'ARIA2','NONE') AS tool_signature_code,
  CAST(e.source='HEALTH_CHECK' AS UInt8) AS known_legitimate_tool, 'tg_ua_1' AS ua_parser_version,
  toUInt8(notEmpty(m.row_key) AND m.manifest_available=1) AS media_mapped,
  nullIf(m.resource_version,'') AS resource_version, nullIf(m.content_version,'') AS content_version,
  nullIf(m.playlist_ref,'') AS playlist_ref,nullIf(m.rendition_ref,'') AS rendition_ref,
  nullIf(m.track_type,'') AS track_type,
  if(media_mapped,toNullable(m.segment_index),NULL) AS segment_index,
  if(media_mapped,toNullable(m.media_start_s),NULL) AS media_start_s,
  if(media_mapped,toNullable(m.media_end_s),NULL) AS media_end_s,
  if(media_mapped,toNullable(m.segment_duration_s),NULL) AS segment_duration_s,
  if(media_mapped,toNullable(m.total_segments),NULL) AS total_segments,
  if(media_mapped AND m.expected_object_bytes>0,toNullable(m.expected_object_bytes),NULL) AS expected_object_bytes,
  c.timezone AS business_timezone,
  toUInt8(ifNull(notEmpty(c.row_key) AND e.event_time>=c.valid_from AND e.event_time<c.valid_to
   AND c.timezone='Asia/Shanghai' AND isNotNull(c.off_hours_start_min)
   AND isNotNull(c.off_hours_end_min) AND c.off_hours_start_min<1440
   AND c.off_hours_end_min<=1440,0)) AS config_matched,
  if(config_matched,toNullable(toHour(toTimeZone(e.event_time,'Asia/Shanghai'))),NULL) AS local_hour,
  if(config_matched,toNullable(toHour(toTimeZone(e.event_time,'Asia/Shanghai'))*60
     +toMinute(toTimeZone(e.event_time,'Asia/Shanghai'))),NULL) AS local_minute_of_day,
  if(config_matched,toNullable(if(c.off_hours_start_min<=c.off_hours_end_min,
    local_minute_of_day>=c.off_hours_start_min AND local_minute_of_day<c.off_hours_end_min,
    local_minute_of_day>=c.off_hours_start_min OR local_minute_of_day<c.off_hours_end_min)),NULL) AS is_off_hours,
  c.config_version AS off_hours_config_version,
  if(config_matched,'AVAILABLE','UNAVAILABLE') AS off_hours_compute_status,
  multiIf(NOT notEmpty(c.row_key),'MISSING_BUSINESS_CONFIG',
   isNull(c.timezone),'MISSING_TIMEZONE',c.timezone!='Asia/Shanghai','UNSUPPORTED_TIMEZONE',
   e.event_time<c.valid_from OR e.event_time>=c.valid_to,'CONFIG_NOT_EFFECTIVE',
   isNull(c.off_hours_start_min) OR isNull(c.off_hours_end_min),'MISSING_OFF_HOURS_CONFIG',
   NOT config_matched,'INVALID_OFF_HOURS_CONFIG','') AS off_hours_reason_code
 FROM ua e
 LEFT JOIN (SELECT * FROM da.tg_validation_media_segments FINAL) m
 ON e.run_id=m.run_id AND e.user_id=m.user_id AND e.scenario_id=m.scenario_id
 AND e.object_path=m.object_path
 LEFT JOIN (SELECT * FROM da.tg_validation_business_config FINAL) c
 ON e.run_id=c.run_id AND e.user_id=c.user_id AND e.scenario_id=c.scenario_id
 )
SELECT *,
 multiIf(auth_result=1,'PASS',auth_result=0,'FAIL','UNKNOWN') AS auth_result_label,
 if(media_mapped,'AVAILABLE','UNAVAILABLE') AS media_mapping_compute_status,
 if(media_mapped,'','MISSING_MANIFEST_OR_RESOURCE_MAPPING') AS media_mapping_reason_code,
 if(event_type!='CDN_MEDIA_ACCESS',CAST(NULL AS Nullable(UInt8)),
  multiIf(ifNull(response_completed=0,0) OR ifNull(http_status NOT IN (200,206),0),toNullable(toUInt8(0)),
   isNull(http_status) OR isNull(response_completed),CAST(NULL AS Nullable(UInt8)),
   isNull(response_bytes) OR isNull(object_size) OR object_size=0,CAST(NULL AS Nullable(UInt8)),
   http_status=200,toNullable(toUInt8(response_bytes>=object_size)),
   isNull(range_start) OR isNull(range_end),CAST(NULL AS Nullable(UInt8)),
   toNullable(toUInt8(range_start=0 AND range_end>=object_size-1
                     AND range_end>=range_start AND response_bytes>=object_size)))) AS fully_served
FROM enriched;
