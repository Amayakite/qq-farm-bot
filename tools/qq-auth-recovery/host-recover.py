#!/usr/bin/env python3
import fcntl
import json
import os
import re
import stat
import subprocess
import tempfile
import time
from pathlib import Path

DEPLOY = Path('/opt/services/qq-farm-classic/auth-deploy')
RECOVERY = DEPLOY / 'recovery'
CONTROL = RECOVERY / 'control'
REQUEST = CONTROL / 'request.json'
CLAIM = RECOVERY / 'host-request.json'
LAST_RUN = RECOVERY / 'last-container-recreate'
MIN_RECREATE_INTERVAL = 120

HEALTH = '''
fetch("http://127.0.0.1:8787/api/health", {signal:AbortSignal.timeout(3000)})
 .then(r=>r.json()).then(r=>console.log(JSON.stringify({
   state:r.qrReadiness, id:r.qrRecoveryRequest, busy:r.workflowBusy
 }))).catch(()=>process.exitCode=1)
'''


def take_request():
    try:
        os.replace(REQUEST, CLAIM)
    except FileNotFoundError:
        return None
    try:
        fd = os.open(CLAIM, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 256:
                return None
            return json.loads(file.read(257))
    except (OSError, ValueError):
        return None
    finally:
        CLAIM.unlink(missing_ok=True)


def valid_request(request, now):
    if not isinstance(request, dict):
        return False
    request_id, at = request.get('id'), request.get('at')
    return (isinstance(request_id, str)
            and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', request_id)
            and type(at) is int and -1000 <= now * 1000 - at <= 20_000)


def reply(request_id, success):
    with tempfile.NamedTemporaryFile(mode='w', dir=RECOVERY, delete=False) as file:
        staged = Path(file.name)
        json.dump({'id': request_id, 'ok': success}, file)
    try:
        os.replace(staged, CONTROL / 'response.json')
    finally:
        staged.unlink(missing_ok=True)


def recreate(request):
    with (RECOVERY / 'install.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        now = time.time()
        if not valid_request(request, now):
            return False
        if LAST_RUN.is_file() and now - LAST_RUN.stat().st_mtime < MIN_RECREATE_INTERVAL:
            return False
        release = (RECOVERY / 'current').resolve(strict=True)
        if release.parent != RECOVERY.resolve() or not (release / 'compose.yaml').is_file():
            return False
        probe = subprocess.run(
            ['docker', 'exec', 'qq-farm-qq-auth', 'node', '-e', HEALTH],
            capture_output=True, text=True, check=True, timeout=4,
        )
        state = json.loads(probe.stdout)
        if state != {'state': 'recreating', 'id': request['id'], 'busy': True}:
            return False
        LAST_RUN.touch()
        print('Verified QQ outage; recreating the NapCat container.', flush=True)
        subprocess.run(
            ['docker', 'compose', '-f', str(DEPLOY / 'compose.yaml'), '-f', str(release / 'compose.yaml'),
             'up', '-d', '--no-deps', '--no-build', '--force-recreate', 'napcat'],
            env={**os.environ, 'QQ_AUTH_RECOVERY_RELEASE': str(release)}, check=True, timeout=20,
        )
        return True


def main():
    request = take_request()
    if not valid_request(request, time.time()):
        return
    try:
        success = recreate(request)
    except (OSError, ValueError, subprocess.SubprocessError):
        success = False
    reply(request['id'], success)


if __name__ == '__main__':
    main()
