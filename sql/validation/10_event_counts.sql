SELECT dataset_kind,event_type,count() AS record_count,uniqExact(event_id) AS business_event_count,
 min(event_time) AS min_event_time,max(event_time) AS max_event_time
FROM da.tg_validation_events FINAL
WHERE run_id={run_id:String} AND user_id={user_id:String}
GROUP BY dataset_kind,event_type ORDER BY dataset_kind,event_type;
