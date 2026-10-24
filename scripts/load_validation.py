"""Resumable imports; never changes or deletes original DWD rows or other runs."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path

from ch_client import Client, PREFIX, RUN_ID, TASK

DATA = TASK / 'data/validation'


def load(fixtures_only=False, reload=False):
    manifest = json.loads((DATA / 'manifest.json').read_text())
    if manifest['run_id'] != RUN_ID:
        raise ValueError('Unexpected run_id')
    checkpoint_path = DATA / 'load_checkpoint.json'
    checkpoint = json.loads(checkpoint_path.read_text()) if checkpoint_path.exists() else {'run_id': RUN_ID, 'completed': {}}
    if checkpoint['run_id'] != RUN_ID:
        raise ValueError('Checkpoint belongs to another run')
    client = Client()
    for part in manifest['parts']:
        if fixtures_only and part['table'] == 'events' and part['part'] not in ('fixtures', 'observed'):
            continue
        path = DATA / part['file']
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != part['sha256']:
            raise ValueError('Checksum mismatch: ' + part['file'])
        completed = checkpoint['completed'].get(path.name, {})
        if completed and completed.get('sha256') != digest:
            raise ValueError('Previously loaded file has changed; use a new run_id rather than mixing versions: ' + path.name)
        with gzip.open(path, 'rb') as stream:
            batch = []
            batch_number = 0
            rows = 0
            for line in stream:
                batch.append(line)
                if len(batch) < 5000:
                    continue
                if reload or batch_number >= completed.get('batches', 0):
                    client.request('INSERT INTO ' + PREFIX + part['table'] + ' FORMAT JSONEachRow', payload=b''.join(batch))
                rows += len(batch)
                batch_number += 1
                checkpoint['completed'][path.name] = {'sha256': digest, 'batches': batch_number, 'rows': rows}
                temp = checkpoint_path.with_suffix('.tmp')
                temp.write_text(json.dumps(checkpoint, indent=2))
                temp.replace(checkpoint_path)
                batch = []
            if batch:
                if reload or batch_number >= completed.get('batches', 0):
                    client.request('INSERT INTO ' + PREFIX + part['table'] + ' FORMAT JSONEachRow', payload=b''.join(batch))
                rows += len(batch)
                batch_number += 1
            checkpoint['completed'][path.name] = {'sha256': digest, 'batches': batch_number, 'rows': rows, 'complete': True}
            temp = checkpoint_path.with_suffix('.tmp')
            temp.write_text(json.dumps(checkpoint, indent=2))
            temp.replace(checkpoint_path)
            print(json.dumps({'file': path.name, 'logical_records': rows, 'batches': batch_number}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixtures-only', action='store_true')
    parser.add_argument('--reload', action='store_true', help='Reimport exact same files; FINAL must remain idempotent')
    args = parser.parse_args()
    load(args.fixtures_only, args.reload)
