#!/bin/sh
# Open TCP 9443 for the PRAETOR egress data plane. This is intentionally
# additive and idempotent: it never flushes a firewall or rewrites a policy.
set -u

PORT=9443
warn() {
  echo "praetor-ingress: $*" >&2
}

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
# override a default-drop base chain owned by another firewall, so warn when
# Proxmox's firewall is active.
if command -v nft >/dev/null 2>&1; then
  nft add table inet praetor_egress 2>/dev/null || true
  nft add chain inet praetor_egress input '{ type filter hook input priority 0; policy accept; }' 2>/dev/null || true
  if ! nft list chain inet praetor_egress input 2>/dev/null | grep -q 'praetor:egress'; then
    nft add rule inet praetor_egress input tcp dport "$PORT" accept comment '"praetor:egress"' \
      || warn "could not add the nftables allowance"
  fi
fi

if command -v pve-firewall >/dev/null 2>&1 && pve-firewall status 2>/dev/null | grep -qi 'enabled'; then
  warn "the Proxmox firewall is enabled; allow tcp/${PORT} in the host firewall policy if clients cannot connect"
fi

exit 0
