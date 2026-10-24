"""Generate synthetic case supplements using the original application naming."""
import gzip
import hashlib
import json
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

from generate_validation import EVENT_TYPES, event_defaults, dimension_defaults, stamp
from fixtures import ANDROID_UA, IOS_UA

RUN = 'tg_980107c0ab_20261016_20261023_v1'
ROW_PREFIX = RUN + ':case_supplement_v1:'
OUT = Path(__file__).resolve().parents[1] / 'data/case_supplement_v1'
TABLES = ('events', 'media_segments', 'token_snapshots')
TOOL_UA = 'ffmpeg/7.0'


def build():
    tables = {name: [] for name in TABLES}
    counters = Counter()

    def event(scenario, at, kind, context, **fields):
        counters[scenario] += 1
        identity = f'{ROW_PREFIX}{scenario}:{counters[scenario]:06d}'
        row = event_defaults(dict(context, event_id=identity, event_time=at,
            event_type=kind, scenario_id=scenario, source='SIMULATOR',
            ingest_time='2026-10-23 23:59:59.999',
            raw_log_ref='synthetic://' + identity, quality_flags=['SYNTHETIC', 'DEMO_CASE']), 'case_supplement_v1')
        row.update(fields)
        row['run_id'] = RUN
        for key in ('event_time', 'ingest_time', 'key_valid_until', 'state_valid_until'):
            row[key] = stamp(row[key])
        tables['events'].append(row)

    def dimension(table, **fields):
        row = dimension_defaults(table, fields, len(tables[table]))
        row['run_id'] = RUN
        tables[table].append(row)

    def context(scenario, course, at, ua=ANDROID_UA):
        video = f'sim_course_{course:02d}'
        token = f'{ROW_PREFIX}{scenario}:{course}:token'
        result = dict(viewer_id=f'sim_{scenario}_case_supplement_viewer', credential_viewer_id=f'sim_{scenario}_case_supplement_viewer',
            identity_basis='AUTHENTICATED_VIEWER', video_id=video, token_ref=token,
            session_ref=f'{ROW_PREFIX}{scenario}:{course}:session', association_status='CONFIRMED',
            request_ip='198.51.100.1', viewer_ip='198.51.100.1', ip_basis='TRUSTED_REQUEST',
            user_agent=ua)
        dimension('token_snapshots', scenario_id=scenario, row_key=token,
            token_ref=token, effective_at=at, original_issued_at=at, last_renewed_at=at,
            expires_at=at+timedelta(hours=3), allowed_video_ids=[video],
            credential_viewer_id=result['viewer_id'], policy_version='demo_policy_1')
        event(scenario, at, 'IDENTITY_BIND', result)
        event(scenario, at+timedelta(milliseconds=10), 'TOKEN_CREATE', result,
              auth_result=1, token_action='ISSUE', user_agent='customer-backend/1.0',
              identity_basis='CUSTOMER_SERVER', viewer_id=None)
        event(scenario, at+timedelta(milliseconds=100), 'MANIFEST_REQUEST', result,
              http_status=200, response_completed=1,
              request_url=f'https://demo.invalid/{scenario}/{video}/index.m3u8')
        event(scenario, at+timedelta(milliseconds=200), 'HLS_KEY_VALIDATE', result,
              auth_result=1, http_status=200)
        event(scenario, at+timedelta(milliseconds=300), 'KEY_RESPONSE', result,
              http_status=200, response_completed=1, key_valid_until=at+timedelta(hours=2))
        return result

    def segment(scenario, ctx, index, total, at, *, ip=None, ua=None, state=False):
        path = f'/{scenario}/{ctx["video_id"]}/{index}.ts'
        dimension('media_segments', scenario_id=scenario, row_key=ROW_PREFIX+path,
            video_id=ctx['video_id'], object_path=path,
            resource_version='demo_resource_v1', content_version=ctx['video_id']+'_v1',
            playlist_ref=ctx['video_id']+':playlist', rendition_ref='1080p',
            segment_index=index, total_segments=total,
            media_start_s=index*10., media_end_s=(index+1)*10., segment_duration_s=10.)
        fields = dict(request_url='https://demo.invalid'+path, segment_index_raw=index,
            native_sequence=index, request_ref=ctx['session_ref']+f':media:{index}')
        if ip:
            fields.update(request_ip=ip, viewer_ip=ip)
        if ua:
            fields['user_agent'] = ua
        event(scenario, at, 'TS_VALIDATE', ctx, auth_result=1, **fields)
        if scenario != 'token_shared':
            event(scenario, at+timedelta(milliseconds=10), 'CDN_MEDIA_ACCESS', ctx,
                http_status=200, response_completed=1, response_bytes=100000,
                object_size=100000, sampling_unit='CDN_REQUEST', **fields)
        if state:
            event(scenario, at, 'PLAYBACK_STATE', ctx, state='PLAYING',
                current_time_s=index*10., playback_rate=1., trusted_state=1,
                state_valid_until=at+timedelta(seconds=71), sampling_unit='STATE_EVENT')

    start = datetime(2026, 10, 23, 12)
    ctx = context('rapid_pull', 1, start, TOOL_UA)
    for index in range(720):
        segment('rapid_pull', ctx, index, 720, start+timedelta(seconds=1+index/10))

    start = datetime(2026, 10, 23, 13)
    ctx = context('token_shared', 1, start)
    for index in range(40):
        segment('token_shared', ctx, index, 720, start+timedelta(seconds=1+index*5),
                ip='198.51.100.2' if index % 2 else '198.51.100.1',
                ua=IOS_UA if index % 2 else ANDROID_UA)

    for course in range(1, 9):
        start = datetime(2026, 10, 23)+timedelta(hours=(course-1)*2)
        ctx = context('sustained_access', course, start)
        for index in range(720):
            segment('sustained_access', ctx, index, 720,
                    start+timedelta(seconds=1+index*10), state=index % 6 == 0)
        event('sustained_access', start+timedelta(hours=2), 'PLAYBACK_STATE', ctx,
              state='STOPPED', current_time_s=7200., trusted_state=1,
              state_valid_until=start+timedelta(hours=2), sampling_unit='STATE_EVENT')

    return tables


def generate():
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = dict(run_id=RUN, user_id='980107c0ab', timezone='Asia/Shanghai',
        dataset_kind='SYNTHETIC', parts=[],
        courses=[dict(video_id=f'sim_course_{n:02d}', title=f'合成培训课程 {n:02d}', seconds=7200)
                 for n in range(1, 9)])
    for table, rows in build().items():
        path = OUT / (table+'.demo.jsonl.gz')
        payload = ''.join(json.dumps(r, ensure_ascii=False, separators=(',', ':'))+'\n' for r in rows).encode()
        path.write_bytes(gzip.compress(payload, compresslevel=6, mtime=0))
        manifest['parts'].append(dict(table=table, file=path.name, rows=len(rows),
            sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    (OUT/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(manifest['parts'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    generate()
