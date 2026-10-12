#!/bin/bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

valid_restart_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}

# Nonsecret, canonical private origin from the connected local Tailscale node.
# Status JSON stays on stdin, never in command arguments or printed diagnostics.
private_tailnet_origin() {
  valid_restart_port "$1" || return 1
  timeout 3 tailscale status --json 2>/dev/null | /usr/bin/python3 -c '
import ipaddress, json, re, sys
try:
    status = json.load(sys.stdin)
    if status.get("BackendState") != "Running":
        sys.exit(1)
    private = []
    for value in status.get("TailscaleIPs", []):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F:.]+", value):
            continue
        try:
            ip = ipaddress.ip_address(value)
        except ValueError:
            continue
        network = ipaddress.ip_network("100.64.0.0/10" if ip.version == 4 else "fd7a:115c:a1e0::/48")
        if ip in network:
            private.append(ip)
    if not private:
        sys.exit(1)
    dns = (status.get("Self") or {}).get("DNSName", "")
    dns = dns.rstrip(".").lower() if isinstance(dns, str) else ""
    if re.fullmatch(r"[a-z0-9-]+\.[a-z0-9-]+\.ts\.net", dns):
        host = dns
    else:
        ip = private[0]
        host = f"[{ip}]" if ip.version == 6 else str(ip)
    print(f"http://{host}:{int(sys.argv[1])}")
except Exception:
    sys.exit(1)
' "$1"
}

# Sourcing defines only the validated discovery helpers; tests never restart Jelly.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi
port=${JELLY_RESTART_PORT:-5173}
if ! valid_restart_port "$port"; then
  echo 'JELLY_RESTART_PORT must be an integer from 1 to 65535.' >&2
  exit 1
fi
port=$((10#$port))
loopback="http://127.0.0.1:$port"

# Run under a separate systemd user unit, not Jelly's own service cgroup.
for attempt in {1..360}; do
  # Explicit holds cover delegated work and review, even between parent runs.
  # The owner removes its own hold only after all children and checks finish.
  if compgen -G "$repo/.jelly/restart-holds/*" > /dev/null; then
    sleep 5
    continue
  fi
  active=$(/usr/bin/python3 - "$repo/.jelly/jelly.sqlite" <<'PY'
import pathlib, sqlite3, sys
uri = pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro'
with sqlite3.connect(uri, uri=True) as db:
    print(db.execute("SELECT count(*) FROM runs WHERE status='running'").fetchone()[0])
PY
)
  if [ "$active" = 0 ]; then
    # Finish the one-time migration from the old transient dev service.
    # It owns the same port and must stop before the persistent service starts.
    if systemctl --user is-active --quiet jelly-dev.service; then
      systemctl --user stop jelly-dev.service
    fi
    systemctl --user daemon-reload
    systemctl --user reload-or-restart jelly.service
    for check in {1..30}; do
      if tailnet=$(private_tailnet_origin "$port") &&
        systemctl --user is-active --quiet jelly.service &&
        curl --fail --silent --max-time 3 --output /dev/null "$loopback/" &&
        curl --fail --silent --max-time 3 --output /dev/null "$tailnet/" &&
        curl --fail --silent --max-time 3 --output /dev/null "$tailnet/api/health"; then
        systemctl --user show jelly.service -p ActiveState -p FragmentPath -p UnitFileState
        echo 'Verified Jelly on loopback and private Tailscale from this host; production service has no hot reload.'
        exit 0
      fi
      sleep 2
    done
    echo 'Jelly restart requested, but HTTP/private-Tailscale readiness verification failed.' >&2
    exit 1
  fi
  sleep 5
done
echo 'Jelly remained busy for 30 minutes; no restart performed.' >&2
exit 1
