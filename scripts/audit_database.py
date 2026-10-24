"""Read-back counts, stored view contract and exact-file reimport idempotence."""
import gzip
import json
from pathlib import Path

from ch_client import Client, PREFIX, RUN_ID, TASK, USER_ID


def audit():
    client = Client()
    data = TASK / 'data/validation'
    manifest = json.loads((data / 'manifest.json').read_text())
    expected = {}
    for part in manifest['parts']:
        expected[part['table']] = expected.get(part['table'], 0) + part['rows']
    counts = {}
    failures = []
    for table, expected_count in expected.items():
        result = client.request('SELECT count() AS n FROM ' + PREFIX + table +
                                ' FINAL WHERE run_id={run_id:String}', {'run_id': RUN_ID})
        actual = result['data'][0]['n']
        counts[table] = {'expected': expected_count, 'actual': actual}
        if actual != expected_count:
            failures.append('Read-back count mismatch: ' + table)
    daily = client.query_file(TASK / 'sql/validation/11_daily_event_counts.sql')['data']
    (data / 'database_daily_counts.json').write_text(json.dumps(daily, indent=2))
    expected_daily = json.loads((data / 'offline_validation.json').read_text())['daily_event_types']
    actual_daily = {}
    for row in daily:
        actual_daily.setdefault(row['event_date'], {})[row['event_type']] = row['record_count']
    if actual_daily != expected_daily:
        failures.append('Daily counts do not match offline generated files')
    result = client.query_file(TASK / 'sql/validation/10_event_counts.sql')
    (data / 'database_event_counts.json').write_text(json.dumps(result, indent=2))
    # Check the view that actually exists, not merely the local SQL file.
    definition = client.request('SHOW CREATE TABLE da.tg_validation_event_features')['data'][0]['statement']
    (data / 'database_event_features_view.sql').write_text(definition + ';\n')
    normalized = ''.join(definition.replace('`', '').split()).lower()
    for fragment in ('e.scenario_id=m.scenario_id', 'asfully_served', 'asenv_ref'):
        if fragment not in normalized:
            failures.append('Stored view contract missing: ' + fragment)
    dedup = client.request('SELECT count() AS n FROM da.tg_validation_events_dedup WHERE run_id={run_id:String}', {'run_id': RUN_ID})['data'][0]['n']
    if dedup != expected['events'] - 1:
        failures.append('Expected exactly one explicit business-event replay')
    before = client.request("SELECT count() AS n FROM da.tg_validation_events FINAL WHERE run_id={run_id:String} AND load_part='fixtures'", {'run_id': RUN_ID})['data'][0]['n']
    with gzip.open(data / 'events.fixtures.jsonl.gz', 'rb') as stream:
        client.request('INSERT INTO da.tg_validation_events FORMAT JSONEachRow', payload=stream.read())
    after = client.request("SELECT count() AS n FROM da.tg_validation_events FINAL WHERE run_id={run_id:String} AND load_part='fixtures'", {'run_id': RUN_ID})['data'][0]['n']
    if before != after or after != 319:
        failures.append('Exact-file import was not logically idempotent')
    report = dict(status='FAIL' if failures else 'PASS', table_counts=counts,
        business_event_count=dedup, daily_counts_match_files=actual_daily == expected_daily,
        idempotence_fixture_before=before, idempotence_fixture_after=after, failures=failures)
    (data / 'database_audit.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2), flush=True)
    return not failures


if __name__ == '__main__':
    raise SystemExit(0 if audit() else 1)
