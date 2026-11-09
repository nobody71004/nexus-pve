import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ConfigStore } from "../config";
import type { PraetorHostStatus, PraetorInstallResult, PraetorOverview, PraetorProfile, PraetorState, SshHostSummary } from "../../shared/types";
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

const RESOURCE_DIR = path.join("resources", "praetor");
const EGRESS_FILE = "praetor-egress.mjs";
const KEYGEN_FILE = "praetor-keygen.mjs";
const PROFILES_FILE = "praetor-profiles.mjs";
const EGRESS_UNIT = "praetor-egress.service";
const INGRESS_UNIT = "praetor-ingress.service";
const INGRESS_SCRIPT = "praetor-ingress-rule.sh";
const EGRESS_PORT = 9443;
const NODE_VERSION = "22.11.0";
const NODE_SHA = "83bf07dd343002a26211cf1fcd46a9d9534219aad42ee02847816940bf610a72";
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`;

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
NODE_URL=${shq(NODE_URL)}
NODE_SHA=${shq(NODE_SHA)}
mkdir -p "$ROOT"

for FILE in praetor-egress.mjs praetor-keygen.mjs praetor-profiles.mjs praetor-egress.service praetor-ingress.service praetor-ingress-rule.sh; do
  [ -s "$STAGE/$FILE" ] || { echo "@@fail=stage-missing-$FILE"; exit 19; }
done
install -m 0644 "$STAGE/praetor-egress.mjs" "$ROOT/praetor-egress.mjs" || { echo "@@fail=copy-egress"; exit 20; }
install -m 0644 "$STAGE/praetor-keygen.mjs" "$ROOT/praetor-keygen.mjs" || { echo "@@fail=copy-keygen"; exit 20; }
install -m 0644 "$STAGE/praetor-profiles.mjs" "$ROOT/praetor-profiles.mjs" || { echo "@@fail=copy-profiles"; exit 20; }
install -m 0644 "$STAGE/praetor-egress.service" "$ROOT/praetor-egress.service" || { echo "@@fail=copy-egress-unit"; exit 20; }
install -m 0644 "$STAGE/praetor-ingress.service" /etc/systemd/system/praetor-ingress.service || { echo "@@fail=copy-ingress-unit"; exit 20; }
install -m 0755 "$STAGE/praetor-ingress-rule.sh" /usr/local/sbin/praetor-ingress-rule.sh || { echo "@@fail=copy-ingress-rule"; exit 20; }

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
  if [ "$ARCH" != "x86_64" ]; then
    echo "@@fail=node-arch"
    echo "PRAETOR needs Node 20+ or the bundled Node 22 x64 runtime; this host reports $ARCH." >&2
    exit 31
  fi
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
/usr/local/sbin/praetor-ingress-rule.sh 2>&1 || true
systemctl restart praetor-ingress.service >/dev/null 2>&1 || true
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
else
  printf 'installed=no\n'
fi`;

interface Inspected {
  installed: boolean;
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
    return { installed: false, profiles: false, error: (stderr || stdout || "SSH probe failed").trim().slice(0, 500) };
  }
  return {
    installed: value("installed") === "yes",
    sha: value("sha") || undefined,
    active: value("active") || undefined,
    pubkey: value("pubkey") || undefined,
    node: value("node") || undefined,
    profiles: value("profiles") === "yes",
    error: ok ? value("error") || undefined : (stderr || "SSH probe failed").trim().slice(0, 500),
  };
}

async function inspectHost(store: ConfigStore, host: SshHostSummary): Promise<Inspected> {
  const password = store.sshSecretFor(host.id);
  const result = await runRemote(toRunner(host, 20_000, password), STATUS_SCRIPT, "sh");
  return parseStatus(result.stdout, result.stderr, result.ok);
}

function stateFor(inspected: Inspected, expectedSha: string): PraetorState {
  if (!inspected.installed) return "missing";
  if (inspected.sha !== expectedSha) return "outdated";
  if (inspected.active !== "active") return "error";
  return "ready";
}

function detailFor(state: PraetorState, inspected: Inspected): string {
  if (state === "ready") return "Egress active on TCP 9443";
  if (state === "outdated") return "Installed bundle differs from this Nexus build";
  if (state === "error") return inspected.error || `Service is ${inspected.active || "not active"}`;
  return inspected.error || "Not installed";
}

function hostStatus(host: SshHostSummary, inspected: Inspected, expectedSha: string, profiles: PraetorProfile[]): PraetorHostStatus {
  const state = stateFor(inspected, expectedSha);
  return {
    hostId: host.id,
    label: host.label,
    host: host.host,
    port: host.port,
    username: host.username,
    state,
    detail: detailFor(state, inspected),
    endpoint: profileEndpoint(host),
    expectedSha,
    installedSha: inspected.sha,
    nodeVersion: inspected.node,
    publicKey: inspected.pubkey,
    profilesOnHost: inspected.profiles,
    profiles,
    checkedAt: Date.now(),
    error: inspected.error,
  };
}

async function inspectWithProfiles(store: ConfigStore, host: SshHostSummary, expectedSha: string, profiles: PraetorProfile[]): Promise<PraetorHostStatus> {
  try {
    const inspected = await inspectHost(store, host);
    return hostStatus(host, inspected, expectedSha, profiles);
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
      checkedAt: Date.now(),
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
  return {
    hosts: results,
    expectedSha,
    profilesPath: profilesPath(),
    checkedAt: Date.now(),
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
      checkedAt: Date.now(),
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
      checkedAt: Date.now(),
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
