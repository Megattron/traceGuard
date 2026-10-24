SELECT toDate(event_time) AS event_date,event_type,count() AS record_count
FROM da.tg_validation_events FINAL
WHERE run_id={run_id:String} AND user_id={user_id:String}
 AND event_time>={window_start:DateTime64(3)} AND event_time<{window_end:DateTime64(3)}
GROUP BY event_date,event_type ORDER BY event_date,event_type;
