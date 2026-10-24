"""Execute each SQL on the loaded main dataset and save its result and timing."""
import argparse
import gzip
import hashlib
import json
import time

from ch_client import Client, RUN_ID, TASK


def extract(start, end, scenario):
    client = Client()
    directory = TASK / 'data/validation/feature_results'
    directory.mkdir(exist_ok=True)
    results = []
    for path in sorted((TASK / 'sql/features').glob('TG-F*.sql')):
        at = time.monotonic()
        row = dict(feature_group=path.name[:6], file=path.name,
                   sql_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        try:
            # The single-event query would serialize a whole day's wide raw rows.
            # Run a declared 100-row sample for F01; aggregates are uncapped.
            limit = 100 if path.name.startswith('TG-F01_') else None
            response = client.query_file(path, scenario, start, end, limit)
            target = directory / (path.stem + '.json.gz')
            with gzip.open(target, 'wt') as output:
                json.dump(response, output, ensure_ascii=False)
            row.update(status='PASS', rows=response['rows'], result_file=target.name,
                       execution_mode='SAMPLE_100' if limit else 'FULL_AGGREGATE',
                       statistics=response.get('statistics'))
        except (RuntimeError, ValueError) as exc:
            row.update(status='FAIL', error=str(exc))
        row['elapsed_seconds'] = round(time.monotonic() - at, 3)
        results.append(row)
        display = {k: v for k, v in row.items() if k not in ('statistics', 'sql_sha256')}
        if 'error' in display:
            display['error'] = display['error'][:400]
        print(json.dumps(display, ensure_ascii=False), flush=True)
    report = dict(run_id=RUN_ID, window_start=start, window_end=end, scenario_id=scenario,
        status='PASS' if len(results) == 13 and all(r['status'] == 'PASS' for r in results) else 'FAIL', results=results)
    (directory / 'execution_report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return report['status'] == 'PASS'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--start', default='2026-10-23 00:00:00.000')
    parser.add_argument('--end', default='2026-10-24 00:00:00.000')
    parser.add_argument('--scenario', default='')
    args = parser.parse_args()
    raise SystemExit(0 if extract(args.start, args.end, args.scenario) else 1)
