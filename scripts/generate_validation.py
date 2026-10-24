"""Deterministic, isolated TraceGuard fixtures + eight-day synthetic request dataset."""
import argparse
import collections
import gzip
import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path

from ch_client import RUN_ID, TASK, USER_ID
from fixtures import ANDROID_UA, IOS_UA, build_fixtures

OUT = TASK / 'data/validation'
EVENT_TYPES = ('TOKEN_CREATE', 'TOKEN_RENEW', 'TOKEN_REVOKE', 'IDENTITY_BIND',
               'MANIFEST_REQUEST', 'HLS_KEY_VALIDATE', 'KEY_RESPONSE',
               'TS_VALIDATE', 'CDN_MEDIA_ACCESS', 'PLAYBACK_STATE', 'REQUEST_REJECTED')
START = datetime(2026, 10, 16)
END = datetime(2026, 10, 24)


def stamp(value):
    return value.isoformat(sep=' ', timespec='milliseconds') if isinstance(value, datetime) else value


def event_defaults(row, part):
    at = stamp(row['event_time'])
    identity = row.get('identity_basis', 'AUTHENTICATED_VIEWER')
    result = dict(
        run_id=RUN_ID, dataset_kind='SYNTHETIC', scenario_id='normal',
        record_id=row['event_id'], event_id=row['event_id'], source_event_id='',
        event_time=at, ingest_time=at, event_type='TS_VALIDATE', source='SIMULATOR', user_id=USER_ID,
        viewer_id=None, credential_viewer_id=None, identity_basis=identity,
        video_id='', token_ref='', session_ref=None, association_status='UNKNOWN', request_ref='',
        request_ip=None, viewer_ip=None, ip_basis='UNKNOWN', user_agent=None, request_url='',
        segment_index_raw=None, auth_result=-1, http_status=None, failure_reason=None, token_action=None,
        key_valid_until=None, response_bytes=None, object_size=None, response_completed=None,
        range_start=None, range_end=None, state=None, current_time_s=None, playback_rate=None,
        state_valid_until=None, trusted_state=0, native_sequence=None,
        sampling_rate=1.0, sampling_method='CENSUS', sampling_unit='AUTH_EVENT',
        parse_status='OK', quality_flags=['SYNTHETIC'], raw_log_ref='', load_part=part,
    )
    result.update(row)
    result.update(run_id=RUN_ID, user_id=USER_ID, load_part=part)
    for key in ('event_time', 'ingest_time', 'key_valid_until', 'state_valid_until'):
        result[key] = stamp(result[key])
    return result


def dimension_defaults(table, row, index):
    common = dict(run_id=RUN_ID, user_id=USER_ID, dataset_kind='SYNTHETIC', scenario_id='normal')
    if table == 'media_segments':
        common.update(resource_version='sim_resource_v1', content_version='sim_content_v1',
                      playlist_ref='sim_playlist', rendition_ref='1080p', track_type='VIDEO',
                      segment_index=0, media_start_s=0., media_end_s=10., segment_duration_s=10.,
                      total_segments=720, expected_object_bytes=100000, manifest_available=1)
    elif table == 'token_snapshots':
        common.update(revoked=0, allowed_video_ids=[], credential_viewer_id=None, token_app_id='sim_app',
                      original_issued_at=row.get('effective_at'), last_renewed_at=row.get('effective_at'),
                      policy_version='sim_policy_1')
    elif table == 'source_coverage':
        common.update(coverage_start='2026-10-15 00:00:00.000', coverage_end=stamp(END),
                      is_complete=1, sampling_rate=1., sampling_method='CENSUS',
                      requires_token=1, requires_manifest=1, requires_key=1,
                      key_validity_seconds=3600, request_activity_ttl_seconds=None, protocol_version='sim_hls_1')
    elif table == 'business_config':
        common.update(timezone='Asia/Shanghai', off_hours_start_min=120, off_hours_end_min=360,
                      config_version='sim_night_1', valid_from='2026-09-01 00:00:00.000', valid_to=stamp(END))
    elif table == 'ip_info':
        common = dict(run_id=RUN_ID, dataset_kind='SYNTHETIC', country='SIM_CN', province='SIM_REGION',
                      isp='SIM_ISP', mapping_version='synthetic_1')
    common.update(row)
    common.update(run_id=RUN_ID)
    if table != 'ip_info':
        common['user_id'] = USER_ID
    common.setdefault('row_key', f'{table}:{index}')
    for key, value in list(common.items()):
        common[key] = stamp(value)
    return common


def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def write_part(table, part, rows):
    path = OUT / f'{table}.{part}.jsonl.gz'
    count = 0
    types = collections.Counter()
    kinds = collections.Counter()
    dates = collections.Counter()
    low, high = None, None
    with path.open('wb') as raw:
        # Fixed gzip mtime makes the file checksum stable across regeneration.
        with gzip.GzipFile(filename='', fileobj=raw, mode='wb', compresslevel=1, mtime=0) as stream:
            for index, original in enumerate(rows):
                row = event_defaults(original, part) if table == 'events' else dimension_defaults(table, original, index)
                stream.write((json.dumps(row, separators=(',', ':'), ensure_ascii=False) + '\n').encode())
                count += 1
                kinds[row['dataset_kind']] += 1
                if table == 'events':
                    at = row['event_time']
                    low, high = min(low or at, at), max(high or at, at)
                    types[row['event_type']] += 1
                    dates[at[:10]] += 1
    return dict(table=table, part=part, file=path.name, rows=count, compressed_bytes=path.stat().st_size,
                sha256=file_digest(path), event_types=dict(types), dataset_kinds=dict(kinds),
                dates=dict(dates), min_event_time=low, max_event_time=high)


def normal_day(day, videos, sessions=500):
    for number in range(sessions):
        # Spread complete 20-minute sessions across the whole day, including low activity hours.
        at = day + timedelta(seconds=(number * 167 + day.day * 113) % 84600)
        video = videos[(number + day.day) % len(videos)]
        viewer = f'sim_viewer_{number % 250:03d}'
        key = f'sim_{day:%Y%m%d}_{number:04d}'
        base = dict(scenario_id='normal', viewer_id=viewer, credential_viewer_id=viewer,
                    identity_basis='AUTHENTICATED_VIEWER', video_id=video, token_ref=key + '_token',
                    session_ref=key + '_session', association_status='CONFIRMED',
                    request_ip=f'192.0.2.{number % 200 + 1}', viewer_ip=f'192.0.2.{number % 200 + 1}',
                    ip_basis='TRUSTED_REQUEST', user_agent=IOS_UA if number % 2 else ANDROID_UA)
        def emit(kind, offset, suffix, **fields):
            row = dict(base, event_id=key + ':' + suffix, event_type=kind,
                       event_time=at + timedelta(seconds=offset), request_ref=key + ':req:' + suffix)
            row.update(fields)
            return row
        yield emit('IDENTITY_BIND', 0, 'identity')
        yield emit('TOKEN_CREATE', 0.01, 'token', auth_result=1, token_action='ISSUE',
                   user_agent='curl/8.0 customer-backend', request_ip='203.0.113.250')
        yield emit('MANIFEST_REQUEST', 0.1, 'manifest', http_status=200, response_completed=1,
                   request_url=f'https://media.traceguard.invalid/sim/{video}/index.m3u8')
        yield emit('HLS_KEY_VALIDATE', 0.2, 'key_auth', auth_result=1)
        yield emit('KEY_RESPONSE', 0.3, 'key', http_status=200, response_completed=1,
                   key_valid_until=at + timedelta(hours=1))
        for segment in range(120):
            url = f'https://media.traceguard.invalid/sim/{video}/v1/video/1080/{segment}.ts'
            request = key + f':media:{segment}'
            yield emit('TS_VALIDATE', 1 + segment * 10, f'auth:{segment}', auth_result=1,
                       request_ref=request, request_url=url, segment_index_raw=segment, native_sequence=segment)
            yield emit('CDN_MEDIA_ACCESS', 1.05 + segment * 10, f'cdn:{segment}',
                       request_ref=request, request_url=url, segment_index_raw=segment,
                       http_status=200, response_completed=1, response_bytes=100000, object_size=100000,
                       sampling_unit='CDN_REQUEST')
            if segment % 6 == 0:
                yield emit('PLAYBACK_STATE', 1 + segment * 10, f'state:{segment}',
                           state='PLAYING', current_time_s=segment * 10., playback_rate=1., trusted_state=1,
                           state_valid_until=at + timedelta(seconds=segment * 10 + 71), sampling_unit='STATE_EVENT')
        yield emit('PLAYBACK_STATE', 1201, 'stop', state='STOPPED', trusted_state=1,
                   current_time_s=1200., state_valid_until=at + timedelta(seconds=1201), sampling_unit='STATE_EVENT')
        if number % 25 == 0:
            yield emit('TOKEN_RENEW', 600, 'renew', auth_result=1, token_action='RENEW',
                       user_agent='curl/8.0 customer-backend')


def anomaly_day(day, videos):
    for scenario, count, interval, hour in (
        ('rapid_pull', 720, .1, 12), ('token_shared', 40, 5, 13),
        ('failure_burst', 200, 1, 14), ('sustained_access', 960, 60, 0),
        ('scope_violation', 20, 1, 15), ('missing_chain', 20, 1, 16),
        ('unknown_inputs', 10, 1, 17), ('client_tool', 20, 1, 18),
    ):
        prefix = f'sim_{scenario}_{day:%Y%m%d}'
        for number in range(count):
            at = day + timedelta(hours=hour, seconds=number * interval)
            video = videos[1] if scenario == 'scope_violation' else videos[0]
            segment = number % 720
            row = dict(scenario_id=scenario, event_id=f'{prefix}:{number}:auth', event_time=at,
                       event_type='TS_VALIDATE', source='SIMULATOR',
                       viewer_id=prefix + '_viewer', credential_viewer_id=prefix + '_viewer',
                       identity_basis='AUTHENTICATED_VIEWER', video_id=video, token_ref=prefix + '_token',
                       session_ref=prefix + '_session', association_status='CONFIRMED',
                       request_ip='198.51.100.1', ip_basis='TRUSTED_REQUEST', user_agent=ANDROID_UA,
                       request_ref=f'{prefix}:request:{number}', segment_index_raw=segment,
                       request_url=f'https://media.traceguard.invalid/sim/{video}/v1/video/1080/{segment}.ts',
                       auth_result=1, native_sequence=number)
            if scenario == 'token_shared' and number % 2:
                row.update(request_ip='198.51.100.2', user_agent=IOS_UA)
            if scenario == 'failure_burst' and number < 150:
                row.update(auth_result=0, failure_reason='SIM_INVALID_SIGNATURE')
            if scenario == 'unknown_inputs':
                row.update(auth_result=-1, user_agent=None, request_ip=None, ip_basis='UNKNOWN',
                           parse_status='PARTIAL', quality_flags=['SYNTHETIC', 'MISSING_FIELDS'])
            if scenario == 'client_tool':
                row['user_agent'] = 'python-requests/2.32.0'
            yield row
            if scenario in ('rapid_pull', 'sustained_access'):
                yield dict(row, event_id=f'{prefix}:{number}:cdn', event_type='CDN_MEDIA_ACCESS',
                           event_time=at + timedelta(milliseconds=10), auth_result=-1,
                           http_status=200, response_completed=1, response_bytes=100000, object_size=100000,
                           sampling_unit='CDN_REQUEST')
        # Explicit backend lifetime and blocked-entry events every day.
    prefix = f'sim_lifecycle_{day:%Y%m%d}'
    for number, kind in enumerate(('TOKEN_REVOKE', 'REQUEST_REJECTED')):
        yield dict(scenario_id='lifecycle', event_id=f'{prefix}:{kind}', event_type=kind,
                   event_time=day + timedelta(hours=19, seconds=number),
                   video_id=videos[0], token_ref=prefix + '_token',
                   auth_result=0 if kind == 'REQUEST_REJECTED' else -1,
                   http_status=403 if kind == 'REQUEST_REJECTED' else None,
                   failure_reason='SIM_REVOKED' if kind == 'REQUEST_REJECTED' else None,
                   token_action='REVOKE' if kind == 'TOKEN_REVOKE' else None)


def generate(fixtures_only=False):
    OUT.mkdir(parents=True, exist_ok=True)
    seeds = json.loads((OUT / 'source_seeds.redacted.json').read_text())['data']
    videos = sorted({r['video_id'] for r in seeds if r['video_id']})
    fixture = build_fixtures(USER_ID, RUN_ID, videos)
    (OUT / 'fixture_cases.json').write_text(json.dumps(fixture['cases'], ensure_ascii=False, indent=2))
    parts = []
    dimensions = {name: list(fixture[name]) for name in ('media_segments', 'token_snapshots', 'source_coverage', 'business_config', 'ip_info')}
    parts.append(write_part('events', 'fixtures', fixture['events']))
    observed = []
    for index, seed in enumerate(seeds):
        observed.append(dict(dataset_kind='OBSERVED_REDACTED', scenario_id='source_baseline',
            event_id=seed['source_event_id'] + f':row:{index}', record_id=seed['source_event_id'] + f':row:{index}',
            source_event_id=seed['source_event_id'], event_type=seed['event_type'], source='ORIGINAL_DWD',
            event_time=seed['event_time'], ingest_time=seed['ingest_time'], video_id=seed['video_id'],
            viewer_id=None, credential_viewer_id=seed['credential_viewer_id'] or None,
            identity_basis='CREDENTIAL_BOUND' if seed['credential_viewer_id'] else 'UNKNOWN',
            token_ref=seed['token_ref'], request_ip=seed['client_ip'] or None, ip_basis='UNKNOWN',
            user_agent=seed['user_agent'] or None, request_url=seed['request_url'],
            segment_index_raw=seed['segment_index'], auth_result=seed['success'] if seed['success'] in (0, 1) else -1,
            sampling_rate=None, sampling_method='UNKNOWN', sampling_unit='UNKNOWN',
            quality_flags=['SOURCE_RESULT_SEMANTICS_UNVERIFIED', 'SOURCE_IP_SEMANTICS_UNVERIFIED', 'REDACTED'],
            raw_log_ref=f'da.dwd_vod_play_events:export_row:{index}'))
    parts.append(write_part('events', 'observed', observed))
    if not fixtures_only:
        for video in videos:
            for segment in range(720):
                dimensions['media_segments'].append(dict(row_key=f'main:{video}:{segment}', scenario_id='normal',
                    video_id=video, content_version='sim_content_' + video + '_v1',
                    playlist_ref='sim_playlist_' + video + '_1080',
                    object_path=f'/sim/{video}/v1/video/1080/{segment}.ts', segment_index=segment,
                    media_start_s=segment * 10., media_end_s=(segment + 1) * 10.))
        scenarios = ('normal', 'rapid_pull', 'token_shared', 'failure_burst', 'sustained_access',
                     'scope_violation', 'missing_chain', 'unknown_inputs', 'client_tool', 'lifecycle')
        # Media mappings must have one row per scenario/path; clients do not cross scenario evidence.
        main_media = [row for row in dimensions['media_segments'] if row.get('scenario_id') == 'normal']
        for scenario in scenarios[1:]:
            for original in main_media:
                if original['video_id'] not in videos[:2]:
                    continue
                dimensions['media_segments'].append(dict(original, scenario_id=scenario,
                    row_key=scenario + ':' + original['row_key']))
        for scenario in scenarios:
            dimensions['business_config'].append(dict(row_key='main:' + scenario, scenario_id=scenario))
            for kind in EVENT_TYPES:
                dimensions['source_coverage'].append(dict(row_key='main:' + scenario + ':' + kind,
                    scenario_id=scenario, event_type=kind))
        for ip in [f'192.0.2.{n}' for n in range(1, 201)] + ['198.51.100.1', '198.51.100.2', '203.0.113.250']:
            dimensions['ip_info'].append(dict(row_key='main:' + ip, request_ip=ip))
        for offset in range(8):
            day = START + timedelta(days=offset)
            def rows():
                yield from normal_day(day, videos)
                yield from anomaly_day(day, videos)
            parts.append(write_part('events', day.strftime('%Y%m%d'), rows()))
            for number in range(500):
                at = day + timedelta(seconds=(number * 167 + day.day * 113) % 84600)
                video = videos[(number + day.day) % len(videos)]
                key = f'sim_{day:%Y%m%d}_{number:04d}'
                snapshot = dict(row_key=key, scenario_id='normal', token_ref=key + '_token',
                    effective_at=at, expires_at=at + timedelta(hours=1), allowed_video_ids=[video],
                    credential_viewer_id=f'sim_viewer_{number % 250:03d}')
                dimensions['token_snapshots'].append(snapshot)
                if number % 25 == 0:
                    dimensions['token_snapshots'].append(dict(snapshot, row_key=key + ':renew',
                        effective_at=at + timedelta(seconds=600), expires_at=at + timedelta(hours=2),
                        original_issued_at=at, last_renewed_at=at + timedelta(seconds=600)))
            for scenario in scenarios[1:-1]:
                dimensions['token_snapshots'].append(dict(row_key=f'{scenario}:{day:%Y%m%d}', scenario_id=scenario,
                    token_ref=f'sim_{scenario}_{day:%Y%m%d}_token', effective_at=day, expires_at=day + timedelta(days=1),
                    allowed_video_ids=[videos[0]]))
    dimensions['ip_info'] = list({r['request_ip']: r for r in dimensions['ip_info']}.values())
    for table, rows in dimensions.items():
        parts.append(write_part(table, 'dimensions', rows))
    manifest = dict(run_id=RUN_ID, user_id=USER_ID, timezone='Asia/Shanghai',
        window_start=stamp(START), window_end=stamp(END), fixtures_only=fixtures_only,
        source_rows=len(seeds), source_video_count=len(videos), cases=len(fixture['cases']), parts=parts)
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps({'event_rows': sum(p['rows'] for p in parts if p['table'] == 'events'),
                      'parts': len(parts), 'cases': manifest['cases'], 'manifest': str(OUT / 'manifest.json')}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixtures-only', action='store_true')
    generate(parser.parse_args().fixtures_only)
