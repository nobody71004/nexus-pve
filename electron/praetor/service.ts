import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ConfigStore } from "../config";
import type {
  PraetorHealth,
  PraetorHostStatus,
  PraetorInstallResult,
  PraetorOverview,
  PraetorProfile,
  PraetorRotateResult,
  PraetorState,
  SshHostSummary,
} from "../../shared/types";
import { runElevated } from "../ssh/helper";
import { runRemote, toRunner } from "../ssh/probe";
import {
  buildProfiles,
  profileEndpoint,
  profilesPath,
  readHostProfiles,
  readProfilesForHosts,
  saveHostProfiles,
} from "./profiles";
import { historyPath, recordChecks } from "./history";

const RESOURCE_DIR = path.join("resources", "praetor");
const EGRESS_FILE = "praetor-egress.mjs";
const KEYGEN_FILE = "praetor-keygen.mjs";
const PROFILES_FILE = "praetor-profiles.mjs";
const EGRESS_UNIT = "praetor-egress.service";
const INGRESS_UNIT = "praetor-ingress.service";
const INGRESS_SCRIPT = "praetor-ingress-rule.sh";
const ROTATE_SCRIPT = "praetor-rotate-key.sh";
const EGRESS_PORT = 9443;
const TCP_PROBE_TIMEOUT_MS = 2_500;
const TCP_READY_TIMEOUT_MS = 15_000;
const TCP_READY_POLL_MS = 400;
const NODE_VERSION = "22.11.0";
const NODE_DIST = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux`;
const NODE_X64_SHA = "83bf07dd343002a26211cf1fcd46a9d9534219aad42ee02847816940bf610a72";
const NODE_ARM64_SHA = "6031d04b98f59ff0f7cb98566f65b115ecd893d3b7870821171708cdbaf7ae6e";

let configuredRoot: string | undefined;

export function setPraetorAppRoot(root: string): void {
  configuredRoot = path.resolve(root);
}

function appRoot(): string {
  return configuredRoot ?? process.cwd();
}

function resourcePath(name: string): string {
  return path.join(appRoot(), RESOURCE_DIR, name);
}

function readResource(name: string): Buffer {
  try {
    return fs.readFileSync(resourcePath(name));
  } catch {
    throw new Error(`bundled PRAETOR resource is missing: resources/praetor/${name}`);
  }
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function expectedBundleSha(): string {
  return sha256(readResource(EGRESS_FILE));
}

function b64(value: Buffer | string): string {
  const encoded = Buffer.from(value).toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\n") ?? "";
}

function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function writeResource(name: string, target: string, mode: string): string {
  return `base64 -d > ${target} <<'PRAETOR_${name.replace(/[^A-Za-z0-9]/g, "_")}_EOF'
${b64(readResource(name))}
PRAETOR_${name.replace(/[^A-Za-z0-9]/g, "_")}_EOF
chmod ${mode} ${target} || { echo "@@fail=write-${name}"; exit 20; }`;
}

function storedProfiles(hostId: string): PraetorProfile[] {
  try {
    return readHostProfiles(hostId);
  } catch {
    return [];
  }
}

export function buildStageScript(): string {
  return `set -eu
STAGE=$(mktemp -d /tmp/nexus-praetor.XXXXXX)
chmod 0700 "$STAGE"
${writeResource(EGRESS_FILE, "$STAGE/praetor-egress.mjs", "0644")}
${writeResource(KEYGEN_FILE, "$STAGE/praetor-keygen.mjs", "0644")}
${writeResource(PROFILES_FILE, "$STAGE/praetor-profiles.mjs", "0644")}
${writeResource(EGRESS_UNIT, "$STAGE/praetor-egress.service", "0644")}
${writeResource(INGRESS_UNIT, "$STAGE/praetor-ingress.service", "0644")}
${writeResource(INGRESS_SCRIPT, "$STAGE/praetor-ingress-rule.sh", "0755")}
${writeResource(ROTATE_SCRIPT, "$STAGE/praetor-rotate-key.sh", "0755")}
printf '@@stage=%s\n' "$STAGE"`;
}

export function buildInstallScript(stage: string, host: SshHostSummary): string {
  const pubHost = host.host.trim();
  const unit = readResource(EGRESS_UNIT).toString("utf8");
  return String.raw`set -u
ROOT=/opt/praetor-egress
STAGE=${shq(stage)}
PUBLIC_HOST=${shq(pubHost)}
HOST_ID=${shq(host.id)}
LABEL=${shq(host.label)}
NODE_DIST=${shq(NODE_DIST)}
NODE_X64_SHA=${shq(NODE_X64_SHA)}
NODE_ARM64_SHA=${shq(NODE_ARM64_SHA)}
mkdir -p "$ROOT"

for FILE in praetor-egress.mjs praetor-keygen.mjs praetor-profiles.mjs praetor-egress.service praetor-ingress.service praetor-ingress-rule.sh praetor-rotate-key.sh; do
  [ -s "$STAGE/$FILE" ] || { echo "@@fail=stage-missing-$FILE"; exit 19; }
done
install -m 0644 "$STAGE/praetor-egress.mjs" "$ROOT/praetor-egress.mjs" || { echo "@@fail=copy-egress"; exit 20; }
install -m 0644 "$STAGE/praetor-keygen.mjs" "$ROOT/praetor-keygen.mjs" || { echo "@@fail=copy-keygen"; exit 20; }
install -m 0644 "$STAGE/praetor-profiles.mjs" "$ROOT/praetor-profiles.mjs" || { echo "@@fail=copy-profiles"; exit 20; }
install -m 0644 "$STAGE/praetor-egress.service" "$ROOT/praetor-egress.service" || { echo "@@fail=copy-egress-unit"; exit 20; }
install -m 0644 "$STAGE/praetor-ingress.service" /etc/systemd/system/praetor-ingress.service || { echo "@@fail=copy-ingress-unit"; exit 20; }
install -m 0755 "$STAGE/praetor-ingress-rule.sh" /usr/local/sbin/praetor-ingress-rule.sh || { echo "@@fail=copy-ingress-rule"; exit 20; }
install -m 0755 "$STAGE/praetor-rotate-key.sh" "$ROOT/praetor-rotate-key.sh" || { echo "@@fail=copy-rotate"; exit 20; }

NODE=""
if [ -x "$ROOT/node/bin/node" ]; then
  NODE="$ROOT/node/bin/node"
else
  CANDIDATE=$(command -v node 2>/dev/null || true)
  if [ -n "$CANDIDATE" ] && "$CANDIDATE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
    NODE="$CANDIDATE"
  fi
fi

if [ -z "$NODE" ]; then
  ARCH=$(uname -m 2>/dev/null || true)
  case "$ARCH" in
    x86_64|amd64) NODE_ARCH=x64; NODE_SHA="$NODE_X64_SHA" ;;
    aarch64|arm64) NODE_ARCH=arm64; NODE_SHA="$NODE_ARM64_SHA" ;;
    *)
      echo "@@fail=node-arch"
      echo "PRAETOR needs Node 20+ or the bundled Node 22 runtime for x64 or arm64; this host reports $ARCH." >&2
      exit 31
      ;;
  esac
  NODE_URL="$NODE_DIST-$NODE_ARCH.tar.xz"
  rm -rf "$ROOT/node"
  mkdir -p "$ROOT/node"
  TMP=$(mktemp)
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$NODE_URL" -o "$TMP" || { rm -f "$TMP"; echo "@@fail=node-download"; exit 32; }
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP" "$NODE_URL" || { rm -f "$TMP"; echo "@@fail=node-download"; exit 32; }
  else
    rm -f "$TMP"
    echo "@@fail=node-download-tool"
    echo "PRAETOR needs curl or wget to install its private Node 22 runtime." >&2
    exit 32
  fi
  echo "$NODE_SHA  $TMP" | sha256sum -c - >/dev/null 2>&1 || {
    rm -f "$TMP"
    echo "@@fail=node-checksum"
    echo "Node runtime checksum did not match." >&2
    exit 33
  }
  tar -xJf "$TMP" --strip-components=1 -C "$ROOT/node" || { rm -f "$TMP"; echo "@@fail=node-extract"; exit 34; }
  rm -f "$TMP"
  NODE="$ROOT/node/bin/node"
fi

if [ ! -x "$NODE" ]; then
  echo "@@fail=node-missing"
  exit 35
fi
echo "@@node=$NODE"

# Keep an existing keypair across updates. The public key is the profile anchor;
# if either half is missing, regenerate the pair rather than guessing.
if [ ! -s "$ROOT/server.key" ] || [ ! -s "$ROOT/server.pub" ]; then
  rm -f "$ROOT/server.key" "$ROOT/server.pub"
  "$NODE" "$ROOT/praetor-keygen.mjs" "$ROOT/server.key" "$ROOT/server.pub" >/dev/null || {
    echo "@@fail=keygen"
    exit 36
  }
fi
chmod 0600 "$ROOT/server.key"
chmod 0644 "$ROOT/server.pub"
PUB=$(tr -d '\r\n' < "$ROOT/server.pub")
if [ -z "$PUB" ]; then
  echo "@@fail=empty-public-key"
  exit 37
fi

"$NODE" "$ROOT/praetor-profiles.mjs" --key-file "$ROOT/server.pub" --host "$PUBLIC_HOST" --label "$LABEL" --id "$HOST_ID" --port ${EGRESS_PORT} --out "$ROOT/profiles.json" >/dev/null || {
  echo "@@fail=profiles"
  exit 38
}

if command -v ss >/dev/null 2>&1 && ss -lnt 2>/dev/null | grep -q '[:.]${EGRESS_PORT} '; then
  if ! systemctl is-active --quiet praetor-egress.service 2>/dev/null; then
    echo "@@fail=port-in-use"
    echo "TCP ${EGRESS_PORT} is already owned by another service." >&2
    exit 39
  fi
fi

printf '%s' ${shq(unit)} | sed "s|@NODE@|$NODE|g" > /etc/systemd/system/praetor-egress.service
systemctl daemon-reload || true
systemctl enable praetor-ingress.service praetor-egress.service >/dev/null 2>&1 || true
if ! /usr/local/sbin/praetor-ingress-rule.sh 2>&1; then
  echo "@@fail=ingress-firewall"
  echo "PRAETOR could not add or validate the TCP ${EGRESS_PORT} firewall allowance." >&2
  exit 41
fi
if ! systemctl restart praetor-ingress.service >/dev/null 2>&1; then
  echo "@@fail=ingress-service"
  systemctl status --no-pager -l praetor-ingress.service 2>&1 | tail -25
  exit 42
fi
systemctl restart praetor-egress.service >/dev/null 2>&1 || true

i=0
while [ "$i" -lt 15 ]; do
  if systemctl is-active --quiet praetor-egress.service 2>/dev/null; then
    break
  fi
  sleep 1
  i=$((i + 1))
done
if ! systemctl is-active --quiet praetor-egress.service 2>/dev/null; then
  echo "@@fail=service"
  systemctl status --no-pager -l praetor-egress.service 2>&1 | tail -25
  exit 40
fi

rm -rf "$STAGE" 2>/dev/null || true
echo "@@endpoint=$PUBLIC_HOST:${EGRESS_PORT}"
echo "@@pubkey=$PUB"
echo "@@profiles=4"
echo "@@done"`;
}

export function buildRotateScript(stage: string, host: SshHostSummary): string {
  return String.raw`set -u
ROOT=/opt/praetor-egress
STAGE=${shq(stage)}
PUBLIC_HOST=${shq(host.host.trim())}
HOST_ID=${shq(host.id)}
LABEL=${shq(host.label)}

[ -s "$STAGE/praetor-rotate-key.sh" ] || { echo "@@fail=stage-missing-rotate"; exit 19; }
[ -s "$ROOT/praetor-egress.mjs" ] || {
  echo "@@fail=not-installed"
  echo "PRAETOR is not installed on this host." >&2
  exit 21
}
install -m 0755 "$STAGE/praetor-rotate-key.sh" "$ROOT/praetor-rotate-key.sh" || { echo "@@fail=copy-rotate"; exit 20; }

sh "$ROOT/praetor-rotate-key.sh" "$ROOT" "$PUBLIC_HOST" "$HOST_ID" "$LABEL" ${EGRESS_PORT}`;
}

interface StageResult {
  ok: boolean;
  stage?: string;
  output: string;
  latencyMs: number;
  error?: string;
}

async function stagePayload(store: ConfigStore, host: SshHostSummary): Promise<StageResult> {
  const password = host.authMode === "password" ? store.sshSecretFor(host.id) : undefined;
  try {
    const result = await runRemote(toRunner(store.publicSshHost(host), 90_000, password), buildStageScript(), "sh");
    const stage = /^@@stage=(\/tmp\/nexus-praetor\.[A-Za-z0-9]+)$/m.exec(result.stdout)?.[1];
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (!result.ok || !stage) {
      return {
        ok: false,
        output,
        latencyMs: result.latencyMs,
        error: output.slice(-500) || "Could not stage the PRAETOR payload over SSH.",
      };
    }
    return { ok: true, stage, output, latencyMs: result.latencyMs };
  } catch (err) {
    return {
      ok: false,
      output: "",
      latencyMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function cleanupStage(store: ConfigStore, host: SshHostSummary, stage: string): Promise<void> {
  const password = host.authMode === "password" ? store.sshSecretFor(host.id) : undefined;
  const script = `case ${shq(stage)} in /tmp/nexus-praetor.*) rm -rf ${shq(stage)} ;; esac`;
  try {
    await runRemote(toRunner(store.publicSshHost(host), 20_000, password), script, "sh");
  } catch {
    // A stale /tmp directory is preferable to turning a completed install into a failure.
  }
}

const STATUS_SCRIPT = String.raw`set +e
ROOT=/opt/praetor-egress
if [ -f "$ROOT/praetor-egress.mjs" ]; then
  printf 'installed=yes\n'
  printf 'sha=%s\n' "$(sha256sum "$ROOT/praetor-egress.mjs" 2>/dev/null | awk '{print $1}')"
  printf 'active=%s\n' "$(systemctl is-active praetor-egress.service 2>/dev/null | head -1)"
  printf 'pubkey=%s\n' "$(tr -d '\r\n' < "$ROOT/server.pub" 2>/dev/null)"
  printf 'node=%s\n' "$("$ROOT/node/bin/node" -v 2>/dev/null || node -v 2>/dev/null)"
  printf 'profiles=%s\n' "$([ -s "$ROOT/profiles.json" ] && printf yes || printf no)"
  if command -v ss >/dev/null 2>&1; then
    LISTENERS=$(ss -lntH 2>/dev/null | awk '$4 ~ /:9443$/ {print $4}')
    printf 'listen_count=%s\n' "$(printf '%s\n' "$LISTENERS" | awk 'NF {n++} END {print n+0}')"
    printf 'listen_bind=%s\n' "$(printf '%s\n' "$LISTENERS" | awk 'NF {print; exit}')"
  else
    printf 'listen_count=unknown\n'
  fi
  if command -v pveversion >/dev/null 2>&1; then
    printf 'pve=yes\n'
    PVE_FW_STATUS_RAW=$(pve-firewall status 2>/dev/null)
    PVE_FW_STATUS=$(printf '%s\n' "$PVE_FW_STATUS_RAW" | head -1)
    LEGACY_ACTIVE=no
    LEGACY_KNOWN=no
    case "$PVE_FW_STATUS" in
      *enabled*) LEGACY_ACTIVE=yes; LEGACY_KNOWN=yes ;;
      *disabled*) LEGACY_KNOWN=yes ;;
    esac
    NEW_ACTIVE=no
    NEW_KNOWN=no
    NFT_LIST=
    if command -v nft >/dev/null 2>&1; then
      NFT_LIST=$(nft list table inet proxmox-firewall 2>/dev/null)
      NFT_RC=$?
      if [ "$NFT_RC" = 0 ]; then
        NEW_KNOWN=yes
        if [ -n "$NFT_LIST" ]; then NEW_ACTIVE=yes; fi
      else
        NFT_ERROR=$(nft list table inet proxmox-firewall 2>&1 >/dev/null)
        case "$NFT_ERROR" in
          *"No such file"*|*"does not exist"*) NEW_KNOWN=yes ;;
        esac
      fi
    else
      NEW_KNOWN=yes
    fi
    ACTIVE=no
    if [ "$LEGACY_ACTIVE" = yes ] || [ "$NEW_ACTIVE" = yes ]; then ACTIVE=yes;
    elif [ "$LEGACY_KNOWN" = no ] || [ "$NEW_KNOWN" = no ]; then ACTIVE=unknown;
    fi
    if [ "$NEW_ACTIVE" = yes ] && [ "$LEGACY_ACTIVE" = no ]; then PVE_FW_STATUS="active (proxmox-firewall)"; fi
    printf 'pvefw_status=%s\n' "$PVE_FW_STATUS"
    printf 'pvefw_active=%s\n' "$ACTIVE"
    POLICY=
    for FW in /etc/pve/firewall/cluster.fw "/etc/pve/nodes/$(hostname)/host.fw"; do
      [ -r "$FW" ] || continue
      VALUE=$(grep -E '^[[:space:]]*policy_in[[:space:]]*:' "$FW" 2>/dev/null | tail -1 | sed 's/^[^:]*:[[:space:]]*//; s/[[:space:]]*$//' | tr '[:lower:]' '[:upper:]')
      [ -n "$VALUE" ] && POLICY="$VALUE"
    done
    printf 'pvefw_policy=%s\n' "$POLICY"
    ALLOW=unknown
    if [ "$NEW_ACTIVE" = yes ]; then
      NEW_RULES=$NFT_LIST
      if [ -n "$NEW_RULES" ]; then
        if printf '%s\n' "$NEW_RULES" | grep -E '9443' | grep -Eiq 'accept'; then ALLOW=yes; else ALLOW=no; fi
      fi
    fi
    if [ "$LEGACY_ACTIVE" = yes ]; then
      COMPILED=$(pve-firewall compile 2>/dev/null)
      case "$COMPILED" in
        *PVEFW-HOST-IN*)
          if printf '%s\n' "$COMPILED" | grep -E '9443' | grep -Eiq 'ACCEPT|RETURN'; then ALLOW=yes;
          elif [ "$ALLOW" = unknown ]; then ALLOW=no;
          fi
          ;;
      esac
      if [ "$ALLOW" = unknown ] && command -v iptables-save >/dev/null 2>&1; then
        SAVED=$(iptables-save 2>/dev/null)
        case "$SAVED" in
          *PVEFW-HOST-IN*)
            if printf '%s\n' "$SAVED" | grep -E '9443' | grep -Eiq 'ACCEPT|RETURN'; then ALLOW=yes; else ALLOW=no; fi
            ;;
        esac
      fi
    fi
    if [ "$ACTIVE" = no ]; then ALLOW=no; fi
    READABLE=no
    if [ "$ACTIVE" = no ]; then READABLE=yes;
    elif [ "$ACTIVE" = yes ] && [ "$ALLOW" != unknown ]; then READABLE=yes;
    fi
    printf 'pvefw_allow=%s\n' "$ALLOW"
    printf 'pvefw_readable=%s\n' "$READABLE"
  else
    printf 'pve=no\n'
    printf 'pvefw_active=no\n'
    printf 'pvefw_allow=unknown\n'
    printf 'pvefw_readable=yes\n'
  fi
else
  printf 'installed=no\n'
fi`;

const FIREWALL_STATUS_SCRIPT = String.raw`set +e
SUDO_STATE=available
if [ "$(id -u)" = 0 ]; then
  SUDO_STATE=root
elif ! command -v sudo >/dev/null 2>&1; then
  SUDO_STATE=missing
fi
if [ "$SUDO_STATE" = missing ]; then
  printf 'pvefw_status=\n'
  printf 'pvefw_active=unknown\n'
  printf 'pvefw_policy=\n'
  printf 'pvefw_allow=unknown\n'
  printf 'pvefw_readable=no\n'
  printf 'pvefw_sudo=missing\n'
  exit 0
fi
run_root() {
  if [ "$SUDO_STATE" = root ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}
PVE_FW_STATUS_RAW=$(run_root pve-firewall status 2>/dev/null)
PVE_FW_STATUS=$(printf '%s\n' "$PVE_FW_STATUS_RAW" | head -1)
LEGACY_ACTIVE=no
LEGACY_KNOWN=no
case "$PVE_FW_STATUS" in
  *enabled*) LEGACY_ACTIVE=yes; LEGACY_KNOWN=yes ;;
  *disabled*) LEGACY_KNOWN=yes ;;
esac
NEW_ACTIVE=no
NEW_KNOWN=no
NEW_RULES=
if command -v nft >/dev/null 2>&1; then
  NEW_RULES=$(run_root nft list table inet proxmox-firewall 2>/dev/null)
  NEW_RC=$?
  if [ "$NEW_RC" = 0 ]; then
    NEW_KNOWN=yes
    if [ -n "$NEW_RULES" ]; then NEW_ACTIVE=yes; fi
  else
    NEW_ERROR=$(run_root nft list table inet proxmox-firewall 2>&1 >/dev/null)
    case "$NEW_ERROR" in
      *"No such file"*|*"does not exist"*) NEW_KNOWN=yes ;;
    esac
  fi
else
  NEW_KNOWN=yes
fi
ACTIVE=no
if [ "$LEGACY_ACTIVE" = yes ] || [ "$NEW_ACTIVE" = yes ]; then ACTIVE=yes;
elif [ "$LEGACY_KNOWN" = no ] || [ "$NEW_KNOWN" = no ]; then ACTIVE=unknown;
fi
if [ "$NEW_ACTIVE" = yes ] && [ "$LEGACY_ACTIVE" = no ]; then PVE_FW_STATUS="active (proxmox-firewall)"; fi
POLICY=
for FW in /etc/pve/firewall/cluster.fw "/etc/pve/nodes/$(hostname)/host.fw"; do
  CONTENT=$(run_root cat "$FW" 2>/dev/null)
  [ -n "$CONTENT" ] || continue
  VALUE=$(printf '%s\n' "$CONTENT" | grep -E '^[[:space:]]*policy_in[[:space:]]*:' 2>/dev/null | tail -1 | sed 's/^[^:]*:[[:space:]]*//; s/[[:space:]]*$//' | tr '[:lower:]' '[:upper:]')
  [ -n "$VALUE" ] && POLICY="$VALUE"
done
ALLOW=unknown
if [ "$NEW_ACTIVE" = yes ]; then
  if [ -n "$NEW_RULES" ]; then
    if printf '%s\n' "$NEW_RULES" | grep -E '9443' | grep -Eiq 'accept'; then ALLOW=yes; else ALLOW=no; fi
  fi
fi
if [ "$LEGACY_ACTIVE" = yes ]; then
  COMPILED=$(run_root pve-firewall compile 2>/dev/null)
  case "$COMPILED" in
    *PVEFW-HOST-IN*)
      if printf '%s\n' "$COMPILED" | grep -E '9443' | grep -Eiq 'ACCEPT|RETURN'; then ALLOW=yes;
      elif [ "$ALLOW" = unknown ]; then ALLOW=no;
      fi
      ;;
  esac
  if [ "$ALLOW" = unknown ] && command -v iptables-save >/dev/null 2>&1; then
    SAVED=$(run_root iptables-save 2>/dev/null)
    case "$SAVED" in
      *PVEFW-HOST-IN*)
        if printf '%s\n' "$SAVED" | grep -E '9443' | grep -Eiq 'ACCEPT|RETURN'; then ALLOW=yes; else ALLOW=no; fi
        ;;
    esac
  fi
fi
if [ "$ACTIVE" = no ]; then ALLOW=no; fi
READABLE=no
if [ "$ACTIVE" = no ]; then READABLE=yes;
elif [ "$ACTIVE" = yes ] && [ "$ALLOW" != unknown ]; then READABLE=yes;
fi
if [ "$READABLE" = no ] && [ "$SUDO_STATE" = available ]; then SUDO_STATE=denied; fi
printf 'pvefw_status=%s\n' "$PVE_FW_STATUS"
printf 'pvefw_active=%s\n' "$ACTIVE"
printf 'pvefw_policy=%s\n' "$POLICY"
printf 'pvefw_allow=%s\n' "$ALLOW"
printf 'pvefw_readable=%s\n' "$READABLE"
printf 'pvefw_sudo=%s\n' "$SUDO_STATE"
`;

export interface PraetorNetworkEvidence {
  installed: boolean;
  listenCount?: number | null;
  bindAddress?: string;
  pve?: boolean;
  pveFirewallStatus?: string;
  pveFirewallActive?: boolean;
  pveFirewallAllow?: boolean | null;
  pveFirewallReadable?: boolean;
  pveFirewallSudo?: "root" | "available" | "denied" | "missing";
  pveFirewallPolicy?: string;
}

interface Inspected extends PraetorNetworkEvidence {
  sha?: string;
  active?: string;
  pubkey?: string;
  node?: string;
  profiles: boolean;
  error?: string;
}

function parseStatus(stdout: string, stderr: string, ok: boolean): Inspected {
  const value = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(stdout)?.[1]?.trim();
  if (!ok && value("installed") !== "yes") {
    return {
      installed: false,
      profiles: false,
      listenCount: null,
      pve: false,
      error: (stderr || stdout || "SSH probe failed").trim().slice(0, 500),
    };
  }
  const count = value("listen_count");
  const allow = value("pvefw_allow");
  const active = value("pvefw_active");
  const readable = value("pvefw_readable");
  const sudo = value("pvefw_sudo");
  const sudoState =
    sudo === "root" || sudo === "available" || sudo === "denied" || sudo === "missing" ? sudo : undefined;
  return {
    installed: value("installed") === "yes",
    sha: value("sha") || undefined,
    active: value("active") || undefined,
    pubkey: value("pubkey") || undefined,
    node: value("node") || undefined,
    profiles: value("profiles") === "yes",
    listenCount: count === "unknown" ? null : count !== undefined && count !== "" && Number.isFinite(Number(count)) ? Number(count) : undefined,
    bindAddress: value("listen_bind") || undefined,
    pve: value("pve") === "yes",
    pveFirewallStatus: value("pvefw_status") || undefined,
    pveFirewallActive: active === "yes" ? true : active === "no" ? false : undefined,
    pveFirewallAllow: allow === "yes" ? true : allow === "no" ? false : null,
    pveFirewallReadable: readable === "yes" ? true : readable === "no" ? false : undefined,
    pveFirewallSudo: sudoState,
    pveFirewallPolicy: value("pvefw_policy") || undefined,
    error: ok ? value("error") || undefined : (stderr || "SSH probe failed").trim().slice(0, 500),
  };
}

function mergeFirewallEvidence(base: Inspected, elevated: Inspected): Inspected {
  if (elevated.pveFirewallReadable !== true) {
    return { ...base, pveFirewallReadable: false, pveFirewallSudo: elevated.pveFirewallSudo };
  }
  return {
    ...base,
    pveFirewallStatus: elevated.pveFirewallStatus || base.pveFirewallStatus,
    pveFirewallActive: elevated.pveFirewallActive ?? base.pveFirewallActive,
    pveFirewallAllow: elevated.pveFirewallAllow ?? base.pveFirewallAllow,
    pveFirewallPolicy: elevated.pveFirewallPolicy || base.pveFirewallPolicy,
    pveFirewallReadable: true,
    pveFirewallSudo: elevated.pveFirewallSudo,
  };
}

async function inspectHost(store: ConfigStore, host: SshHostSummary): Promise<Inspected> {
  const password = store.sshSecretFor(host.id);
  const result = await runRemote(toRunner(host, 20_000, password), STATUS_SCRIPT, "sh");
  const inspected = parseStatus(result.stdout, result.stderr, result.ok);
  if (inspected.pve !== true || inspected.pveFirewallReadable === true) return inspected;
  try {
    const elevated = await runRemote(toRunner(host, 20_000, password), FIREWALL_STATUS_SCRIPT, "sh");
    return mergeFirewallEvidence(inspected, parseStatus(elevated.stdout, elevated.stderr, elevated.ok));
  } catch {
    return { ...inspected, pveFirewallReadable: false };
  }
}

export interface TcpProbe {
  reachable: boolean;
  latencyMs: number;
  error?: string;
  kind?: "timeout" | "refused" | "error";
}

interface NetworkAssessment {
  tcpReachable: boolean;
  tcpLatencyMs?: number;
  tcpError?: string;
  portListening: boolean | null;
  bindAddress?: string;
  firewallBlocked: boolean;
  firewallActive: boolean;
  firewallAllow: boolean | null;
  firewallDetail: string;
}

function tcpHost(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

function probeTcp(host: string, port = EGRESS_PORT, timeoutMs = TCP_PROBE_TIMEOUT_MS): Promise<TcpProbe> {
  const target = tcpHost(host);
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host: target, port });
    let settled = false;
    const finish = (result: Omit<TcpProbe, "latencyMs">) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, latencyMs: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ reachable: true }));
    socket.once("timeout", () =>
      finish({
        reachable: false,
        kind: "timeout",
        error: `TCP ${target}:${port} timed out after ${timeoutMs} ms`,
      }),
    );
    socket.once("error", (err: NodeJS.ErrnoException) => {
      const kind = err.code === "ECONNREFUSED" ? "refused" : err.code === "ETIMEDOUT" ? "timeout" : "error";
      finish({ reachable: false, kind, error: `TCP ${target}:${port} failed: ${err.code || err.message}` });
    });
  });
}

function isLoopbackBind(value: string | undefined): boolean {
  if (!value) return false;
  return /^(127\.|\[::1\]|::1|localhost)/i.test(value);
}

function firewallEvidence(inspected: PraetorNetworkEvidence): string {
  if (inspected.pve !== true) return "Not a Proxmox host";
  if (inspected.pveFirewallActive === undefined) {
    return "Proxmox firewall state could not be read; passwordless sudo may be required";
  }
  if (inspected.pveFirewallActive !== true) return "Proxmox firewall is not active";
  const status = inspected.pveFirewallStatus?.replace(/^Status:\s*/i, "") || "active";
  const policy = inspected.pveFirewallPolicy ? `, policy_in ${inspected.pveFirewallPolicy}` : "";
  if (inspected.pveFirewallAllow === true) return `Proxmox firewall ${status}${policy}; TCP 9443 is allowed`;
  if (inspected.pveFirewallAllow === false) return `Proxmox firewall ${status}${policy}; no TCP 9443 allow rule was found`;
  const hint =
    inspected.pveFirewallSudo === "denied"
      ? " (passwordless sudo was denied)"
      : inspected.pveFirewallSudo === "missing"
        ? " (sudo is not installed)"
        : inspected.pveFirewallReadable === false
          ? " (passwordless sudo may be required)"
          : "";
  return `Proxmox firewall ${status}${policy}; the TCP 9443 rule state could not be read${hint}`;
}

export function classifyNetwork(inspected: PraetorNetworkEvidence, tcp: TcpProbe | undefined): NetworkAssessment {
  const portListening = inspected.listenCount === undefined || inspected.listenCount === null ? null : inspected.listenCount > 0;
  const bindAddress = inspected.bindAddress;
  const loopbackBind = isLoopbackBind(bindAddress);
  const firewallActive = inspected.pve === true && inspected.pveFirewallActive === true;
  const firewallAllow = inspected.pveFirewallAllow ?? null;
  const policy = (inspected.pveFirewallPolicy || "").toUpperCase();
  const policyMayBlock = policy !== "ACCEPT";
  const tcpFailed = tcp !== undefined && !tcp.reachable;
  const firewallBlocked =
    tcpFailed &&
    portListening !== false &&
    !loopbackBind &&
    firewallActive &&
    firewallAllow === false &&
    policyMayBlock &&
    (tcp?.kind === "timeout" || tcp?.kind === "refused");

  let tcpError: string | undefined;
  if (tcp && !tcp.reachable) {
    if (portListening === false) tcpError = "TCP 9443 is not listening on this host";
    else if (loopbackBind) tcpError = `TCP 9443 is bound only to ${bindAddress}; it is not reachable externally`;
    else tcpError = tcp.error;
  }

  return {
    tcpReachable: tcp?.reachable ?? false,
    tcpLatencyMs: tcp?.latencyMs,
    tcpError,
    portListening,
    bindAddress,
    firewallBlocked,
    firewallActive,
    firewallAllow,
    firewallDetail: firewallEvidence(inspected),
  };
}

async function assessNetwork(host: SshHostSummary, inspected: Inspected): Promise<NetworkAssessment> {
  const tcp = inspected.installed ? await probeTcp(host.host) : undefined;
  return classifyNetwork(inspected, tcp);
}

async function waitForEgress(host: SshHostSummary): Promise<TcpProbe> {
  const started = Date.now();
  let probe = await probeTcp(host.host);
  while (!probe.reachable && Date.now() - started < TCP_READY_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, TCP_READY_POLL_MS));
    probe = await probeTcp(host.host);
  }
  return probe;
}

function stateFor(inspected: Inspected, expectedSha: string, network: NetworkAssessment): PraetorState {
  if (!inspected.installed) return "missing";
  if (network.firewallBlocked) return "error";
  if (inspected.sha !== expectedSha) return "outdated";
  if (inspected.active !== "active") return "error";
  if (!network.tcpReachable) return "error";
  return "ready";
}

function detailFor(state: PraetorState, inspected: Inspected, network: NetworkAssessment): string {
  if (state === "ready") return "Egress active and TCP 9443 reachable from this workstation";
  if (state === "outdated") return "Installed bundle differs from this Nexus build";
  if (state === "error") {
    if (network.firewallBlocked) return `TCP 9443 blocked by the Proxmox firewall — ${network.firewallDetail}`;
    return network.tcpError || inspected.error || `Service is ${inspected.active || "not active"}`;
  }
  return inspected.error || "Not installed";
}

async function hostStatus(host: SshHostSummary, inspected: Inspected, expectedSha: string, profiles: PraetorProfile[]): Promise<PraetorHostStatus> {
  const network = await assessNetwork(host, inspected);
  const state = stateFor(inspected, expectedSha, network);
  return {
    hostId: host.id,
    label: host.label,
    host: host.host,
    port: host.port,
    username: host.username,
    state,
    detail: detailFor(state, inspected, network),
    endpoint: profileEndpoint(host),
    expectedSha,
    installedSha: inspected.sha,
    nodeVersion: inspected.node,
    publicKey: inspected.pubkey,
    profilesOnHost: inspected.profiles,
    profiles,
    ...network,
    checkedAt: Date.now(),
    history: [],
    error: state === "ready" ? undefined : network.firewallBlocked ? `TCP 9443 blocked by the Proxmox firewall: ${network.firewallDetail}` : network.tcpError || inspected.error,
  };
}

async function inspectWithProfiles(store: ConfigStore, host: SshHostSummary, expectedSha: string, profiles: PraetorProfile[]): Promise<PraetorHostStatus> {
  try {
    const inspected = await inspectHost(store, host);
    return await hostStatus(host, inspected, expectedSha, profiles);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      hostId: host.id,
      label: host.label,
      host: host.host,
      port: host.port,
      username: host.username,
      state: "error" as const,
      detail: message,
      endpoint: profileEndpoint(host),
      expectedSha,
      profilesOnHost: false,
      profiles,
      tcpReachable: false,
      portListening: null,
      firewallBlocked: false,
      firewallActive: false,
      firewallAllow: null,
      firewallDetail: "PRAETOR status unavailable",
      checkedAt: Date.now(),
      history: [],
      error: message,
    };
  }
}

export async function overview(store: ConfigStore): Promise<PraetorOverview> {
  const expectedSha = expectedBundleSha();
  const hosts = store.sshHosts();
  const ids = hosts.map((host) => host.id);
  let stored: Record<string, PraetorProfile[]> = {};
  try {
    stored = readProfilesForHosts(ids);
  } catch {
    stored = {};
  }
  const results = await Promise.all(hosts.map((host) => inspectWithProfiles(store, host, expectedSha, stored[host.id] ?? [])));
  const history = recordChecks(results);
  return {
    hosts: results.map((host) => ({ ...host, history: history[host.hostId] ?? [] })),
    expectedSha,
    profilesPath: profilesPath(),
    historyPath: historyPath(),
    checkedAt: Date.now(),
  };
}

/** One targeted probe for a single host, recorded in the shared check history. */
export async function hostHealth(store: ConfigStore, hostRef: string): Promise<PraetorHealth> {
  const key = hostRef.trim().toLowerCase();
  const host = store.sshHosts().find((entry) => entry.id === hostRef || entry.label.toLowerCase() === key);
  if (!host) throw new Error(`Unknown Linux host: ${hostRef}`);
  const expectedSha = expectedBundleSha();
  const status = await inspectWithProfiles(store, host, expectedSha, storedProfiles(host.id));
  const history = recordChecks([status]);
  return {
    hostId: status.hostId,
    label: status.label,
    endpoint: status.endpoint,
    state: status.state,
    detail: status.detail,
    tcpReachable: status.tcpReachable,
    tcpLatencyMs: status.tcpLatencyMs,
    tcpError: status.tcpError,
    firewallBlocked: status.firewallBlocked,
    checkedAt: status.checkedAt,
    history: history[status.hostId] ?? [],
  };
}

export async function install(store: ConfigStore, hostId: string): Promise<PraetorInstallResult> {
  const host = store.sshHost(hostId);
  if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
  const expectedSha = expectedBundleSha();
  let before: PraetorHostStatus;
  try {
    before = await inspectWithProfiles(store, host, expectedSha, storedProfiles(host.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    before = {
      hostId: host.id,
      label: host.label,
      host: host.host,
      port: host.port,
      username: host.username,
      state: "error",
      detail: message,
      endpoint: profileEndpoint(host),
      expectedSha,
      profilesOnHost: false,
      profiles: [],
      tcpReachable: false,
      portListening: null,
      firewallBlocked: false,
      firewallActive: false,
      firewallAllow: null,
      firewallDetail: "PRAETOR status unavailable",
      checkedAt: Date.now(),
      history: [],
      error: message,
    };
  }
  if (
    before.state === "ready" &&
    before.profilesOnHost &&
    before.profiles.length > 0 &&
    before.publicKey === before.profiles[0]?.serverPublicKey
  ) {
    return {
      hostId: host.id,
      label: host.label,
      ok: true,
      state: "ready",
      route: "none",
      endpoint: profileEndpoint(host),
      publicKey: before.publicKey,
      profiles: before.profiles,
      output: "PRAETOR egress already installed and current; profiles are ready.",
      latencyMs: 0,
    };
  }

  const staged = await stagePayload(store, host);
  if (!staged.ok || !staged.stage) {
    return {
      hostId: host.id,
      label: host.label,
      ok: false,
      state: before.state === "ready" ? "error" : before.state,
      route: "none",
      endpoint: profileEndpoint(host),
      profiles: before.profiles,
      output: staged.output,
      latencyMs: staged.latencyMs,
      error: staged.error || "Could not stage the PRAETOR payload over SSH.",
    };
  }

  let result: Awaited<ReturnType<typeof runElevated>>;
  try {
    result = await runElevated(store, host, buildInstallScript(staged.stage, host), undefined, { timeoutMs: 300_000 });
  } catch (err) {
    await cleanupStage(store, host, staged.stage);
    const message = err instanceof Error ? err.message : String(err);
    return {
      hostId: host.id,
      label: host.label,
      ok: false,
      state: "error",
      route: "none",
      endpoint: profileEndpoint(host),
      profiles: before.profiles,
      output: staged.output,
      latencyMs: staged.latencyMs,
      error: message,
    };
  }
  await cleanupStage(store, host, staged.stage);

  const pubkey = /@@pubkey=([A-Za-z0-9+/=]+)/.exec(result.output)?.[1];
  const endpoint = /@@endpoint=([^\s]+)/.exec(result.output)?.[1] ?? profileEndpoint(host);
  if (!result.ok || !pubkey) {
    const afterFailure = await inspectWithProfiles(store, host, expectedSha, storedProfiles(host.id)).catch(() => null);
    return {
      hostId: host.id,
      label: host.label,
      ok: false,
      state: afterFailure?.state ?? "error",
      route: result.route,
      endpoint,
      profiles: afterFailure?.profiles ?? [],
      output: result.output,
      latencyMs: staged.latencyMs + result.latencyMs,
      error: result.ok ? "Installer did not return the host public key." : (afterFailure?.error || result.output.slice(-500) || "PRAETOR install failed."),
    };
  }

  let profiles: PraetorProfile[] = [];
  let warning: string | undefined;
  try {
    profiles = buildProfiles(host, pubkey, storedProfiles(host.id));
    saveHostProfiles(host, profiles);
  } catch (err) {
    warning = `Egress installed, but Nexus could not save profiles: ${err instanceof Error ? err.message : String(err)}`;
  }

  await waitForEgress(host);
  const after = await inspectWithProfiles(store, host, expectedSha, profiles).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    return {
      hostId: host.id,
      label: host.label,
      host: host.host,
      port: host.port,
      username: host.username,
      state: "error" as const,
      detail: message,
      endpoint: profileEndpoint(host),
      expectedSha,
      profilesOnHost: false,
      profiles,
      tcpReachable: false,
      portListening: null,
      firewallBlocked: false,
      firewallActive: false,
      firewallAllow: null,
      firewallDetail: "PRAETOR status unavailable",
      checkedAt: Date.now(),
      history: [],
      error: message,
    };
  });
  const ok = result.ok && after.state === "ready";
  return {
    hostId: host.id,
    label: host.label,
    ok,
    state: after.state,
    route: result.route,
    endpoint,
    publicKey: pubkey,
    profiles,
    output: result.output,
    latencyMs: staged.latencyMs + result.latencyMs,
    warning,
    error: ok ? undefined : after.error || after.detail,
  };
}

export async function rotate(store: ConfigStore, hostId: string): Promise<PraetorRotateResult> {
  const host = store.sshHost(hostId);
  if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
  const expectedSha = expectedBundleSha();
  const before = await inspectWithProfiles(store, host, expectedSha, storedProfiles(host.id));
  const endpoint = profileEndpoint(host);

  if (before.state === "missing" && !before.installedSha) {
    return {
      hostId: host.id,
      label: host.label,
      ok: false,
      state: "missing",
      route: "none",
      endpoint,
      oldPublicKey: before.publicKey,
      profiles: before.profiles,
      output: "",
      latencyMs: 0,
      error: "PRAETOR is not installed on this host; install it before rotating the key.",
    };
  }

  const staged = await stagePayload(store, host);
  if (!staged.ok || !staged.stage) {
    return {
      hostId: host.id,
      label: host.label,
      ok: false,
      state: before.state === "ready" ? "error" : before.state,
      route: "none",
      endpoint,
      oldPublicKey: before.publicKey,
      profiles: before.profiles,
      output: staged.output,
      latencyMs: staged.latencyMs,
      error: staged.error || "Could not stage the PRAETOR rotation payload over SSH.",
    };
  }

  let result: Awaited<ReturnType<typeof runElevated>>;
  try {
    result = await runElevated(store, host, buildRotateScript(staged.stage, host), undefined, { timeoutMs: 300_000 });
  } catch (err) {
    await cleanupStage(store, host, staged.stage);
    const message = err instanceof Error ? err.message : String(err);
    return {
      hostId: host.id,
      label: host.label,
      ok: false,
      state: "error",
      route: "none",
      endpoint,
      oldPublicKey: before.publicKey,
      profiles: before.profiles,
      output: staged.output,
      latencyMs: staged.latencyMs,
      error: message,
    };
  }
  await cleanupStage(store, host, staged.stage);

  const oldPublicKey = /@@oldpubkey=([A-Za-z0-9+/=]+)/.exec(result.output)?.[1] ?? before.publicKey;
  const pubkey = /@@pubkey=([A-Za-z0-9+/=]+)/.exec(result.output)?.[1];
  if (!result.ok || !pubkey) {
    const afterFailure = await inspectWithProfiles(store, host, expectedSha, storedProfiles(host.id)).catch(() => null);
    return {
      hostId: host.id,
      label: host.label,
      ok: false,
      state: afterFailure?.state ?? "error",
      route: result.route,
      endpoint,
      publicKey: afterFailure?.publicKey ?? before.publicKey,
      oldPublicKey,
      profiles: afterFailure?.profiles ?? before.profiles,
      output: result.output,
      latencyMs: staged.latencyMs + result.latencyMs,
      error: result.ok
        ? "Rotation did not return the host public key."
        : afterFailure?.error || result.output.slice(-500) || "PRAETOR key rotation failed.",
    };
  }

  let profiles: PraetorProfile[] = [];
  let warning: string | undefined;
  try {
    profiles = buildProfiles(host, pubkey, storedProfiles(host.id));
    saveHostProfiles(host, profiles);
  } catch (err) {
    warning = `Key rotated on the host, but Nexus could not save the new profiles: ${err instanceof Error ? err.message : String(err)}`;
  }

  await waitForEgress(host);
  const after = await inspectWithProfiles(store, host, expectedSha, profiles).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    return {
      hostId: host.id,
      label: host.label,
      host: host.host,
      port: host.port,
      username: host.username,
      state: "error" as const,
      detail: message,
      endpoint,
      expectedSha,
      profilesOnHost: false,
      publicKey: undefined,
      profiles,
      tcpReachable: false,
      portListening: null,
      firewallBlocked: false,
      firewallActive: false,
      firewallAllow: null,
      firewallDetail: "PRAETOR status unavailable",
      checkedAt: Date.now(),
      history: [],
      error: message,
    };
  });
  const keyMatches = after.publicKey === pubkey;
  const ok = result.ok && after.state === "ready" && keyMatches;
  return {
    hostId: host.id,
    label: host.label,
    ok,
    state: after.state,
    route: result.route,
    endpoint,
    publicKey: pubkey,
    oldPublicKey,
    profiles,
    output: result.output,
    latencyMs: staged.latencyMs + result.latencyMs,
    warning: warning ?? (keyMatches ? undefined : "The host did not report the rotated public key after restart."),
    error: ok
      ? undefined
      : keyMatches
        ? after.error || after.detail
        : `The host public key after rotation did not match the new key (reported ${after.publicKey ? `${after.publicKey.slice(0, 16)}…` : "none"}).`,
  };
}
