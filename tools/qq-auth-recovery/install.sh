#!/usr/bin/env bash
set -euo pipefail
umask 077
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=${1:-/opt/services/qq-farm-classic}
[[ "$root" == '/opt/services/qq-farm-classic' ]] || {
  printf 'This systemd integration uses /opt/services/qq-farm-classic.\n' >&2
  exit 1
}
upstream="$root/qq-miniapp-auth"
deploy="$root/auth-deploy"
releases="$deploy/recovery"
base="$deploy/compose.yaml"
pin=ec3123a06ca09ebd7759cc61e96801f1fde6c78e

test -f "$base"
test "$(git -C "$upstream" rev-parse HEAD)" = "$pin" || {
  printf 'QQ auth source differs from the pinned patch base.\n' >&2
  exit 1
}
mkdir -p "$releases/control"
exec 9>"$releases/install.lock"
flock -n 9 || { printf 'QQ auth update already running.\n' >&2; exit 1; }
previous=$(readlink -f "$releases/current" 2>/dev/null || true)
if [[ ! -f "$previous/compose.yaml" ]]; then previous=""; fi

stage=$(mktemp -d "$releases/release-XXXXXXXX")
git -C "$upstream" show "$pin:server.js" > "$stage/server.js"
cp "$here/readiness.mjs" "$stage/qr-readiness.mjs"
cp "$here/compose.yaml" "$stage/compose.yaml"
(cd "$stage" && git apply --unidiff-zero --check "$here/server.patch" && git apply --unidiff-zero "$here/server.patch")
chmod 644 "$stage"/*.js "$stage"/*.mjs
export QQ_AUTH_RECOVERY_RELEASE="$stage"

docker compose -f "$base" -f "$stage/compose.yaml" config --quiet
docker exec qq-farm-qq-auth node -e '
  fetch("http://127.0.0.1:8787/api/health",{signal:AbortSignal.timeout(4000)})
    .then(response=>response.json())
    .then(status=>{ if(status.ok!==true || status.workflowBusy)process.exitCode=1; })
    .catch(()=>{process.exitCode=1;});
' || { printf 'QQ auth is not idle or reachable. No container was changed.\n' >&2; exit 1; }

install -m 644 "$here/host-recover.py" "$releases/host-recover.py"
install -m 644 "$here/qq-farm-qr-recovery.path" "$here/qq-farm-qr-recovery.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now qq-farm-qr-recovery.path

ready() {
  for (( attempt=0; attempt<20; attempt++ )); do
    if docker exec qq-farm-qq-auth node -e '
      fetch("http://127.0.0.1:8787/api/health",{signal:AbortSignal.timeout(2000)})
        .then(response=>response.json())
        .then(status=>{ if(status.ok!==true || typeof status.qrReadiness!=="string")process.exitCode=1; })
        .catch(()=>{process.exitCode=1;});
    ' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

if ! docker compose -f "$base" -f "$stage/compose.yaml" up -d --no-deps --no-build qq-auth || ! ready; then
  printf 'QQ auth did not start. Restoring the previous container configuration.\n' >&2
  if [[ -n "$previous" ]]; then
    export QQ_AUTH_RECOVERY_RELEASE="$previous"
    docker compose -f "$base" -f "$previous/compose.yaml" up -d --no-deps --no-build qq-auth
  else
    docker compose -f "$base" up -d --no-deps --no-build qq-auth
  fi
  exit 1
fi
ln -s "$stage" "$stage.current"
mv -Tf "$stage.current" "$releases/current"
printf 'QQ auth recovery installed from %s.\n' "$stage"
