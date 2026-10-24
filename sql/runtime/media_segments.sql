SELECT object_path, video_id, content_version, resource_version, playlist_ref, rendition_ref,
  track_type, segment_index, media_start_s, media_end_s, total_segments, manifest_available
FROM {database:Identifier}.tg_validation_media_segments FINAL
WHERE run_id = {run_id:String} AND user_id = {tenant_id:String}
  AND scenario_id = {scenario_id:String} AND dataset_kind = 'SYNTHETIC'
  AND has(JSONExtract({video_ids_json:String}, 'Array(String)'), video_id)
