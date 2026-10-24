"""Import only supplemental keys in the original run, or verify feature outputs."""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path

from ch_client import Client
from generate_demo_cases import OUT, RUN, TABLES, ROW_PREFIX

REPO = Path(__file__).resolve().parents[1]
DAY_START, DAY_END = '2026-10-23 00:00:00.000', '2026-10-24 00:00:00.000'


def count(client, table):
    key = 'record_id' if table == 'events' else 'row_key'
    return client.request('SELECT count() AS n FROM da.tg_validation_'+table+
                          ' FINAL WHERE run_id={run:String} AND startsWith('+key+', {prefix:String})',
                          {'run': RUN, 'prefix': ROW_PREFIX})['data'][0]['n']


def load():
    manifest = json.loads((OUT/'manifest.json').read_text())
    if manifest['run_id'] != RUN or {p['table'] for p in manifest['parts']} != set(TABLES):
        raise ValueError('Unexpected demo manifest')
    for part in manifest['parts']:
        if hashlib.sha256((OUT/part['file']).read_bytes()).hexdigest() != part['sha256']:
            raise ValueError('File checksum mismatch: '+part['file'])
    client = Client()
    before = {table: count(client, table) for table in TABLES}
    checkpoint_path = OUT/'load_checkpoint.json'
    if not checkpoint_path.exists() and any(before.values()):
        raise ValueError('Run already exists without this loader checkpoint; inspect before importing')
    checkpoint = json.loads(checkpoint_path.read_text()) if checkpoint_path.exists() else dict(run_id=RUN, files={})
    if checkpoint['run_id'] != RUN:
        raise ValueError('Checkpoint run mismatch')

    def save():
        temp = checkpoint_path.with_suffix('.tmp')
        temp.write_text(json.dumps(checkpoint, indent=2)+'\n')
        temp.replace(checkpoint_path)

    for part in manifest['parts']:
        previous = checkpoint['files'].get(part['file'])
        if previous and previous['sha256'] != part['sha256']:
            raise ValueError('Loaded file changed; use a new run instead')
    save()
    # Dimensions precede events; stable IDs plus FINAL cover an interrupted acknowledgement.
    for part in sorted(manifest['parts'], key=lambda p: p['table'] == 'events'):
        state = checkpoint['files'].setdefault(part['file'], dict(sha256=part['sha256'], batches=0))
        with gzip.open(OUT/part['file'], 'rb') as stream:
            lines = stream.readlines()
        for number, offset in enumerate(range(0, len(lines), 5000)):
            if number < state['batches']:
                continue
            client.request('INSERT INTO da.tg_validation_'+part['table']+' FORMAT JSONEachRow',
                           payload=b''.join(lines[offset:offset+5000]))
            state['batches'] = number+1
            save()
        actual = count(client, part['table'])
        if actual != part['rows']:
            raise ValueError(f'{part["table"]}: expected {part["rows"]}, read back {actual}')
        state.update(complete=True, rows=actual)
        save()
        print(json.dumps(dict(table=part['table'], rows=actual, status='READ_BACK_PASS')), flush=True)
    (OUT/'import_audit.json').write_text(json.dumps(dict(run_id=RUN, status='PASS', before=before,
        after={table: count(client, table) for table in TABLES}), indent=2)+'\n')


def verify():
    cases = [
        ('download_chain', 'TG-F02', 'rapid_pull', '12:00', '12:10', {},
         dict(has_token_record=1, has_manifest_record=1, has_key_record=1,
              chain_missing_required_step_count=0, missing_steps_unknown_count=0)),
        ('download_content', 'TG-F03', 'rapid_pull', '12:00', '12:10', {'video_scope': 'ALL_VIDEOS'},
         dict(ts_auth_pass_count_obs=720, auth_unique_media_seconds_obs=7200,
              cdn_response_media_seconds_obs=7200, fully_served_media_seconds=7200, auth_unique_speed_ratio=12)),
        ('download_sequence', 'TG-F08', 'rapid_pull', '12:00', '12:10', {},
         dict(unique_segment_count_obs=720, coverage_ratio_obs=1, monotonic_ratio_obs=1,
              interval_cv_obs=0, unknown_segment_index_count=0)),
        ('download_tool', 'TG-F12', 'rapid_pull', '12:00', '12:10', {'subject_type': 'VIEWER'},
         dict(tool_event_count_obs=1443, tool_request_stage_count_obs=5)),
        ('shared_environments', 'TG-F06', 'token_shared', '13:00', '13:10', {},
         dict(token_env_count_obs=2, token_ip_count_obs=2, token_ua_class_count_obs=2,
              env_switch_count=39, interleaved_env_pair_count=1, env_observed_span_overlap_s=185)),
        ('shared_validity', 'TG-F05', 'token_shared', '13:00', '13:10', {'event_type': 'TS_VALIDATE'},
         dict(token_valid_event_count=40, token_expired_event_count=0,
              token_revoked_event_count=0, out_of_scope_attempt_count_obs=0)),
        ('shared_identity', 'TG-F07', 'token_shared', '13:00', '13:10', {},
         dict(subject_ip_count_obs=2, ua_class_count_obs=2, env_count_obs=2)),
        ('sustained_content', 'TG-F10', 'sustained_access', None, None, {},
         dict(active_minute_count_obs=960, longest_observed_active_minute_run=960,
              max_observed_request_gap_s=10, unique_media_seconds_24h=57600,
              request_equivalent_seconds_24h=57600, active_minute_fraction_obs=2/3,
              full_day_feature_status='AVAILABLE')),
        ('sustained_playback', 'TG-F04', 'sustained_access', None, None, {},
         dict(window_active_video_count_obs=8, playback_state_concurrent_video_count=1,
              playback_state_overlap_seconds=0)),
    ]
    client = Client()
    files = {p.name[:6]: p for p in (REPO/'sql/features').glob('TG-F*.sql')}
    results = []
    for name, group, scenario, start, end, where, expected in cases:
        row = dict(case=name, feature_group=group, scenario_id=scenario)
        try:
            start = f'2026-10-23 {start}:00.000' if start else DAY_START
            end = f'2026-10-23 {end}:00.000' if end else DAY_END
            where = dict(where)
            if group in ('TG-F05', 'TG-F06'):
                where['subject_id'] = ROW_PREFIX + scenario + ':1:token'
            elif group == 'TG-F02':
                where['token_ref'] = ROW_PREFIX + scenario + ':1:token'
            else:
                where['subject_id'] = f'sim_{scenario}_case_supplement_viewer'
            params = dict(run_id=RUN, user_id='980107c0ab', scenario_id=scenario,
                          window_start=start, window_end=end)
            response = client.request(files[group].read_text().strip().rstrip(';'), params)
            (OUT/(name+'.result.json')).write_text(json.dumps(response, ensure_ascii=False, indent=2)+'\n')
            matches = [r for r in response['data'] if all(r.get(k) == v for k, v in where.items())]
            differences = {}
            if len(matches) != 1:
                differences['row_count'] = dict(expected=1, actual=len(matches))
            else:
                for key, value in expected.items():
                    actual = matches[0].get(key)
                    equal = (isinstance(actual, (int, float)) and math.isclose(actual, value, rel_tol=1e-8, abs_tol=1e-8)
                             if isinstance(value, (int, float)) else actual == value)
                    if not equal:
                        differences[key] = dict(expected=value, actual=actual)
            row.update(status='FAIL' if differences else 'PASS', differences=differences,
                       sql_sha256=hashlib.sha256(files[group].read_bytes()).hexdigest())
        except (RuntimeError, ValueError, KeyError) as exc:
            row.update(status='ERROR', error=str(exc))
        results.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    report = dict(run_id=RUN, status='PASS' if all(r['status'] == 'PASS' for r in results) else 'FAIL',
                  passed=sum(r['status'] == 'PASS' for r in results), cases=len(results), results=results)
    (OUT/'feature_verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    return report['status'] == 'PASS'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['load', 'verify'])
    args = parser.parse_args()
    if args.operation == 'load':
        load()
    else:
        raise SystemExit(0 if verify() else 1)
