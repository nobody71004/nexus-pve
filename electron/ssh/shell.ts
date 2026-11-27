import type { ConfigStore, StoredSshHost } from "../config";
import type { TeamRole } from "../../shared/team-types";
import { recordAudit } from "../agent/audit";
import { runRemote, toRunner } from "./probe";

/**
 * Full machine control.
 *
 * A normal SSH session is the baseline: the caller may run any command, with
 * pipes, redirection, here-docs and multiple statements. That is deliberate —
 * the earlier exec path rejected shell metacharacters, which made installing
 * anything awkward. What keeps it safe is not a command parser on this side but
 * three boundaries:
 *
 *   1. per-role policy (this file) decides whether a caller may run arbitrary
 *      commands at all and whether it may ask the host for root;
 *   2. the transport is the existing audited SSH inventory, so a host has to be
 *      configured with a credential and a grant before any of this is reachable;
 *   3. every call is written to audit.jsonl with host, role, command, route,
 *      exit code and duration.
 *
 * Elevation is never implicit: `elevate: "none"` runs as the login account, and
 * `auto`/`sudo` use root, a live NOPASSWD grant, or the stored SSH password with
 * `sudo -S` over stdin. The password never reaches a remote argv.
 */

export type ShellRole = TeamRole | "system";
export type ShellKind = "linux" | "proxmox";
export type ShellElevation = "none" | "auto" | "sudo";
export type ShellRoute = "none" | "root" | "nopasswd" | "password";

export interface ShellPolicy {
  role: ShellRole;
  label: string;
  description: string;
  /** Arbitrary commands are allowed; false means the read-only allowlist. */
  unrestricted: boolean;
  /** Only vetted read-only commands are accepted. */
  readOnly: boolean;
  /** May ask the host for root through sudo. */
  elevate: boolean;
  maxCommandBytes: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
}

const KIB = 1024;

const POLICIES: Record<ShellRole, ShellPolicy> = {
  system: {
    role: "system",
    label: "Agent / MCP",
    description:
      "Headless MCP and automation. Full shell with elevation, the same reach as an operator SSH session.",
    unrestricted: true,
    readOnly: false,
    elevate: true,
    maxCommandBytes: 64 * KIB,
    maxTimeoutMs: 20 * 60_000,
    maxOutputBytes: 256 * KIB,
  },
  superadmin: {
    role: "superadmin",
    label: "Super admin",
    description: "Workspace owner. Full shell with elevation on every machine.",
    unrestricted: true,
    readOnly: false,
    elevate: true,
    maxCommandBytes: 64 * KIB,
    maxTimeoutMs: 20 * 60_000,
    maxOutputBytes: 256 * KIB,
  },
  admin: {
    role: "admin",
    label: "Admin",
    description: "Full shell with elevation, including service installs and unit authoring.",
    unrestricted: true,
    readOnly: false,
    elevate: true,
    maxCommandBytes: 64 * KIB,
    maxTimeoutMs: 20 * 60_000,
    maxOutputBytes: 256 * KIB,
  },
  moderator: {
    role: "moderator",
    label: "Moderator",
    description:
      "Full shell as the SSH login account. No elevation: commands may not use sudo, su, doas or pkexec.",
    unrestricted: true,
    readOnly: false,
    elevate: false,
    maxCommandBytes: 32 * KIB,
    maxTimeoutMs: 10 * 60_000,
    maxOutputBytes: 128 * KIB,
  },
  user: {
    role: "user",
    label: "Member",
    description:
      "Read-only diagnostics. Only vetted read commands (status, logs, listings) are accepted; no writes and no elevation.",
    unrestricted: false,
    readOnly: true,
    elevate: false,
    maxCommandBytes: 8 * KIB,
    maxTimeoutMs: 5 * 60_000,
    maxOutputBytes: 64 * KIB,
  },
};

const ROLE_ORDER: ShellRole[] = ["system", "superadmin", "admin", "moderator", "user"];

export function shellPolicyFor(role: ShellRole | undefined): ShellPolicy {
  return POLICIES[role ?? "system"] ?? POLICIES.user;
}

export function shellPolicyMatrix(): ShellPolicy[] {
  return ROLE_ORDER.map((role) => POLICIES[role]);
}

export function isShellRole(value: unknown): value is ShellRole {
  return typeof value === "string" && (ROLE_ORDER as string[]).includes(value);
}

/* ------------------------------------------------------- read-only allowlist */

/**
 * Commands a standard member may run. Every entry is read-only by itself and
 * cannot be turned into a write by an argument: no editors, no interpreters, no
 * `find -exec`, no `sed -i`, no `tee`, no `env <command>`.
 */
const READ_ONLY_COMMANDS = new Set([
  "apt",
  "cat",
  "cut",
  "df",
  "dig",
  "docker",
  "du",
  "echo",
  "free",
  "getent",
  "grep",
  "head",
  "hostname",
  "id",
  "ip",
  "journalctl",
  "last",
  "ls",
  "lsblk",
  "lscpu",
  "lsmod",
  "lsof",
  "mount",
  "netstat",
  "nproc",
  "nvidia-smi",
  "pct",
  "ping",
  "ps",
  "pveversion",
  "qm",
  "ss",
  "stat",
  "systemctl",
  "tail",
  "top",
  "tr",
  "uname",
  "uptime",
  "vmstat",
  "wc",
  "who",
  "whoami",
  "zfs",
  "zpool",
]);

/** Commands whose first argument decides whether the invocation is read-only. */
const READ_ONLY_SUBCOMMANDS: Record<string, RegExp> = {
  apt: /^list\b/,
  docker: /^(ps|logs|inspect|stats|images|version|info)\b/,
  ip: /^(a|addr|r|route|link)\b/,
  pct: /^(list|status|config|pending)\b/,
  qm: /^(list|status|config|pending)\b/,
  systemctl: /^(status|show|cat|list-units|list-unit-files|list-timers|is-active|is-enabled|is-failed)\b/,
  zfs: /^list\b/,
  zpool: /^(status|list)\b/,
};

export function readOnlyCommandList(): string[] {
  return [...READ_ONLY_COMMANDS].sort();
}

/* -------------------------------------------------------------- validation */

function segments(command: string): string[] {
  return command
    .split(/\|\||&&|;|\||\n/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function firstWord(segment: string): string {
  // Skip leading VAR=value assignments so `LANG=C ls` is judged as `ls`.
  const match = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*([^\s]+)/.exec(segment);
  return (match?.[1] ?? "").replace(/^["']|["']$/g, "");
}

function assertReadOnly(command: string): void {
  if (/[<>]/.test(command)) {
    throw new Error("The member role cannot use redirection or here-docs. Ask an admin for a mutating shell.");
  }
  if (/[`]/.test(command) || /\$\(/.test(command)) {
    throw new Error("The member role cannot use command substitution.");
  }
  if (/(^|[^&])&([^&]|$)/.test(command)) {
    throw new Error("The member role cannot run background jobs.");
  }
  for (const segment of segments(command)) {
    const word = firstWord(segment);
    if (!word) continue;
    if (!READ_ONLY_COMMANDS.has(word)) {
      throw new Error(
        `The member role may only run read-only commands; "${word}" is not on the allowlist. ` +
          "Ask an admin for an elevated role to install or change services.",
      );
    }
    const rule = READ_ONLY_SUBCOMMANDS[word];
    if (rule) {
      const rest = segment.slice(segment.indexOf(word) + word.length).trim();
      if (!rule.test(rest)) {
        throw new Error(`"${word}" may only be used read-only from the member role (allowed: ${rule}).`);
      }
    }
  }
}

const PRIVILEGE_WRAPPER = /(^|[|;&]\s*|\bxargs\s+|\benv\s+|\bnice\s+)(sudo|doas|pkexec|su)\b/;

export function assertShellPolicy(policy: ShellPolicy, command: string, elevation: ShellElevation): void {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("command is required");
  if (Buffer.byteLength(trimmed) > policy.maxCommandBytes) {
    throw new Error(`command is larger than the ${Math.round(policy.maxCommandBytes / KIB)} KiB limit for ${policy.label}`);
  }
  if (elevation !== "none" && !policy.elevate) {
    throw new Error(
      `The ${policy.label} role may not elevate. Run the command as the SSH login account, or ask an admin.`,
    );
  }
  if (policy.readOnly) assertReadOnly(trimmed);
  if (!policy.elevate && PRIVILEGE_WRAPPER.test(trimmed)) {
    throw new Error(
      `The ${policy.label} role may not call a privilege wrapper (sudo/su/doas/pkexec). Ask an admin for an elevated role.`,
    );
  }
}

/* ----------------------------------------------------------------- targets */

export interface ShellTarget {
  target: string;
  kind: ShellKind;
  label: string;
  hostId: string;
  endpointId?: string;
  node?: string;
}

function sshTarget(host: StoredSshHost): ShellTarget {
  return { target: `ssh:${host.id}`, kind: "linux", label: host.label, hostId: host.id };
}

function findEndpoint(store: ConfigStore, needle: string) {
  const lower = needle.trim().toLowerCase();
  return store.hosts().find((endpoint) => {
    if (endpoint.id.toLowerCase() === lower || endpoint.label.toLowerCase() === lower) return true;
    try {
      return new URL(endpoint.baseUrl).hostname.toLowerCase() === lower;
    } catch {
      return false;
    }
  });
}

/**
 * A Proxmox node is reachable only through an SSH host, because the PVE API has
 * no command channel. Match the node by name, address or the endpoint host so a
 * node already configured under Linux hosts needs no second entry.
 */
function sshHostForNode(store: ConfigStore, endpointHost: string, nodeName: string): StoredSshHost | undefined {
  const hosts = store.sshHosts();
  const needle = nodeName.trim().toLowerCase();
  const direct = hosts.find(
    (host) => host.host.toLowerCase() === needle || host.label.toLowerCase() === needle,
  );
  if (direct) return direct;
  const byEndpoint = hosts.find((host) => host.host.toLowerCase() === endpointHost);
  if (byEndpoint) return byEndpoint;
  if (hosts.length === 1 && !endpointHost) return hosts[0];
  return undefined;
}

function pveTarget(store: ConfigStore, endpointNeedle: string, nodeName: string): ShellTarget {
  const endpoint = findEndpoint(store, endpointNeedle);
  if (!endpoint) {
    throw new Error(
      `No Proxmox endpoint matches "${endpointNeedle}". Configured: ${store
        .hosts()
        .map((entry) => entry.label)
        .join(", ") || "none"}`,
    );
  }
  let endpointHost = "";
  try {
    endpointHost = new URL(endpoint.baseUrl).hostname.toLowerCase();
  } catch {
    /* a malformed stored URL is reported by the API client, not here */
  }
  const ssh = sshHostForNode(store, endpointHost, nodeName);
  if (!ssh) {
    throw new Error(
      `${endpoint.label} / ${nodeName} has no SSH transport. Add the node (or its address) under Connections → Linux hosts, ` +
        `then retry with target "pve:${endpoint.id}/${nodeName}". The Proxmox API cannot run commands.`,
    );
  }
  return {
    target: `pve:${endpoint.id}/${nodeName}`,
    kind: "proxmox",
    label: `${endpoint.label} / ${nodeName}`,
    hostId: ssh.id,
    endpointId: endpoint.id,
    node: nodeName,
  };
}

export function resolveShellTarget(store: ConfigStore, raw?: string): ShellTarget {
  const hosts = store.sshHosts();
  const requested = (raw ?? "").trim();

  if (!requested) {
    if (hosts.length === 1) return sshTarget(hosts[0]);
    if (hosts.length === 0) {
      throw new Error("No Linux hosts configured. Add one under Connections → Linux hosts first.");
    }
    throw new Error(
      `Several machines are configured; pass "target". SSH options: ${hosts
        .map((host) => `ssh:${host.id} (${host.label})`)
        .join(", ")}. Proxmox options look like pve:<endpoint>/<node>.`,
    );
  }

  if (/^ssh:/i.test(requested)) {
    const host = store.sshHost(requested.slice(4).trim());
    if (!host) throw new Error(`No Linux host matches "${requested}".`);
    return sshTarget(host);
  }

  if (/^pve:/i.test(requested)) {
    const rest = requested.slice(4).trim();
    const at = rest.lastIndexOf("/");
    if (at <= 0) throw new Error('A Proxmox target looks like "pve:<endpoint>/<node>".');
    return pveTarget(store, rest.slice(0, at), rest.slice(at + 1));
  }

  const direct = store.sshHost(requested);
  if (direct) return sshTarget(direct);

  const pair = /^([^/]+)\/([^/]+)$/.exec(requested);
  if (pair && findEndpoint(store, pair[1])) return pveTarget(store, pair[1], pair[2]);

  throw new Error(
    `No machine matches "${requested}". Use a machines.list target such as "ssh:<host-id>" or "pve:<endpoint>/<node>".`,
  );
}

/* --------------------------------------------------------------- execution */

export interface ShellRequest {
  command: string;
  role?: ShellRole;
  elevate?: ShellElevation;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  /** One-time sudo password; never persisted and never written to the audit. */
  password?: string;
  /** Audit tool name; defaults to machines.shell so exec does not double-log. */
  auditTool?: string;
}

export interface ShellResult {
  target: string;
  kind: ShellKind;
  label: string;
  host: string;
  hostId: string;
  endpoint?: string;
  node?: string;
  role: ShellRole;
  command: string;
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  route: ShellRoute;
  elevated: boolean;
  truncated: boolean;
  durationMs: number;
  error?: string;
}

const MARKER = "@@nexus";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function buildScript(request: ShellRequest): string {
  // No pipefail: a normal SSH session returns the status of the last command, so
  // `systemctl status | head` must not look like a 141 failure.
  const lines = ["umask 022"];
  if (request.cwd) {
    lines.push(`cd ${shellQuote(request.cwd)} 2>/dev/null || { printf '%s\\n' '${MARKER}:error:cwd' >&2; exit 70; }`);
  }
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`env name "${key}" is not a valid shell variable`);
    }
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  lines.push(`printf '%s\\n' '${MARKER}:begin'`);
  if (request.stdin !== undefined) {
    // Never `exec <file`: bash is reading this script from stdin, and swapping
    // fd 0 would make it read the payload as commands. Redirect the command
    // block instead, which leaves the script source untouched.
    lines.push(`STDIN_FILE=$(mktemp 2>/dev/null || echo "/tmp/nexus-stdin-$$")`);
    lines.push(`printf '%s' ${shellQuote(b64(request.stdin))} | base64 -d >"$STDIN_FILE"`);
    lines.push("trap 'rm -f \"$STDIN_FILE\"' EXIT");
    lines.push("(");
    lines.push(request.command);
    lines.push(') <"$STDIN_FILE"');
  } else {
    lines.push(request.command);
  }
  lines.push("RC=$?");
  lines.push(`printf '\\n${MARKER}:exit:%s\\n' "$RC"`);
  lines.push('exit "$RC"');
  return `${lines.join("\n")}\n`;
}

function elevatedWrapper(script: string, secret: string): string {
  return [
    "set +e",
    `PW=$(printf '%s' '${b64(secret)}' | base64 -d 2>/dev/null)`,
    `CMD=$(printf '%s' '${b64(script)}' | base64 -d 2>/dev/null)`,
    `if [ -z "$CMD" ]; then printf '%s\\n' '${MARKER}:error:payload' >&2; printf '%s\\n' '${MARKER}:rc:78'; exit 0; fi`,
    'if [ "$(id -u)" = 0 ]; then',
    "  ROUTE=root",
    '  bash -c "$CMD"',
    "  RC=$?",
    'elif [ -n "$PW" ]; then',
    "  ROUTE=password",
    '  printf "%s\\n" "$PW" | sudo -S -p "" bash -c "$CMD"',
    "  RC=$?",
    'elif sudo -n true >/dev/null 2>&1; then',
    "  ROUTE=nopasswd",
    '  sudo -n bash -c "$CMD"',
    "  RC=$?",
    "else",
    "  ROUTE=none",
    `  printf '%s\\n' '${MARKER}:error:no-root-route' >&2`,
    "  RC=77",
    "fi",
    `printf '${MARKER}:route=%s\\n' "$ROUTE"`,
    `printf '${MARKER}:rc:%s\\n' "$RC"`,
    "exit 0",
  ].join("\n") + "\n";
}

function parseMarkers(stdout: string): { code: number | null; route: ShellRoute; clean: string; noRoute: boolean } {
  const exit = new RegExp(`${MARKER}:exit:(\\d+)`).exec(stdout);
  const rc = new RegExp(`${MARKER}:rc:(\\d+)`).exec(stdout);
  const route = new RegExp(`${MARKER}:route=(root|nopasswd|password|none)`).exec(stdout)?.[1];
  const clean = stdout.replace(
    new RegExp(`\\r?${MARKER}:(?:begin|exit:\\d+|rc:\\d+|route=[a-z]+|error:[a-z-]+)\\r?\\n?`, "g"),
    "",
  );
  return {
    code: exit ? Number(exit[1]) : rc ? Number(rc[1]) : null,
    route: route === "root" || route === "nopasswd" || route === "password" || route === "none" ? route : "none",
    clean: clean.replace(/^\n/, "").replace(/\n$/, ""),
    noRoute: new RegExp(`${MARKER}:error:no-root-route`).test(stdout),
  };
}

function clip(value: string, limit: number): { value: string; truncated: boolean } {
  if (value.length <= limit) return { value, truncated: false };
  return { value: `${value.slice(0, limit)}\n…[truncated ${value.length - limit} characters]`, truncated: true };
}

export async function runShell(store: ConfigStore, target: ShellTarget, request: ShellRequest): Promise<ShellResult> {
  const policy = shellPolicyFor(request.role);
  const elevation: ShellElevation = request.elevate ?? "none";
  const command = request.command ?? "";
  assertShellPolicy(policy, command, elevation);

  const host = store.sshHost(target.hostId);
  if (!host) throw new Error(`Unknown Linux host: ${target.hostId}`);

  const timeoutMs = Math.min(policy.maxTimeoutMs, Math.max(1_000, request.timeoutMs ?? 60_000));
  const storedPassword = host.authMode === "password" ? store.sshSecretFor(host.id) : undefined;
  const sudoPassword = request.password?.trim() || undefined;

  if (request.stdin !== undefined && elevation !== "none" && !sudoPassword && storedPassword) {
    throw new Error(
      "stdin is not supported with password-based elevation: sudo consumes the pipe. Use key auth with NOPASSWD, or pass the input in the command.",
    );
  }

  const started = Date.now();
  const base = {
    target: target.target,
    kind: target.kind,
    label: target.label,
    host: host.label,
    hostId: host.id,
    role: policy.role,
    command,
    ...(target.endpointId ? { endpoint: target.endpointId } : {}),
    ...(target.node ? { node: target.node } : {}),
  };

  const record = (entry: { ok: boolean; code: number | null; route: ShellRoute; error?: string }) => {
    recordAudit({
      tool: request.auditTool ?? "machines.shell",
      category: "destructive",
      args: {
        target: target.target,
        role: policy.role,
        elevate: elevation,
        command: command.slice(0, 4_000),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.env ? { env: Object.keys(request.env) } : {}),
        ...(request.stdin !== undefined ? { stdinBytes: Buffer.byteLength(request.stdin) } : {}),
      },
      ok: entry.ok,
      host: host.label,
      role: policy.role,
      code: entry.code,
      route: entry.route,
      elevated: entry.route !== "none",
      durationMs: Date.now() - started,
      ...(entry.error ? { error: entry.error } : {}),
    });
  };

  try {
    const script = buildScript(request);
    const elevated = elevation !== "none";
    const secret = sudoPassword || storedPassword || "";
    const payload = elevated ? elevatedWrapper(script, secret) : script;
    const runner = toRunner(store.publicSshHost(host), timeoutMs, storedPassword);
    const result = await runRemote(runner, payload, "bash");
    const parsed = parseMarkers(result.stdout);
    const code = parsed.code ?? result.code;
    const stdout = clip(parsed.clean, policy.maxOutputBytes);
    const stderr = clip(result.stderr.replace(/\r?\n$/, ""), Math.min(policy.maxOutputBytes, 32 * KIB));
    const route: ShellRoute = elevated ? parsed.route : "none";
    const ok = result.ok && code === 0;
    const error = parsed.noRoute
      ? "the host offers no root route from this account: root, NOPASSWD or a stored sudo password is required"
      : !ok
        ? stderr.value.trim().split(/\r?\n/).slice(-1)[0] || `exited ${code ?? "without a code"}`
        : undefined;

    record({ ok, code, route, ...(error ? { error } : {}) });

    return {
      ...base,
      ok,
      code,
      stdout: stdout.value,
      stderr: stderr.value,
      route,
      elevated: route !== "none",
      truncated: stdout.truncated || stderr.truncated,
      durationMs: Date.now() - started,
      ...(error ? { error } : {}),
    };
  } catch (error) {
    // Validation and transport failures belong in the trail too, otherwise the
    // one command an operator most wants to review is the one that vanished.
    record({
      ok: false,
      code: null,
      route: "none",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
