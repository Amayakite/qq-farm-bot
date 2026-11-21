import importlib.util
import json
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('host_recover', Path(__file__).with_name('host-recover.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class RecoveryTest(unittest.TestCase):
    def test_only_the_active_recovery_lease_can_recreate_the_napcat_container(self):
        with tempfile.TemporaryDirectory() as scratch:
            deploy = Path(scratch)
            recovery = deploy / 'recovery'
            release = recovery / 'release-example'
            release.mkdir(parents=True)
            (release / 'compose.yaml').touch()
            (recovery / 'current').symlink_to(release)
            request = {'id': str(uuid.uuid4()), 'at': int(time.time() * 1000)}
            last = recovery / 'last'
            with patch.multiple(worker, DEPLOY=deploy, RECOVERY=recovery, LAST_RUN=last), patch.object(worker.subprocess, 'run') as run:
                state = {'state': 'recreating', 'busy': True, 'id': str(uuid.uuid4())}
                run.return_value.stdout = json.dumps(state)
                self.assertFalse(worker.recreate(request))
                self.assertEqual(run.call_count, 1)
                self.assertFalse(last.exists())
                state['id'] = request['id']
                run.return_value.stdout = json.dumps(state)
                self.assertTrue(worker.recreate(request))
                self.assertEqual(run.call_args.args[0][-4:], ['--no-deps', '--no-build', '--force-recreate', 'napcat'])
                run.reset_mock()
                self.assertFalse(worker.recreate(request))
                run.assert_not_called()

    def test_rejects_stale_or_malformed_requests(self):
        now = time.time()
        with self.subTest('old request'):
            self.assertFalse(worker.valid_request({'id': str(uuid.uuid4()), 'at': int((now - 60) * 1000)}, now))
        with self.subTest('invalid ID'):
            self.assertFalse(worker.valid_request({'id': '../../compose.yaml', 'at': int(now * 1000)}, now))


if __name__ == '__main__':
    unittest.main()
