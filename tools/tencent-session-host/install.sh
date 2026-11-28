#!/usr/bin/env bash
# Install the independent session host alongside the existing Tencent deployment.
# The host image is deliberately pinned; ordinary application updates do not restart it.
set -Eeuo pipefail
umask 077
base=/opt/services/qq-farm-classic
compose="$base/compose.yaml"
updater="$base/update.sh"
host_compose="$base/session-host/compose.yaml"
runtime_volume=qq-farm-classic-session-runtime
[[ $(id -u) -eq 0 && -f "$compose" && -x "$updater" ]] || { echo 'Existing Tencent deployment not found.' >&2; exit 1; }
exec 9>"$base/.update.lock"
flock -n 9 || { echo 'Another update is running.' >&2; exit 1; }
if grep -q 'FARM_SESSION_SOCKET:' "$compose"; then
    echo 'Session host is already configured; inspect the existing installation.' >&2
    exit 1
fi
if docker container inspect qq-farm-session-host >/dev/null 2>&1 || [[ -e "$host_compose" ]]; then
    echo 'A session host installation already exists; no changes made.' >&2
    exit 1
fi
image=$(docker compose -f "$compose" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["qq-farm-classic"]["image"])')
[[ "$image" =~ ^local/qq-farm-classic:[a-f0-9]+$ ]] || { echo 'Unexpected application image.' >&2; exit 1; }
docker image inspect "$image" >/dev/null
backup="$base/backups/session-host-install-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -m 700 "$backup"
cp -p "$compose" "$backup/compose.yaml"
cp -p "$updater" "$backup/update.sh"
candidate=$(mktemp "$base/.session-compose-XXXXXXXX.yaml")
candidate_updater=$(mktemp "$base/.session-update-XXXXXXXX.sh")
host_started=0
changed=0
success=0
cleanup() {
    rc=$?
    trap - EXIT
    rm -f "$candidate" "$candidate_updater"
    if [[ $success != 1 ]]; then
        if [[ $changed == 1 ]]; then
            cp -p "$backup/compose.yaml" "$compose"
            cp -p "$backup/update.sh" "$updater"
            docker compose -f "$compose" up -d --no-build qq-farm-classic >/dev/null || true
        fi
        if [[ $host_started == 1 ]]; then docker compose -f "$host_compose" down >/dev/null || true; fi
        rm -f "$host_compose"
        echo "Session-host install failed; prior configuration is in $backup." >&2
    fi
    exit "$rc"
}
trap cleanup EXIT

python3 - "$compose" "$candidate" "$updater" "$candidate_updater" "$runtime_volume" <<'PY'
from pathlib import Path
import sys
compose, candidate, updater, candidate_updater, volume = sys.argv[1:]
text = Path(compose).read_text()
def replace_once(text, old, new):
    if text.count(old) != 1: raise SystemExit('Unexpected deployment layout; no changes made')
    return text.replace(old, new, 1)
text = replace_once(text, '      - farm_logs:/app/core/data/logs\n', '      - farm_logs:/app/core/data/logs\n      - farm_runtime:/app/runtime\n')
text = replace_once(text, '    environment:\n', '    environment:\n      FARM_RUNTIME_DIR: /app/runtime\n      FARM_SESSION_SOCKET: /app/runtime/session-host.sock\n')
text = replace_once(text, '    restart: unless-stopped\n', '    restart: unless-stopped\n    stop_grace_period: 45s\n')
text = replace_once(text, '  farm_logs:\n', '  farm_logs:\n  farm_runtime:\n    name: ' + volume + '\n')
Path(candidate).write_text(text)
script = Path(updater).read_text()
marker = 'echo \'Stopping the application and backing up its data...\'\n'
guard = '''# Refuse a backend whose IPC protocol cannot attach to the running host.
if docker container inspect qq-farm-session-host >/dev/null 2>&1; then
  host_ipc=$(docker exec qq-farm-session-host node -e "require('./dist/session/ipc').SessionClient.open('control').then(async c=>{const s=await c.call('status');console.log(s.ipcVersion);c.close()}).catch(()=>process.exit(1))") || { echo 'Session host is unavailable; update stopped.' >&2; exit 1; }
  next_ipc=$(docker run --rm --entrypoint node "$IMAGE" -e "console.log(require('@qq-farm-bot/session-contract').SESSION_IPC_VERSION)")
  [[ "$host_ipc" == "$next_ipc" ]] || { echo 'Session host IPC version differs; update stopped.' >&2; exit 1; }
fi
'''
script = replace_once(script, marker, guard + marker)
script = script.replace('多租户会话在服务重启后需重新登录。', '业务容器更新时独立宿主保持游戏连接；宿主或整机重启后可能需要重新登录。')
Path(candidate_updater).write_text(script)
PY
chmod 600 "$candidate"
chmod 700 "$candidate_updater"
docker compose -f "$candidate" config --quiet
mkdir -p "$(dirname "$host_compose")"
cat > "$host_compose" <<EOF
services:
  session-host:
    image: $image
    container_name: qq-farm-session-host
    command: [node, dist/session/host.js]
    restart: unless-stopped
    environment:
      TZ: Asia/Shanghai
      NODE_ENV: production
      FARM_HOST_DATA_DIR: /app/runtime/session-host-data
      FARM_RUNTIME_DIR: /app/runtime
      FARM_SESSION_SOCKET: /app/runtime/session-host.sock
    volumes:
      - farm_runtime:/app/runtime
    healthcheck:
      test: [CMD, node, -e, "require('./dist/session/ipc').SessionClient.open('control').then(c => c.close()).catch(() => process.exit(1))"]
      interval: 5s
      timeout: 4s
      retries: 5
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'
volumes:
  farm_runtime:
    name: $runtime_volume
EOF
chmod 600 "$host_compose"
docker compose -f "$host_compose" config --quiet
host_started=1
docker compose -f "$host_compose" up -d --no-build
for _ in $(seq 1 30); do
    if docker exec qq-farm-session-host node -e "require('./dist/session/ipc').SessionClient.open('control').then(c=>c.close()).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi
    sleep 1
done
docker exec qq-farm-session-host node -e "require('./dist/session/ipc').SessionClient.open('control').then(c=>c.close()).catch(()=>process.exit(1))"
changed=1
mv "$candidate" "$compose"
mv "$candidate_updater" "$updater"
docker compose -f "$compose" up -d --no-build qq-farm-classic
for _ in $(seq 1 45); do
    if curl -fsS --max-time 2 http://127.0.0.1:13007/api/game-version >/dev/null 2>&1; then break; fi
    sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:13007/api/game-version >/dev/null
success=1
echo "Independent session host enabled. Previous configuration: $backup"
echo 'Existing consumed game Codes require one fresh scan; later backend updates can reuse live sessions.'
