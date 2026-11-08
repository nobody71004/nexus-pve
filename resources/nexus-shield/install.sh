#!/bin/bash
# Install or upgrade Nexus Shield on the demo edge host.
#
# Run as root from a directory containing:
#   nexus-shieldd.py  nexus-shieldctl  nexus-shield.service
#   95-nexus-shield.conf  config.example.json
#
# The installer never flushes the whole ruleset. The daemon owns only
# table inet nexus_edge and table ip nexus_nat, and removes the legacy
# relay tables itself after its control API answers. If the daemon fails
# to start, the legacy tables are untouched and traffic keeps flowing.
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STAMP=$(date +%Y%m%d-%H%M%S)

if [ "$(id -u)" != "0" ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi
for file in nexus-shieldd.py nexus-shieldctl nexus-shield.service 95-nexus-shield.conf config.example.json; do
  [ -f "$SRC/$file" ] || { echo "missing $SRC/$file" >&2; exit 1; }
done

echo "=== staging ==="
install -d -m 0755 /opt/nexus-shield
install -m 0755 "$SRC/nexus-shieldd.py" /opt/nexus-shield/nexus-shieldd.py
install -m 0755 "$SRC/nexus-shieldctl" /usr/local/sbin/nexus-shieldctl
install -d -m 0755 /var/backups/nexus-shield
install -d -m 0700 /etc/nexus-shield /var/lib/nexus-shield

echo "=== config ==="
if [ ! -f /etc/nexus-shield/config.json ]; then
  TOKEN=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
  python3 - "$SRC/config.example.json" "$TOKEN" <<'PY'
import json, sys
source, token = sys.argv[1], sys.argv[2]
with open(source, "r", encoding="utf-8") as handle:
    config = json.load(handle)
config["apiToken"] = token
with open("/etc/nexus-shield/config.json", "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
PY
  chmod 0600 /etc/nexus-shield/config.json
  echo "  wrote a new config with a generated API token"
else
  echo "  keeping the existing config"
fi

echo "=== preflight ==="
if ! command -v conntrack >/dev/null 2>&1; then
  echo "  installing conntrack-tools (per-flow counters for top talkers and auto-ban)"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq conntrack
fi
python3 -m py_compile /opt/nexus-shield/nexus-shieldd.py
python3 -m py_compile /usr/local/sbin/nexus-shieldctl
nft list ruleset > "/var/backups/nexus-shield/pre-install-$STAMP.ruleset" 2>/dev/null || true
install -m 0644 "$SRC/95-nexus-shield.conf" /etc/sysctl.d/95-nexus-shield.conf
sysctl -q --system

echo "=== service ==="
install -m 0644 "$SRC/nexus-shield.service" /etc/systemd/system/nexus-shield.service
systemctl daemon-reload
systemctl enable nexus-shield >/dev/null 2>&1
systemctl restart nexus-shield

echo "=== health ==="
API_PORT=$(python3 -c 'import json; print(json.load(open("/etc/nexus-shield/config.json")).get("apiPort", 8791))')
HEALTHY=0
for _ in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 0.5
done
if [ "$HEALTHY" != "1" ]; then
  echo "nexus-shield did not become healthy; the legacy relay tables were left in place" >&2
  journalctl -u nexus-shield -n 30 --no-pager >&2 || true
  exit 1
fi

# Ask the daemon for its own view. This also proves the token path and that the
# generated ruleset is loaded, not just that the process is running.
nexus-shieldctl status > /var/lib/nexus-shield/install-status.json
python3 - <<'PY'
import json
with open("/var/lib/nexus-shield/install-status.json", "r", encoding="utf-8") as handle:
    status = json.load(handle)
if not status.get("running"):
    raise SystemExit("daemon answered but reports not running")
print(f"  mode={status['mode']} forwards={len(status['forwards'])} conntrack={status['conntrack']['count']}/{status['conntrack']['max']}")
PY

echo "=== legacy relay tables ==="
for table in "inet edge" "ip edge_nat"; do
  if nft list table $table >/dev/null 2>&1; then
    echo "  still present: $table (the daemon will remove it after its first sample)"
  else
    echo "  removed: $table"
  fi
done

echo "=== live ==="
systemctl is-active nexus-shield
nft list table inet nexus_edge >/dev/null
echo "NEXUS_SHIELD_OK"
