import type { ConfigStore } from "../config";
import { runPrivileged } from "./actions";
import { sshRunner } from "./collect";
import { runRemote } from "./probe";

/**
 * Service lifecycle for plain Linux hosts.
 *
 * "Install and manage a service" means three different things on these hosts:
 * an apt package that ships a systemd unit, a unit the operator writes, and a
 * docker compose project. All three are here, and every privileged step goes
 * through /usr/local/sbin/nexus-priv so a key-only login never needs a password.
 *
 * Reads run as the login user (no sudo). Mutations are gated by the tool layer
 * and audited by the registry; this module only builds validated invocations.
 */

export type ServiceAction = "start" | "stop" | "restart" | "enable" | "disable";
export type PackageAction = "install" | "remove" | "update" | "upgrade";
export type DockerAction =
  | "ps"
  | "images"
  | "pull"
  | "apply"
  | "up"
  | "down"
  | "restart"
  | "status"
  | "logs"
  | "remove"
  | "start"
  | "stop";

const UNIT_RE = /^[A-Za-z0-9@._:-]{1,120}$/;
const UNIT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const PKG_RE = /^[a-z0-9][a-z0-9+.-]{0,79}$/;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const PATH_RE = /^\/[A-Za-z0-9/._ -]{0,200}$/;

function shq(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function assertUnit(unit: string): string {
  if (!UNIT_RE.test(unit)) throw new Error(`invalid unit name: ${unit}`);
  return unit;
}

function assertUnitName(name: string): string {
  if (!UNIT_NAME_RE.test(name)) {
    throw new Error('"name" must be 1-40 characters of letters, digits, dash or underscore');
  }
  return `${name}.service`;
}

function assertPackage(name: string): string {
  if (!PKG_RE.test(name)) throw new Error(`invalid package name: ${name}`);
  return name;
}

function assertProject(name: string): string {
  if (!PROJECT_RE.test(name)) {
    throw new Error('"name" must start with a letter or digit and hold lowercase letters, digits, dash or underscore');
  }
  return name;
}

/* ------------------------------------------------------------------- reads */

function sections(stdout: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current = "";
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const marker = /^@@([a-z]+)$/.exec(line.trim());
    if (marker) {
      current = marker[1];
      out[current] = [];
      continue;
    }
    if (current && line.trim()) out[current].push(line);
  }
  return out;
}

const INVENTORY_SCRIPT = `export LC_ALL=C
echo "@@unitfiles"
systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null | head -600
echo "@@units"
systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null | head -600
echo "@@failed"
systemctl --failed --no-legend --plain --no-pager 2>/dev/null | head -40
echo "@@docker"
if command -v docker >/dev/null 2>&1; then
  docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>&1 | head -100
else
  echo "docker=absent"
fi
echo "@@projects"
ls -1d /opt/nexus/*/ 2>/dev/null | sed 's#/opt/nexus/##; s#/$##' | head -50
echo "@@end"
`;

export interface SystemdUnit {
  unit: string;
  active: string;
  sub: string;
  enabled: string;
  description: string;
}

export interface ServiceInventory {
  host: string;
  target: string;
  systemd: {
    total: number;
    running: number;
    enabled: number;
    failed: number;
    units: SystemdUnit[];
    truncated: boolean;
  };
  docker: {
    available: boolean;
    containers: { name: string; image: string; status: string; ports: string }[];
    error?: string;
  };
  composeProjects: string[];
}

export interface InventoryOptions {
  /** "running" (default), "failed" or "all". */
  state?: "running" | "failed" | "all";
  /** Case-insensitive unit/description filter. */
  filter?: string;
  limit?: number;
}

export async function listServices(
  store: ConfigStore,
  id: string,
  options: InventoryOptions = {},
): Promise<ServiceInventory> {
  const host = store.sshHost(id);
  if (!host) throw new Error(`Unknown Linux host: ${id}`);
  const summary = store.publicSshHost(host);
  const result = await runRemote(sshRunner(store, id, 30_000), INVENTORY_SCRIPT, "bash");
  if (!result.ok && !/@end/.test(result.stdout)) {
    throw new Error(`${summary.label}: ${result.stderr.trim().split(/\r?\n/).slice(-1)[0] || "inventory failed"}`);
  }
  const parts = sections(result.stdout);

  const enabled = new Map<string, string>();
  for (const line of parts.unitfiles ?? []) {
    const [unit, state] = line.trim().split(/\s+/);
    if (unit) enabled.set(unit, state ?? "unknown");
  }

  const all: SystemdUnit[] = [];
  for (const line of parts.units ?? []) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const [unit, , active, sub, ...rest] = fields;
    all.push({
      unit,
      active,
      sub,
      enabled: enabled.get(unit) ?? "unknown",
      description: rest.join(" ").slice(0, 120),
    });
  }

  const state = options.state ?? "running";
  const filter = options.filter?.trim().toLowerCase();
  const limit = Math.max(1, Math.min(600, options.limit ?? 200));
  const matched = all.filter((unit) => {
    if (state === "running" && unit.active !== "active") return false;
    if (state === "failed" && unit.sub !== "failed") return false;
    if (!filter) return true;
    return unit.unit.toLowerCase().includes(filter) || unit.description.toLowerCase().includes(filter);
  });

  const dockerLines = parts.docker ?? [];
  const dockerMissing = dockerLines.some((line) => line.includes("docker=absent"));
  const dockerDenied = dockerLines.some((line) => /permission denied|Cannot connect to the Docker daemon/.test(line));
  const containers = dockerLines
    .filter((line) => line.includes("|"))
    .map((line) => {
      const [name, image, status, ...ports] = line.split("|");
      return { name, image, status, ports: ports.join("|") };
    });

  return {
    host: summary.label,
    target: `${summary.username}@${summary.host}:${summary.port}`,
    systemd: {
      total: all.length,
      running: all.filter((unit) => unit.active === "active").length,
      enabled: all.filter((unit) => (enabled.get(unit.unit) ?? "").startsWith("enabled")).length,
      failed: (parts.failed ?? []).length,
      units: matched.slice(0, limit),
      truncated: matched.length > limit,
    },
    docker: {
      available: !dockerMissing && !dockerDenied,
      containers,
      ...(dockerDenied ? { error: "the login account cannot talk to the docker socket" } : {}),
    },
    composeProjects: parts.projects ?? [],
  };
}

export interface ServiceStatus {
  host: string;
  unit: string;
  properties: Record<string, string>;
  active: string;
  enabled: string;
  logs: string[];
  definition: string[];
}

const STATUS_SCRIPT = (unit: string) => `export LC_ALL=C
echo "@@show"
systemctl show ${shq(unit)} -p Id -p Description -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p ExecMainStartTimestamp -p MemoryCurrent -p TasksCurrent 2>&1
echo "@@logs"
journalctl -u ${shq(unit)} -n 15 --no-pager -o short-iso 2>&1 | tail -15
echo "@@definition"
systemctl cat ${shq(unit)} 2>&1 | head -40
echo "@@end"
`;

export async function serviceStatus(store: ConfigStore, id: string, rawUnit: string): Promise<ServiceStatus> {
  const unit = assertUnit(rawUnit);
  const summary = store.publicSshHost(store.sshHost(id)!);
  const result = await runRemote(sshRunner(store, id, 30_000), STATUS_SCRIPT(unit), "bash");
  const parts = sections(result.stdout);
  const properties: Record<string, string> = {};
  for (const line of parts.show ?? []) {
    const index = line.indexOf("=");
    if (index > 0) properties[line.slice(0, index)] = line.slice(index + 1);
  }
  // `systemctl show` prints before the first marker, so parse it from the head.
  if (Object.keys(properties).length === 0) {
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.trim().startsWith("@@")) break;
      const index = line.indexOf("=");
      if (index > 0) properties[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  if (!properties.ActiveState) {
    throw new Error(`${summary.label}: systemd does not know ${unit}`);
  }
  const logs = parts.logs ?? [];
  return {
    host: summary.label,
    unit,
    properties,
    active: properties.ActiveState ?? "unknown",
    enabled: properties.UnitFileState ?? "unknown",
    logs: logs.slice(-15),
    definition: (parts.definition ?? []).slice(0, 40),
  };
}

export interface ServiceLogs {
  host: string;
  unit: string;
  lines: string[];
  privileged: boolean;
}

const LOGS_SCRIPT = (unit: string, lines: number) => `export LC_ALL=C
journalctl -u ${shq(unit)} -n ${lines} --no-pager -o short-iso 2>&1 | tail -${lines}
`;

export async function serviceLogs(
  store: ConfigStore,
  id: string,
  rawUnit: string,
  requested = 80,
): Promise<ServiceLogs> {
  const unit = assertUnit(rawUnit);
  const lines = Math.max(1, Math.min(500, Math.round(requested)));
  const summary = store.publicSshHost(store.sshHost(id)!);
  const result = await runRemote(sshRunner(store, id, 30_000), LOGS_SCRIPT(unit, lines), "bash");
  const output = result.stdout.trim();
  const denied = /insufficient permissions|not see messages from other users|No journal files were found/i.test(
    `${result.stdout}\n${result.stderr}`,
  );
  if (output && !denied) {
    return { host: summary.label, unit, lines: output.split(/\r?\n/).slice(-lines), privileged: false };
  }
  // The login account may not read the system journal. The helper can, and the
  // tool stays read-only because journalctl only reads.
  const privileged = await runPrivileged(store, id, `journalctl -u ${shq(unit)} -n ${lines} --no-pager -o short-iso`, {
    helper: ["journal", unit, String(lines)],
    timeoutMs: 45_000,
  });
  if (!privileged.ok) {
    throw new Error(
      `${summary.label}: journal for ${unit} is not readable (${result.stderr.trim().slice(-120) || "no output"}). Reinstall the privileged helper to read it as root.`,
    );
  }
  return {
    host: summary.label,
    unit,
    lines: privileged.output.split(/\r?\n/).filter(Boolean).slice(-lines),
    privileged: true,
  };
}

/* --------------------------------------------------------------- mutations */

export interface ServiceControlResult {
  host: string;
  unit: string;
  action: ServiceAction;
  state: string;
  enabled: string;
  output: string;
}

export async function controlService(
  store: ConfigStore,
  id: string,
  rawUnit: string,
  action: ServiceAction,
): Promise<ServiceControlResult> {
  const unit = assertUnit(rawUnit);
  const host = store.sshHost(id)!;
  // Both routes report the same labelled result and both exit on the state the
  // action was meant to reach, so a root login and the helper agree.
  const command = [
    `systemctl ${action} ${shq(unit)} 2>&1`,
    "rc=$?",
    `state=$(systemctl is-active ${shq(unit)} 2>&1 || true)`,
    `enabled=$(systemctl is-enabled ${shq(unit)} 2>&1 || true)`,
    `printf 'unit=%s\\naction=%s\\nstate=%s\\nenabled=%s\\nsystemctl_rc=%s\\n' ${shq(unit)} ${shq(action)} "$state" "$enabled" "$rc"`,
    `case ${shq(action)} in`,
    '  start|restart) [ "$state" = active ] || exit 3 ;;',
    '  stop) [ "$state" != active ] || exit 3 ;;',
    '  enable) case "$enabled" in enabled*) ;; *) exit 3 ;; esac ;;',
    '  disable) case "$enabled" in disabled*) ;; *) exit 3 ;; esac ;;',
    "esac",
    "exit 0",
  ].join("\n");
  const outcome = await runPrivileged(store, id, command, {
    helper: ["service", action, unit],
    timeoutMs: 90_000,
  });
  const lines = outcome.output.split(/\r?\n/).map((line) => line.trim());
  const state = /(?:^|\n)state=([^\n]+)/.exec(outcome.output)?.[1] ?? lines[0] ?? "unknown";
  const enabled = /(?:^|\n)enabled=([^\n]+)/.exec(outcome.output)?.[1] ?? "unknown";
  if (!outcome.ok) {
    throw new Error(`${host.label}: systemctl ${action} ${unit} failed:\n${outcome.output.slice(-1200)}`);
  }
  return { host: host.label, unit, action, state, enabled, output: outcome.output };
}

export interface PackageResult {
  host: string;
  action: PackageAction;
  packages: string[];
  output: string;
  rebootRequired: boolean;
}

export async function packageAction(
  store: ConfigStore,
  id: string,
  action: PackageAction,
  rawPackages: string[],
  timeoutMs = 600_000,
): Promise<PackageResult> {
  const host = store.sshHost(id)!;
  const packages = rawPackages.map(assertPackage);
  if (action !== "update" && action !== "upgrade" && packages.length === 0) {
    throw new Error(`"${action}" needs at least one package name`);
  }
  const list = packages.join(" ");
  const aptFlags = "-y -o DPkg::Lock::Timeout=180 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold";
  const command =
    action === "install"
      ? `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq || true; apt-get ${aptFlags} install ${list}`
      : action === "remove"
        ? `export DEBIAN_FRONTEND=noninteractive; apt-get ${aptFlags} remove ${list}`
        : action === "update"
          ? "apt-get update"
          : `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq || true; apt-get ${aptFlags} upgrade`;
  const outcome = await runPrivileged(store, id, command, {
    helper: ["pkg", action, ...packages],
    timeoutMs,
  });
  if (!outcome.ok) {
    throw new Error(`${host.label}: apt ${action} failed:\n${outcome.output.slice(-1600)}`);
  }
  return {
    host: host.label,
    action,
    packages,
    output: outcome.output,
    rebootRequired: /reboot_required=yes/.test(outcome.output),
  };
}

export interface InstallServiceOptions {
  packages: string[];
  /** Unit to enable/start. Defaults to "<package>.service" when it exists. */
  unit?: string;
  enable?: boolean;
  start?: boolean;
}

export interface InstallServiceResult {
  host: string;
  packages: string[];
  packageOutput: string;
  unit: string | null;
  states: { action: ServiceAction; state: string; enabled: string }[];
  rebootRequired: boolean;
  note?: string;
}

async function unitExists(store: ConfigStore, id: string, unit: string): Promise<boolean> {
  const result = await runRemote(
    sshRunner(store, id, 20_000),
    `systemctl cat ${shq(unit)} >/dev/null 2>&1 && echo yes || echo no`,
    "bash",
  );
  return /yes/.test(result.stdout);
}

export async function installService(
  store: ConfigStore,
  id: string,
  options: InstallServiceOptions,
): Promise<InstallServiceResult> {
  const host = store.sshHost(id)!;
  const packages = options.packages.map(assertPackage);
  if (packages.length === 0) throw new Error('"package" is required');
  const pkg = await packageAction(store, id, "install", packages);

  const states: InstallServiceResult["states"] = [];
  let unit: string | null = null;
  if (options.unit) {
    unit = assertUnit(options.unit);
    if (!(await unitExists(store, id, unit))) {
      throw new Error(
        `${host.label}: ${packages.join(", ")} installed, but systemd has no unit named ${unit}. ` +
          "Pass the unit the package actually ships (list it with ssh.services).",
      );
    }
  } else {
    const candidate = `${packages[0]}.service`;
    unit = (await unitExists(store, id, candidate)) ? candidate : null;
  }

  let note: string | undefined;
  if (unit) {
    if (options.enable !== false) {
      const enabled = await controlService(store, id, unit, "enable");
      states.push({ action: "enable", state: enabled.state, enabled: enabled.enabled });
    }
    if (options.start !== false) {
      const started = await controlService(store, id, unit, "start");
      states.push({ action: "start", state: started.state, enabled: started.enabled });
    }
  } else {
    note = `No ${packages[0]}.service unit was found, so nothing was enabled or started. The package may be a library or use a different unit name.`;
  }

  return {
    host: host.label,
    packages,
    packageOutput: pkg.output,
    unit,
    states,
    rebootRequired: pkg.rebootRequired,
    ...(note ? { note } : {}),
  };
}

export interface ServiceSpec {
  name: string;
  exec: string;
  description?: string;
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
  after?: string;
  enable?: boolean;
  start?: boolean;
}

function renderUnit(spec: ServiceSpec): string {
  const description = (spec.description ?? `${spec.name} (managed by Nexus PVE)`).replace(/[\r\n]+/g, " ").slice(0, 200);
  const after = (spec.after ?? "network-online.target").replace(/[\r\n]+/g, " ").slice(0, 200);
  const exec = spec.exec.replace(/[\r\n]+/g, " ").trim();
  if (!exec) throw new Error('"exec" is required');
  if (exec.length > 2000) throw new Error('"exec" is too long (max 2000 characters)');
  if (/[`]/.test(exec)) throw new Error('"exec" must not contain backticks');

  const lines = ["[Unit]", `Description=${description}`, `After=${after}`, "Wants=network-online.target", "", "[Service]"];
  lines.push("Type=simple", `ExecStart=${exec}`);
  if (spec.user) {
    if (!USER_RE.test(spec.user)) throw new Error(`invalid user: ${spec.user}`);
    lines.push(`User=${spec.user}`);
  }
  if (spec.workdir) {
    if (!PATH_RE.test(spec.workdir)) throw new Error(`invalid working directory: ${spec.workdir}`);
    lines.push(`WorkingDirectory=${spec.workdir}`);
  }
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`invalid environment key: ${key}`);
    const clean = String(value).replace(/[\r\n]+/g, " ");
    if (clean.length > 1000) throw new Error(`environment value for ${key} is too long`);
    lines.push(`Environment="${key}=${clean}"`);
  }
  const restart = spec.restart ?? "on-failure";
  if (!["no", "always", "on-failure", "unless-stopped"].includes(restart)) {
    throw new Error('"restart" must be no, always, on-failure or unless-stopped');
  }
  lines.push(`Restart=${restart}`, "RestartSec=5", "", "[Install]", "WantedBy=multi-user.target", "");
  return lines.join("\n");
}

export interface CreateServiceResult {
  host: string;
  unit: string;
  path: string;
  enabled: boolean;
  state: string;
  definition: string[];
}

export async function createService(
  store: ConfigStore,
  id: string,
  spec: ServiceSpec,
): Promise<CreateServiceResult> {
  const host = store.sshHost(id)!;
  const unit = assertUnitName(spec.name);
  const body = renderUnit(spec);
  const encoded = Buffer.from(body, "utf8").toString("base64");
  const target = `/etc/systemd/system/${unit}`;
  const command = [
    "mkdir -p /etc/systemd/system",
    `{ printf '# managed by nexus-priv — written by Nexus PVE\\n'; printf %s ${shq(encoded)} | base64 -d; } > ${shq(target)}`,
    `chmod 644 ${shq(target)}`,
    "systemctl daemon-reload",
    `systemctl cat ${shq(unit)} >/dev/null`,
  ].join("\n");
  const written = await runPrivileged(store, id, command, {
    helper: ["unit", "write", unit, encoded],
    requireCurrentHelper: true,
    timeoutMs: 90_000,
  });
  if (!written.ok) {
    throw new Error(`${host.label}: could not write ${unit}:\n${written.output.slice(-1200)}`);
  }

  let enabled = false;
  let state = "inactive";
  if (spec.enable !== false) {
    const result = await controlService(store, id, unit, "enable");
    enabled = /^enabled/.test(result.enabled);
    state = result.state;
  }
  if (spec.start !== false) {
    const result = await controlService(store, id, unit, "start");
    state = result.state;
  }

  const status = await serviceStatus(store, id, unit);
  return {
    host: host.label,
    unit,
    path: target,
    enabled,
    state,
    definition: status.definition,
  };
}

export interface RemoveServiceResult {
  host: string;
  unit: string;
  removed: boolean;
  purged: string | null;
  output: string;
}

export async function removeService(
  store: ConfigStore,
  id: string,
  rawUnit: string,
  purge?: string,
): Promise<RemoveServiceResult> {
  const host = store.sshHost(id)!;
  const unit = assertUnit(rawUnit);
  const target = `/etc/systemd/system/${unit}`;
  const command = [
    `systemctl disable --now ${shq(unit)} >/dev/null 2>&1 || true`,
    `rm -f ${shq(target)}`,
    "systemctl daemon-reload",
    `systemctl reset-failed ${shq(unit)} >/dev/null 2>&1 || true`,
    `echo removed=${shq(unit)}`,
  ].join("\n");
  const outcome = await runPrivileged(store, id, command, {
    helper: ["unit", "remove", unit],
    requireCurrentHelper: true,
    timeoutMs: 90_000,
  });
  if (!outcome.ok) {
    throw new Error(`${host.label}: could not remove ${unit}:\n${outcome.output.slice(-1200)}`);
  }
  let purged: string | null = null;
  if (purge) {
    const pkg = assertPackage(purge);
    await packageAction(store, id, "remove", [pkg]);
    purged = pkg;
  }
  return { host: host.label, unit, removed: true, purged, output: outcome.output };
}

export interface DockerOptions {
  action: DockerAction;
  name?: string;
  image?: string;
  compose?: string;
  lines?: number;
}

export interface DockerResult {
  host: string;
  action: DockerAction;
  name: string | null;
  output: string;
}

export async function dockerAction(store: ConfigStore, id: string, options: DockerOptions): Promise<DockerResult> {
  const host = store.sshHost(id)!;
  const action = options.action;
  let helperArgs: string[];
  let command: string;
  let name: string | null = null;

  if (action === "apply") {
    if (!options.compose?.trim()) throw new Error('"compose" is required for action "apply"');
    name = assertProject(options.name ?? "");
    const encoded = Buffer.from(options.compose, "utf8").toString("base64");
    const file = `/opt/nexus/${name}/compose.yml`;
    helperArgs = ["compose", "apply", name, encoded];
    command = [
      `mkdir -p /opt/nexus/${name}`,
      `printf %s ${shq(encoded)} | base64 -d > ${shq(file)}`,
      `chmod 600 ${shq(file)}`,
      `docker compose -f ${shq(file)} up -d --remove-orphans`,
    ].join("\n");
  } else if (["up", "down", "restart", "status", "logs", "remove"].includes(action)) {
    name = assertProject(options.name ?? "");
    const tail = Math.max(1, Math.min(500, options.lines ?? 40));
    helperArgs = ["compose", action, name, String(tail)];
    const file = `/opt/nexus/${name}/compose.yml`;
    command =
      action === "remove"
        ? `docker compose -f ${file} down -v --remove-orphans; rm -f ${file}; rmdir /opt/nexus/${name} 2>/dev/null || true`
        : `docker compose -f ${file} ${action === "status" ? "ps" : action}${action === "logs" ? ` --tail ${tail}` : ""}`;
  } else if (action === "pull") {
    const image = options.image?.trim() ?? "";
    if (!IMAGE_RE.test(image)) throw new Error('"image" must be a valid image reference');
    helperArgs = ["docker", "pull", image];
    command = `docker pull ${shq(image)}`;
  } else if (action === "ps" || action === "images") {
    helperArgs = ["docker", action];
    command = `docker ${action}`;
  } else {
    name = assertProject(options.name ?? "");
    const sub = action === "remove" ? "rm" : action;
    helperArgs = ["docker", sub, name];
    command = `docker ${sub === "rm" ? "rm -f" : sub} ${shq(name)}`;
  }

  const outcome = await runPrivileged(store, id, command, {
    helper: helperArgs,
    requireCurrentHelper: true,
    timeoutMs: action === "apply" || action === "pull" ? 900_000 : 180_000,
  });
  if (!outcome.ok) {
    throw new Error(`${host.label}: docker ${action} failed:\n${outcome.output.slice(-1600)}`);
  }
  return { host: host.label, action, name, output: outcome.output };
}
