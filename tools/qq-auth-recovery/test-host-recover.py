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
    def test_offline_repair_rotates_only_the_msf_pair_with_the_client_stopped(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch).resolve()
            profile = root / 'napcat-state' / 'qq-active'
            cache = profile / 'global' / 'nt_data' / 'mmkv'
            cache.mkdir(parents=True)
            pair = [cache / worker.MSF_CONFIG, cache / (worker.MSF_CONFIG + '.crc')]
            other = cache / 'mmkv.default'
            other.write_text('keep')
            for f in pair:
                f.write_text(f.name)
            mount = {'Type': 'bind', 'RW': True, 'Source': str(profile), 'Destination': '/app/.config/QQ'}
            running = True

            def docker(args, **kwargs):
                nonlocal running
                if args[1] == 'inspect':
                    return worker.subprocess.CompletedProcess(args, 0, 'client-id\n' + json.dumps([mount]))
                self.assertEqual(args[-1], 'client-id')
                if args[1] == 'stop':
                    self.assertTrue(running)
                    self.assertTrue(all(f.exists() for f in pair))
                    running = False
                else:
                    self.assertEqual(args[1], 'start')
                    self.assertFalse(running)
                    running = True

            with patch.object(worker, 'DEPLOY', root / 'auth-deploy'), patch.object(worker.subprocess, 'run', side_effect=docker):
                self.assertTrue(worker.repair_msf_cache())
                self.assertTrue(running)
                for f in pair:
                    self.assertFalse(f.exists())
                    self.assertEqual(f.with_name(f.name + '.qq-farm-previous').read_text(), f.name)
                self.assertEqual(other.read_text(), 'keep')
                self.assertFalse(worker.repair_msf_cache())
                for f in pair:
                    f.write_text('second generation')
                with patch.object(worker, 'quarantine_cache', side_effect=OSError()):
                    with self.assertRaises(OSError):
                        worker.repair_msf_cache()
                self.assertTrue(running)
                mount['Source'] = str(root)
                self.assertFalse(worker.repair_msf_cache())

    def test_nonregular_cache_member_leaves_both_files_untouched(self):
        with tempfile.TemporaryDirectory() as scratch:
            cache = Path(scratch).resolve()
            f = cache / worker.MSF_CONFIG
            f.write_text('config')
            f.with_suffix('.crc').symlink_to(f)
            with self.assertRaises(ValueError):
                worker.quarantine_cache(cache)
            self.assertEqual(f.read_text(), 'config')

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
