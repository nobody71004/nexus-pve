import crypto from "node:crypto";
import type { RelayChain, RelayPlan, RelayPlanHop, RelayRole } from "../../shared/fabric-types";

export interface RelayKeyPair {
  privateKey: string;
  publicKey: string;
}

export const WG_INTERFACE = "nexus0";
export const RELAY_UNIT = "nexus-relay";
export const RELAY_DIR = "/etc/nexus-relay";
export const WG_DIR = "/etc/wireguard";

export function privateEndpoint(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (!value) return true;
  if (value === "localhost" || value.endsWith(".local")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [a, b] = octets;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function wgAddress(index: number): string {
  return `10.77.0.${index + 2}`;
}

export function relayRole(index: number, total: number): RelayRole {
  if (index === 0) return "entry";
  return index === total - 1 ? "exit" : "relay";
}

export function buildPlan(chain: RelayChain): RelayPlan {
  const warnings: string[] = [];
  if (chain.nodes.length < 2) warnings.push("At least an entry and an exit hop are required.");
  if (chain.nodes.length > 5) warnings.push("Chains longer than five hops add latency without a meaningful gain.");
  if (chain.mtu < 1280 || chain.mtu > 1500) warnings.push("WireGuard MTU outside 1280-1500 can break path MTU discovery.");
  if (chain.transport !== "wireguard") warnings.push("Only WireGuard transport is supported by this build.");
  if (chain.obfuscation === "tls") {
    warnings.push("TLS camouflage is opt-in and terminates at the entry hop; pin the SHA-256 fingerprint shown after deployment. Middle and exit links remain WireGuard-only.");
  }

  const hops: RelayPlanHop[] = chain.nodes.map((node, index) => {
    const role = relayRole(index, chain.nodes.length);
    const publicHost = (node.publicHost || "").trim() || node.label;
    if (privateEndpoint(publicHost)) {
      warnings.push(`${node.label}: public endpoint "${publicHost}" looks private; set the node's public IP or DNS name.`);
    }
    const address = wgAddress(index);
    const next = chain.nodes[index + 1];
    return {
      index,
      hostId: node.hostId,
      label: node.label,
      role,
      publicHost,
      wgAddress: address,
      listen: role === "entry" ? `0.0.0.0:${chain.entryPort}` : `${address}:${chain.relayPort}`,
      forwardTo: next ? `${wgAddress(index + 1)}:${chain.relayPort}` : `${chain.originHost}:${chain.originPort}`,
    };
  });

  if (hops.length > 0 && hops[0].role !== "entry") warnings.push("The first hop must be the entry.");
  if (hops.length > 0 && hops[hops.length - 1].role !== "exit") warnings.push("The last hop must be the exit.");

  return {
    chainId: chain.id,
    hops,
    origin: `${chain.originHost}:${chain.originPort}`,
    transport: chain.transport,
    encryption: "WireGuard Noise IK handshake · ChaCha20-Poly1305 data encryption",
    obfuscation:
      chain.obfuscation === "tls"
        ? "Opt-in TLS 1.2+ camouflage on the public entry. The listener uses a self-signed certificate; pin its SHA-256 fingerprint after deploy and never disable verification. This is not mTLS and does not hide packet timing."
        : "None. WireGuard is encrypted UDP, not a traffic-shape disguise.",
    warnings: [...new Set(warnings)],
  };
}

export function generateRelayKeys(): RelayKeyPair {
  const pair = crypto.generateKeyPairSync("x25519");
  const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  return { privateKey, publicKey };
}

export function buildWireGuardConfig(chain: RelayChain, index: number, keys: RelayKeyPair[], publicHosts: string[]): string {
  const self = chain.nodes[index];
  const lines = [
    "# Managed by Nexus relay fabric. Removed by its teardown.",
    "[Interface]",
    `Address = ${wgAddress(index)}/32`,
    `ListenPort = ${self.wgPort}`,
    `PrivateKey = ${keys[index].privateKey}`,
    `MTU = ${chain.mtu}`,
    "Table = off",
    `PostUp = ip route replace 10.77.0.0/24 dev ${WG_INTERFACE}`,
    `PreDown = ip route del 10.77.0.0/24 dev ${WG_INTERFACE} || true`,
  ];

  chain.nodes.forEach((node, peerIndex) => {
    if (peerIndex === index) return;
    lines.push(
      "",
      "[Peer]",
      `PublicKey = ${keys[peerIndex].publicKey}`,
      `AllowedIPs = ${wgAddress(peerIndex)}/32`,
      `Endpoint = ${publicHosts[peerIndex]}:${node.wgPort}`,
      "PersistentKeepalive = 25",
    );
  });

  return `${lines.join("\n")}\n`;
}

export function buildHaproxyConfig(chain: RelayChain, index: number): string {
  const hop = buildPlan(chain).hops[index];
  const next = chain.nodes[index + 1];
  const target = next ? `${wgAddress(index + 1)}:${chain.relayPort}` : `${chain.originHost}:${chain.originPort}`;
  const tlsEntry = index === 0 && chain.obfuscation === "tls";
  const lines = [
    "global",
    "  log stdout format raw local0",
    "  maxconn 60000",
    "  nbthread 2",
    ...(tlsEntry ? ["  ssl-default-bind-options ssl-min-ver TLSv1.2 no-tls-tickets", "  ssl-default-bind-ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305"] : []),
    "",
    "defaults",
    "  log global",
    "  mode tcp",
    "  option tcplog",
    "  option dontlognull",
    "  timeout connect 5s",
    "  timeout client 1h",
    "  timeout server 1h",
    "",
    "frontend relay_in",
    tlsEntry ? `  bind ${hop.listen} ssl crt ${RELAY_DIR}/tls/server.pem` : `  bind ${hop.listen}`,
    "  maxconn 50000",
  ];
  if (index === 0) {
    lines.push(
      "  # Per-source flood ceilings run before a TCP session reaches the chain.",
      "  stick-table type ip size 200k expire 30s store conn_rate(10s),conn_cur",
      "  tcp-request connection track-sc0 src",
      "  tcp-request connection reject if { sc_conn_rate(0) gt 300 }",
      "  tcp-request connection reject if { sc_conn_cur(0) gt 100 }",
    );
  }
  lines.push("  default_backend next_hop", "", "backend next_hop", `  server hop ${target} check inter 5s fall 3 rise 2`);
  return lines.join("\n") + "\n";
}

export function buildRelayUnit(): string {
  return [
    "# Managed by Nexus relay fabric. Removed by its teardown.",
    "[Unit]",
    "Description=Nexus Relay Fabric hop",
    "Wants=network-online.target wg-quick@nexus0.service",
    "After=network-online.target wg-quick@nexus0.service",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=/usr/sbin/haproxy -Ws -f ${RELAY_DIR}/haproxy.cfg`,
    "ExecReload=/bin/kill -USR2 $MAINPID",
    "Restart=always",
    "RestartSec=3",
    "LimitNOFILE=1048576",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n") + "\n";
}

function heredoc(name: string, path: string, content: string, mode: string): string {
  return `cat > ${path} <<'${name}'\n${content.replace(/\r\n/g, "\n").replace(/\s+$/, "")}\n${name}\nchmod ${mode} ${path}`;
}

export function buildInstallScript(chain: RelayChain, index: number, keys: RelayKeyPair[], publicHosts: string[]): string {
  const wg = buildWireGuardConfig(chain, index, keys, publicHosts);
  const haproxy = buildHaproxyConfig(chain, index);
  const unit = buildRelayUnit();
  const tlsEntry = index === 0 && chain.obfuscation === "tls";
  const certificateHost = (publicHosts[index] || chain.nodes[index].label || "nexus-relay").replace(/[^a-zA-Z0-9.:-]/g, "") || "nexus-relay";
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "if systemctl is-active --quiet haproxy.service 2>/dev/null; then",
    "  echo 'nexus relay: haproxy.service is already active; refusing to disturb the existing proxy (stop it deliberately, then retry)' >&2",
    "  exit 21",
    "fi",
    "if [ -f /etc/wireguard/nexus0.conf ] && ! grep -q '^# Managed by Nexus relay fabric' /etc/wireguard/nexus0.conf; then",
    "  echo 'nexus relay: /etc/wireguard/nexus0.conf exists but is not managed by Nexus; refusing to overwrite it' >&2",
    "  exit 22",
    "fi",
    "if [ -f /etc/systemd/system/nexus-relay.service ] && ! grep -q '^# Managed by Nexus relay fabric' /etc/systemd/system/nexus-relay.service; then",
    "  echo 'nexus relay: nexus-relay.service exists but is not managed by Nexus; refusing to overwrite it' >&2",
    "  exit 22",
    "fi",
    `if ! command -v wg >/dev/null 2>&1 || [ ! -x /usr/sbin/haproxy ] || { [ "${tlsEntry}" = "true" ] && ! command -v openssl >/dev/null 2>&1; }; then`,
    "  if command -v apt-get >/dev/null 2>&1; then",
    "    apt-get update -qq",
    "    apt-get install -y -qq wireguard-tools haproxy openssl",
    "    systemctl disable --now haproxy.service >/dev/null 2>&1 || true",
    "  else",
    "    echo 'nexus relay: this host needs wireguard-tools and haproxy (apt-based install supported)' >&2",
    "    exit 20",
    "  fi",
    "fi",
    `install -d -m 0700 ${RELAY_DIR}`,
    ...(tlsEntry
      ? [
          `install -d -m 0700 ${RELAY_DIR}/tls`,
          `if [ ! -s ${RELAY_DIR}/tls/server.pem ]; then`,
          `  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 -subj "/CN=${certificateHost}" -keyout ${RELAY_DIR}/tls/server.key -out ${RELAY_DIR}/tls/server.crt >/dev/null 2>&1`,
          `  cat ${RELAY_DIR}/tls/server.crt ${RELAY_DIR}/tls/server.key > ${RELAY_DIR}/tls/server.pem`,
          `  chmod 600 ${RELAY_DIR}/tls/server.key ${RELAY_DIR}/tls/server.pem ${RELAY_DIR}/tls/server.crt`,
          "fi",
        ]
      : []),
    heredoc("NEXUS_WG_EOF", `${WG_DIR}/${WG_INTERFACE}.conf`, wg, "600"),
    heredoc("NEXUS_HAPROXY_EOF", `${RELAY_DIR}/haproxy.cfg`, haproxy, "600"),
    heredoc("NEXUS_UNIT_EOF", `/etc/systemd/system/${RELAY_UNIT}.service`, unit, "644"),
    "/usr/sbin/haproxy -c -f /etc/nexus-relay/haproxy.cfg",
    "systemctl daemon-reload",
    `systemctl enable wg-quick@${WG_INTERFACE} >/dev/null`,
    `systemctl restart wg-quick@${WG_INTERFACE}`,
    `systemctl enable ${RELAY_UNIT} >/dev/null`,
    `systemctl restart ${RELAY_UNIT}`,
    "sleep 1",
    `systemctl is-active --quiet wg-quick@${WG_INTERFACE}`,
    `systemctl is-active --quiet ${RELAY_UNIT}`,
    ...(tlsEntry
      ? [
          `if ! openssl s_client -connect 127.0.0.1:${chain.entryPort} -servername ${certificateHost} -CAfile ${RELAY_DIR}/tls/server.crt -verify_return_error </dev/null >/dev/null 2>&1; then`,
          "  echo 'nexus relay: TLS health check failed' >&2",
          "  exit 24",
          "fi",
          `echo "NEXUS_TLS_OK fingerprint=$(openssl x509 -in ${RELAY_DIR}/tls/server.crt -noout -fingerprint -sha256 | sed 's/^.*=//')"`,
        ]
      : []),
    `echo "NEXUS_RELAY_OK hop=${index} role=${relayRole(index, chain.nodes.length)} listen=${buildPlan(chain).hops[index].listen} forward=${buildPlan(chain).hops[index].forwardTo}"`,
  ].join("\n") + "\n";
}

export function buildTeardownScript(): string {
  return [
    "set +e",
    `systemctl disable --now ${RELAY_UNIT} >/dev/null 2>&1`,
    `systemctl disable --now wg-quick@${WG_INTERFACE} >/dev/null 2>&1`,
    `rm -f /etc/systemd/system/${RELAY_UNIT}.service ${RELAY_DIR}/haproxy.cfg ${WG_DIR}/${WG_INTERFACE}.conf`,
    `rm -rf ${RELAY_DIR}/tls`,
    `rmdir ${RELAY_DIR} >/dev/null 2>&1`,
    "systemctl daemon-reload",
    "ACTIVE=0",
    `systemctl is-active --quiet ${RELAY_UNIT} && ACTIVE=1`,
    `systemctl is-active --quiet wg-quick@${WG_INTERFACE} && ACTIVE=1`,
    `[ -f /etc/systemd/system/${RELAY_UNIT}.service ] && ACTIVE=1`,
    `[ -f ${WG_DIR}/${WG_INTERFACE}.conf ] && ACTIVE=1`,
    "if [ \"$ACTIVE\" -eq 0 ]; then",
    "  echo NEXUS_RELAY_REMOVED",
    "  exit 0",
    "fi",
    "echo 'nexus relay: teardown incomplete; service, interface or managed config is still present' >&2",
    "exit 1",
  ].join("\n") + "\n";
}
