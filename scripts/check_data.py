"""Offline validation of generated records. Does not claim SQL execution evidence."""
import collections
import gzip
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

from ch_client import RUN_ID, TASK, USER_ID
from generate_validation import EVENT_TYPES


def check():
    directory = TASK / 'data/validation'
    manifest = json.loads((directory / 'manifest.json').read_text())
    failures = []
    totals = collections.Counter()
    event_types = collections.Counter()
    days = collections.defaultdict(collections.Counter)
    kinds = collections.Counter()
    main_rows = 0
    history_rows = 0
    media = set()
    schemas = {}
    ddl = (TASK / 'sql/validation/00_schema.sql').read_text()
    for match in re.finditer(r'CREATE TABLE IF NOT EXISTS da\.tg_validation_(\w+)\s*\((.*?)\)\s*ENGINE', ddl, re.S):
        schemas[match[1]] = set(re.findall(
            r'(?:^|,|\n)\s*([a-z_]+)\s+(?:String|LowCardinality|Nullable|DateTime64|Int\d+|UInt\d+|Float\d+|Array)', match[2]))
    all_row_keys = collections.defaultdict(set)
    for part in manifest['parts']:
        if part['table'] == 'media_segments':
            with gzip.open(directory / part['file'], 'rt') as stream:
                for line in stream:
                    row = json.loads(line)
                    key = row['scenario_id'], row['object_path']
                    if key in media:
                        failures.append('Duplicate media join key')
                    media.add(key)
    for part in manifest['parts']:
        path = directory / part['file']
        if hashlib.sha256(path.read_bytes()).hexdigest() != part['sha256']:
            failures.append('Checksum mismatch: ' + path.name)
        count = 0
        row_keys = all_row_keys[part['table']]
        with gzip.open(path, 'rt') as stream:
            for line in stream:
                row = json.loads(line)
                count += 1
                table = part['table']
                keys = set(row)
                if table not in schemas or schemas[table] != keys:
                    failures.append('Inconsistent columns: ' + path.name)
                    continue
                if row['run_id'] != RUN_ID or (table != 'ip_info' and row['user_id'] != USER_ID):
                    failures.append('Unexpected run/user: ' + path.name)
                record_key = row['record_id'] if table == 'events' else row['row_key']
                if record_key in row_keys:
                    failures.append('Duplicate import key: ' + path.name)
                row_keys.add(record_key)
                if table != 'events':
                    continue
                kind = row['dataset_kind']
                kinds[kind] += 1
                event_types[row['event_type']] += 1
                if row['auth_result'] not in (-1, 0, 1):
                    failures.append('Invalid auth result')
                if kind == 'HISTORY_FIXTURE':
                    history_rows += 1
                    if row['event_time'] >= manifest['window_start']:
                        failures.append('Historical fixture inside main window')
                    continue
                if not manifest['window_start'] <= row['event_time'] < manifest['window_end']:
                    failures.append('Event outside eight-day interval')
                main_rows += 1
                days[row['event_time'][:10]][row['event_type']] += 1
                if kind == 'SYNTHETIC' and row['event_type'] in ('TS_VALIDATE', 'CDN_MEDIA_ACCESS'):
                    key = row['scenario_id'], urlsplit(row['request_url']).path
                    if key not in media:
                        failures.append('Synthetic segment lacks media mapping')
                if kind == 'OBSERVED_REDACTED' and row['viewer_id'] is not None:
                    failures.append('Observed credential promoted to authenticated viewer')
        if count != part['rows']:
            failures.append('Row count mismatch: ' + path.name)
        totals[part['table']] += count
    cases = json.loads((directory / 'fixture_cases.json').read_text())
    groups = {c['feature_group'] for c in cases}
    if groups != {f'TG-F{n:02d}' for n in range(13)}:
        failures.append('Not all feature groups have expected cases')
    if main_rows < 1_000_000 and not manifest['fixtures_only']:
        failures.append('Less than one million main validation events')
    if not manifest['fixtures_only']:
        for day in ('2026-10-' + str(n) for n in range(16, 24)):
            if not set(EVENT_TYPES).issubset(days[day]):
                failures.append('Missing required daily event type: ' + day)
    report = dict(status='FAIL' if failures else 'PASS', evidence_scope='OFFLINE_DATA_CONTRACT_ONLY',
        sql_execution_status='SEE_SQL_FIXTURE_VERIFICATION_REPORT', run_id=RUN_ID,
        main_window_event_rows=main_rows, history_fixture_event_rows=history_rows,
        table_rows=dict(totals), dataset_kinds=dict(kinds), event_types=dict(event_types),
        daily_event_types={day: dict(counts) for day, counts in sorted(days.items())},
        fixture_cases=len(cases), feature_groups=sorted(groups), failures=failures[:50])
    (directory / 'offline_validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    return not failures


if __name__ == '__main__':
    raise SystemExit(0 if check() else 1)
