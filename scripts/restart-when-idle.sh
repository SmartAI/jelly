#!/bin/bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

valid_restart_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}

# Nonsecret, canonical private origin from the connected local Tailscale node.
# Status JSON stays in memory, never in command arguments or printed diagnostics.
private_tailnet_origin() {
  valid_restart_port "$1" || return 1
  /usr/bin/python3 -c '
import ipaddress, json, re, subprocess, sys
try:
    result = subprocess.run(["tailscale", "status", "--json"], check=True,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3)
    status = json.loads(result.stdout)
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

# Read only nonsecret settings from Jelly's installed system LaunchDaemon.
# Refuse a different checkout: its idle database cannot guard this service.
macos_restart_defaults() {
  /usr/bin/python3 - "$1" "$repo" <<'PY'
import pathlib, plistlib, sys
try:
    with open(sys.argv[1], 'rb') as source:
        service = plistlib.load(source)
    working = pathlib.Path(service['WorkingDirectory']).resolve()
    if service.get('Label') != 'com.jelly.server' or working != pathlib.Path(sys.argv[2]).resolve():
        raise ValueError('service belongs to a different checkout')
    env = service.get('EnvironmentVariables', {})
    data = pathlib.Path(env.get('JELLY_DATA_DIR', '.jelly'))
    if not data.is_absolute():
        data = working / data
    data = str(data.resolve())
    port = str(env.get('JELLY_PORT', '5173'))
    if '\n' in data or '\r' in data or '\n' in port or '\r' in port:
        raise ValueError('invalid settings')
    print(port)
    print(data)
except Exception:
    print('Cannot read Jelly settings from its system LaunchDaemon for this checkout.', file=sys.stderr)
    sys.exit(1)
PY
}

active_restart_runs() {
  /usr/bin/python3 - "$1/jelly.sqlite" <<'PY'
import pathlib, sqlite3, sys
uri = pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro'
with sqlite3.connect(uri, uri=True) as db:
    print(db.execute("SELECT count(*) FROM runs WHERE status='running'").fetchone()[0])
PY
}

restart_service() {
  case "$1" in
    Darwin)
      if [ "$(id -u)" = 0 ]; then
        launchctl kickstart -k system/com.jelly.server
      else
        sudo -n launchctl kickstart -k system/com.jelly.server
      fi
      ;;
    Linux)
      # Finish the one-time migration from the old transient dev service.
      if systemctl --user is-active --quiet jelly-dev.service; then
        systemctl --user stop jelly-dev.service || return 1
      fi
      systemctl --user daemon-reload || return 1
      systemctl --user reload-or-restart jelly.service
      ;;
  esac
}

restart_service_active() {
  case "$1" in
    Darwin)
      launchctl print system/com.jelly.server | awk '
        !seen && $1 == "state" && $2 == "=" { running = $3 == "running"; seen = 1 }
        END { exit !running }
      '
      ;;
    Linux) systemctl --user is-active --quiet jelly.service ;;
  esac
}

restart_main() {
  local platform settings default_port=5173 default_data="$repo/.jelly"
  local port data_dir loopback active tailnet attempt check
  platform=$(uname -s)
  case "$platform" in
    Darwin)
      settings=$(macos_restart_defaults /Library/LaunchDaemons/com.jelly.server.plist) || return 1
      IFS= read -r default_port <<< "$settings"
      default_data=${settings#*$'\n'}
      # This helper must run outside Jelly's job; system services need root to restart.
      if ! launchctl print system/com.jelly.server > /dev/null; then
        echo 'Jelly system LaunchDaemon is not loaded; no restart performed.' >&2
        return 1
      fi
      ;;
    Linux) ;;
    *) echo "Unsupported restart platform: $platform" >&2; return 1 ;;
  esac
  port=${JELLY_RESTART_PORT:-$default_port}
  data_dir=${JELLY_DATA_DIR:-$default_data}
  if ! valid_restart_port "$port"; then
    echo 'JELLY_RESTART_PORT must be an integer from 1 to 65535.' >&2
    return 1
  fi
  port=$((10#$port))
  loopback="http://127.0.0.1:$port"

  # Run from a separate terminal/launchd job or systemd user unit, outside Jelly.
  for attempt in {1..360}; do
    # The hold owner removes its hold only after all delegated work and checks finish.
    if compgen -G "$repo/.jelly/restart-holds/*" > /dev/null ||
      compgen -G "$data_dir/restart-holds/*" > /dev/null; then
      sleep 5
      continue
    fi
    active=$(active_restart_runs "$data_dir") || return 1
    if [ "$active" = 0 ]; then
      if ! restart_service "$platform"; then
        echo 'Jelly service restart failed.' >&2
        if [ "$platform" = Darwin ]; then
          echo 'Run the helper from a separate terminal with sudo or permit its launchctl command via noninteractive sudo.' >&2
        fi
        return 1
      fi
      for check in {1..30}; do
        if tailnet=$(private_tailnet_origin "$port") &&
          restart_service_active "$platform" &&
          curl --fail --silent --max-time 3 --output /dev/null "$loopback/" &&
          curl --fail --silent --max-time 3 --output /dev/null "$loopback/api/health" &&
          curl --fail --silent --max-time 3 --output /dev/null "$tailnet/" &&
          curl --fail --silent --max-time 3 --output /dev/null "$tailnet/api/health"; then
          if [ "$platform" = Linux ]; then
            systemctl --user show jelly.service -p ActiveState -p FragmentPath -p UnitFileState
          else
            echo 'Verified launchd service system/com.jelly.server.'
          fi
          echo 'Verified Jelly on loopback and private Tailscale from this host; production service has no hot reload.'
          return 0
        fi
        sleep 2
      done
      echo 'Jelly restart requested, but HTTP/private-Tailscale readiness verification failed.' >&2
      return 1
    fi
    sleep 5
  done
  echo 'Jelly remained busy for 30 minutes; no restart performed.' >&2
  return 1
}

# Sourcing defines functions only; tests use a copied helper and fake service commands.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  restart_main
fi
