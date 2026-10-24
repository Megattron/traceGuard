"""HTTP client restricted to DA_CLICKHOUSE_DB_TEST and isolated validation writes."""
import base64
import gzip
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TASK = Path(__file__).resolve().parents[1]
RUN_ID = 'tg_980107c0ab_20261016_20261023_v1'
USER_ID = '980107c0ab'
PREFIX = 'da.tg_validation_'


class Client:
    def __init__(self):
        env = json.loads((ROOT / 'settings.local.json').read_text())['env']
        self.config = {k: env['DA_CLICKHOUSE_DB_TEST_' + k] for k in ('HOST', 'PORT', 'DB', 'USER', 'PASS')}
        host = self.config['HOST'].rstrip('/')
        if '://' not in host:
            host = 'http://' + host
        parsed = urllib.parse.urlsplit(host)
        self.url = host if parsed.port else host + ':' + str(self.config['PORT'])
        auth = self.config['USER'] + ':' + self.config['PASS']
        self.headers = {'Authorization': 'Basic ' + base64.b64encode(auth.encode()).decode()}
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, sql, params=None, payload=None):
        statement = re.sub(r'/\*.*?\*/', '', sql, flags=re.S)
        statement = re.sub(r'(?m)^\s*--[^\n]*', '', statement).strip()
        is_read = bool(re.match(r'(?is)^(WITH|SELECT|SHOW|DESCRIBE|EXPLAIN)\b', statement))
        if not is_read:
            match = re.match(r'(?is)^(?:CREATE\s+(?:TABLE|VIEW)\s+IF\s+NOT\s+EXISTS|INSERT\s+INTO)\s+(da\.tg_validation_[a-z0-9_]+)\b', statement)
            if not match:
                raise ValueError('Write rejected: only CREATE IF NOT EXISTS / INSERT into da.tg_validation_* allowed')
            if re.search(r'(?is)\b(DROP|TRUNCATE|DELETE|ALTER|UPDATE)\b', statement):
                raise ValueError('Destructive statements are prohibited')
        settings = {'database': self.config['DB'], 'max_execution_time': '120',
                    'max_result_rows': '0', 'max_result_bytes': '0',
                    'output_format_json_quote_64bit_integers': '0',
                    'max_threads': '2'}
        settings.update({'param_' + k: str(v) for k, v in (params or {}).items()})
        if is_read:
            settings['readonly'] = '1'
            body = (sql.rstrip().rstrip(';') + '\nFORMAT JSON').encode()
        elif payload is not None:
            settings['query'] = sql
            body = payload
        else:
            body = sql.encode()
        headers = dict(self.headers)
        headers['Content-Encoding'] = 'gzip'
        body = gzip.compress(body, compresslevel=1)
        req = urllib.request.Request(self.url + '/?' + urllib.parse.urlencode(settings), data=body, headers=headers)
        try:
            with self.opener.open(req, timeout=150) as response:
                result = response.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            message = exc.read().decode(errors='replace') if isinstance(exc, urllib.error.HTTPError) else str(exc)
            for key in ('HOST', 'USER', 'PASS'):
                value = self.config[key]
                if value:
                    message = message.replace(str(value), '[REDACTED]')
            raise RuntimeError(message[:6000]) from None
        return json.loads(result) if is_read else {'ok': True}

    def query_file(self, path, scenario='', start='2026-10-16 00:00:00', end='2026-10-24 00:00:00', limit=None):
        sql = Path(path).read_text().strip().rstrip(';')
        if limit is not None:
            sql = 'SELECT * FROM (' + sql + ') LIMIT ' + str(int(limit))
        return self.request(sql, {'run_id': RUN_ID, 'user_id': USER_ID, 'scenario_id': scenario,
                                 'window_start': start, 'window_end': end})


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['schema', 'smoke', 'query'])
    parser.add_argument('--file')
    parser.add_argument('--scenario', default='')
    parser.add_argument('--start', default='2026-10-16 00:00:00')
    parser.add_argument('--end', default='2026-10-24 00:00:00')
    parser.add_argument('--out')
    args = parser.parse_args()
    client = Client()
    if args.operation == 'schema':
        for path in sorted((TASK / 'sql/validation').glob('0*.sql')):
            for sql in path.read_text().split(';'):
                if sql.strip():
                    client.request(sql)
            print(path.name + ': OK', flush=True)
    elif args.operation == 'smoke':
        for path in sorted((TASK / 'sql/features').glob('TG-F*.sql')):
            try:
                result = client.query_file(path, args.scenario, args.start, args.end, limit=2)
                print(json.dumps({'file': path.name, 'rows': result['rows'], 'status': 'OK'}), flush=True)
            except RuntimeError as exc:
                print(json.dumps({'file': path.name, 'status': 'FAIL', 'error': str(exc)}), flush=True)
    else:
        result = client.query_file(args.file, args.scenario, args.start, args.end)
        if args.out:
            Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2))
            print(json.dumps({'rows': result['rows'], 'output': args.out}))
        else:
            print(json.dumps(result, ensure_ascii=False))
