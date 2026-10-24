"""Business invariants for the isolated demonstration dataset."""
import sys
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from generate_demo_cases import build, RUN


class DemoCasesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tables = build()

    def events(self, scenario, kind):
        return [r for r in self.tables['events']
                if r['scenario_id'] == scenario and r['event_type'] == kind]

    def test_uses_existing_application_run_and_scenario_names(self):
        self.assertEqual(RUN, 'tg_980107c0ab_20261016_20261023_v1')
        self.assertEqual({r['scenario_id'] for r in self.tables['events']},
                         {'rapid_pull', 'token_shared', 'sustained_access'})

    def test_keys_and_media_mapping_are_unique(self):
        events = self.tables['events']
        self.assertEqual(len(events), len({r['event_id'] for r in events}))
        media = self.tables['media_segments']
        keys = {(r['scenario_id'], r['object_path']) for r in media}
        self.assertEqual(len(media), len(keys))
        for r in events:
            self.assertEqual(r['run_id'], RUN)
            self.assertEqual(r['dataset_kind'], 'SYNTHETIC')
            self.assertEqual(r['source'], 'SIMULATOR')
            if r['event_type'] in ('TS_VALIDATE', 'CDN_MEDIA_ACCESS'):
                self.assertIn((r['scenario_id'], '/' + r['request_url'].split('/', 3)[3]), keys)

    def test_download_has_one_complete_chain_and_720_delivered_segments(self):
        auth = self.events('rapid_pull', 'TS_VALIDATE')
        cdn = self.events('rapid_pull', 'CDN_MEDIA_ACCESS')
        self.assertEqual(len(auth), 720)
        self.assertEqual(len(cdn), 720)
        self.assertEqual(len({r['request_ref'] for r in auth}), 720)
        self.assertTrue(all(r['user_agent'].startswith('ffmpeg/') for r in auth + cdn))
        self.assertTrue(all(r['http_status'] == 200 and r['response_completed'] == 1 for r in cdn))
        token = self.events('rapid_pull', 'TOKEN_CREATE')[0]
        key = self.events('rapid_pull', 'KEY_RESPONSE')[0]
        self.assertLess(token['event_time'], key['event_time'])
        self.assertLess(key['event_time'], auth[0]['event_time'])
        self.assertEqual(token['token_ref'], auth[0]['token_ref'])

    def test_shared_token_has_twenty_successes_in_each_environment(self):
        rows = self.events('token_shared', 'TS_VALIDATE')
        self.assertEqual(len({r['token_ref'] for r in rows}), 1)
        self.assertEqual(sorted(Counter((r['request_ip'], r['user_agent']) for r in rows).values()), [20, 20])
        self.assertTrue(all(r['auth_result'] == 1 for r in rows))

    def test_sustained_is_sixteen_hours_of_unique_content_across_eight_courses(self):
        rows = self.events('sustained_access', 'TS_VALIDATE')
        self.assertEqual(len(rows), 5760)
        self.assertEqual(len({r['event_time'][:16] for r in rows}), 960)
        self.assertEqual(len({r['video_id'] for r in rows}), 8)
        media = [r for r in self.tables['media_segments'] if r['scenario_id'] == 'sustained_access']
        self.assertEqual(sum(r['segment_duration_s'] for r in media), 57600)
        self.assertEqual(len(self.events('sustained_access', 'PLAYBACK_STATE')), 968)


if __name__ == '__main__':
    unittest.main()
