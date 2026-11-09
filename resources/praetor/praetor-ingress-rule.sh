#!/bin/sh
# Open TCP 9443 for the PRAETOR egress data plane. This is intentionally
# additive and idempotent: it never flushes a firewall or rewrites a policy.
set -u

PORT=9443
RULE="IN ACCEPT -p tcp -dport $PORT -comment praetor-egress"
PVE_WAIT=${PRAETOR_PVE_FW_WAIT:-10}

warn() {
  echo "praetor-ingress: $*" >&2
}

fail() {
  echo "praetor-ingress: $*" >&2
  exit 1
}

pve_host_fw() {
  if [ -n "${PRAETOR_PVE_HOST_FW:-}" ]; then
    printf '%s\n' "$PRAETOR_PVE_HOST_FW"
    return 0
  fi
  NODE=$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)
  if [ -n "$NODE" ] && [ -d "/etc/pve/nodes/$NODE" ]; then
    printf '%s\n' "/etc/pve/nodes/$NODE/host.fw"
    return 0
  fi
  if [ -d /etc/pve/local ]; then
    printf '%s\n' "/etc/pve/local/host.fw"
    return 0
  fi
  return 1
}

pve_rule_present() {
  [ -r "$1" ] || return 1
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*\|/ { next }
    /^[[:space:]]*IN[[:space:]]+ACCEPT([[:space:]]|$)/ {
      line = $0
      proto = (line ~ /(^|[[:space:]])-p[[:space:]]+tcp([[:space:]]|$)/ ||
               line ~ /(^|[[:space:]])--proto[[:space:]]+tcp([[:space:]]|$)/)
      port = (line ~ /(^|[[:space:]])(-dport|--dport)[[:space:]]+9443([[:space:]]|$)/)
      if (proto && port) { found = 1; exit }
    }
    END { exit found ? 0 : 1 }
  ' "$1"
}

pve_ensure_rule() {
  PVE_FW=$(pve_host_fw) || fail "could not locate the Proxmox host firewall configuration"
  if pve_rule_present "$PVE_FW"; then
    return 0
  fi
  if [ ! -d "$(dirname "$PVE_FW")" ]; then
    fail "the Proxmox node firewall directory is missing"
  fi
  if [ ! -e "$PVE_FW" ]; then
    (umask 027; : > "$PVE_FW") 2>/dev/null || fail "could not create $PVE_FW"
  fi
  PVE_TMP=$(mktemp "${TMPDIR:-/tmp}/praetor-hostfw.XXXXXX") || fail "could not create a temporary Proxmox firewall file"
  if ! awk -v rule="$RULE" '
    /^[[:space:]]*\[RULES\][[:space:]]*(#.*)?$/ && !inserted {
      print
      print rule
      inserted = 1
      next
    }
    { print }
    END {
      if (!inserted) {
        print "[RULES]"
        print rule
      }
    }
  ' "$PVE_FW" > "$PVE_TMP"; then
    rm -f "$PVE_TMP"
    fail "could not prepare the Proxmox host firewall rule"
  fi
  if cmp -s "$PVE_TMP" "$PVE_FW"; then
    rm -f "$PVE_TMP"
    return 0
  fi
  if ! cat "$PVE_TMP" > "$PVE_FW"; then
    rm -f "$PVE_TMP"
    fail "could not write $PVE_FW"
  fi
  rm -f "$PVE_TMP"
  if [ ! -s "$PVE_FW" ]; then
    fail "wrote an empty $PVE_FW"
  fi
  return 0
}

pve_fw_active() {
  if command -v pve-firewall >/dev/null 2>&1 && pve-firewall status 2>/dev/null | grep -qi 'enabled'; then
    return 0
  fi
  if command -v nft >/dev/null 2>&1 && nft list table inet proxmox-firewall >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

pve_fw_allows() {
  if command -v nft >/dev/null 2>&1 && nft list table inet proxmox-firewall >/dev/null 2>&1; then
    nft list table inet proxmox-firewall 2>/dev/null | grep -E '9443' | grep -Eiq 'accept'
    return $?
  fi
  if command -v pve-firewall >/dev/null 2>&1 && pve-firewall status 2>/dev/null | grep -qi 'enabled'; then
    pve-firewall compile 2>/dev/null | grep -E '^[[:space:]]*-A[[:space:]]+PVEFW-HOST-IN[[:space:]]+.*9443.*(ACCEPT|RETURN)' >/dev/null
    return $?
  fi
  return 1
}

# Proxmox owns the effective host ruleset. Add the host-level rule before any
# generic fallback, then verify that the active ruleset actually contains it.
if command -v pveversion >/dev/null 2>&1; then
  pve_ensure_rule
  if pve_fw_active; then
    PVE_ALLOW=no
    PVE_I=0
    while [ "$PVE_I" -lt "$PVE_WAIT" ]; do
      if pve_fw_allows; then
        PVE_ALLOW=yes
        break
      fi
      sleep 1
      PVE_I=$((PVE_I + 1))
    done
    if [ "$PVE_ALLOW" != yes ]; then
      fail "the Proxmox firewall is active but TCP ${PORT} is still not allowed; the host firewall rule was added but did not become effective"
    fi
  fi
fi

# Nexus Shield owns its own nft table and regenerates it from JSON. Add the one
# allowance there when shield is present, before considering generic fallbacks.
if command -v nft >/dev/null 2>&1 && nft list table inet nexus_edge >/dev/null 2>&1; then
  if ! nft list chain inet nexus_edge input 2>/dev/null | grep -q 'praetor:egress'; then
    nft insert rule inet nexus_edge input tcp dport "$PORT" accept comment '"praetor:egress"' \
      || warn "could not add the Nexus Shield allowance"
  fi
  exit 0
fi

# ufw is common on Debian/Ubuntu VPS images.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  if ! ufw status 2>/dev/null | grep -q "^${PORT}/tcp"; then
    ufw allow "${PORT}/tcp" comment 'praetor-egress' >/dev/null \
      || warn "could not add the ufw allowance"
  fi
  exit 0
fi

# firewalld is common on RHEL-family hosts.
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null | grep -q running; then
  firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null \
    && firewall-cmd --reload >/dev/null \
    || warn "could not add the firewalld allowance"
  exit 0
fi

# A standalone table is safe on hosts with no managed firewall. It does not
# override a default-drop base chain owned by another firewall; Proxmox hosts
# use the host firewall rule above instead.
if ! command -v pveversion >/dev/null 2>&1 && command -v nft >/dev/null 2>&1; then
  nft add table inet praetor_egress 2>/dev/null || true
  nft add chain inet praetor_egress input '{ type filter hook input priority 0; policy accept; }' 2>/dev/null || true
  if ! nft list chain inet praetor_egress input 2>/dev/null | grep -q 'praetor:egress'; then
    nft add rule inet praetor_egress input tcp dport "$PORT" accept comment '"praetor:egress"' \
      || warn "could not add the nftables allowance"
  fi
fi

exit 0
