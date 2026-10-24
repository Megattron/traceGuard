"""Run hand-calculated fixture cases against actual ClickHouse feature queries."""
import json
import math
import hashlib
from pathlib import Path

from ch_client import Client, TASK


def comparable_equal(actual, expected):
    if isinstance(expected, float):
        return isinstance(actual, (int, float)) and math.isclose(actual, expected, rel_tol=1e-8, abs_tol=1e-8)
    return actual == expected


def verify():
    data = TASK / 'data/validation'
    cases = json.loads((data / 'fixture_cases.json').read_text())
    expected_count = json.loads((data / 'manifest.json').read_text())['cases']
    if (not cases or len(cases) != expected_count
            or len({c['case_id'] for c in cases}) != len(cases)
            or {c['feature_group'] for c in cases} != {f'TG-F{n:02d}' for n in range(13)}):
        report = {'status': 'FAIL', 'cases': len(cases), 'passed': 0,
                  'error': 'Missing, duplicated or incomplete fixture case registry', 'results': []}
        (data / 'sql_fixture_verification.json').write_text(json.dumps(report, indent=2))
        return False
    files = {p.name[:6]: p for p in (TASK / 'sql/features').glob('TG-F*.sql')}
    client = Client()
    results = []
    for case in cases:
        result = {'case_id': case['case_id'], 'feature_group': case['feature_group']}
        try:
            response = client.query_file(files[case['feature_group']], case['scenario_id'], case['window_start'], case['window_end'])
            rows = [r for r in response['data'] if all(r.get(k) == v for k, v in case['where'].items())]
            if len(rows) != case.get('expected_rows', 1):
                result.update(status='FAIL', error='Unexpected row count', actual_rows=len(rows))
            elif case.get('expected_rows', 1) == 0:
                result['status'] = 'PASS'
            else:
                errors = {k: {'expected': v, 'actual': rows[0].get(k), 'column_present': k in rows[0]}
                          for k, v in case['expected'].items()
                          if k not in rows[0] or not comparable_equal(rows[0][k], v)}
                result.update(status='FAIL' if errors else 'PASS', differences=errors)
        except (RuntimeError, KeyError) as exc:
            result.update(status='ERROR', error=str(exc))
        results.append(result)
        display = dict(result)
        if 'error' in display:
            display['error'] = display['error'][:350]
        print(json.dumps(display, ensure_ascii=False), flush=True)
    report = {'status': 'PASS' if all(r['status'] == 'PASS' for r in results) else 'FAIL',
              'cases': len(results), 'passed': sum(r['status'] == 'PASS' for r in results), 'results': results}
    report['sql_sha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files.values()}
    report['cases_sha256'] = hashlib.sha256((data / 'fixture_cases.json').read_bytes()).hexdigest()
    (data / 'sql_fixture_verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return report['status'] == 'PASS'


if __name__ == '__main__':
    raise SystemExit(0 if verify() else 1)
