import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ConfigStore, StoredSshHost } from "../config";
import type { HelperInstallResult, HelperRoute, HelperState, HelperStatus } from "../../shared/types";
import { runRemote, toRunner } from "./probe";

/**
 * Privileged helper onboarding.
 *
 * Every privileged host action goes through /usr/local/sbin/nexus-priv, which is
 * only useful if the login account may run it through sudo without a password.
 * Doing that by hand is the one step that keeps a fresh host read-only, so this
 * module inspects the host, reports exactly what is missing, and installs both
 * halves in one shot.
 *
 * The install runs as root through whichever route the host offers:
 *   root      — the SSH account already is root
 *   nopasswd  — a live NOPASSWD grant is already in place
 *   password  — the stored SSH password, or one typed in the panel for this
 *               install only
 * Either password is piped to `sudo -S` over stdin, never argv. When no route
 * exists the result is `blocked` plus copy-paste bootstrap commands rather than
 * a silent failure.
 */

export const HELPER_PATH = "/usr/local/sbin/nexus-priv";
export const SUDOERS_PATH = "/etc/sudoers.d/nexus-actions";

export type HelperInstallTrigger = "manual" | "auto";

/** One completed or refused helper install, for the guardian's audit journal. */
export interface HelperInstallAudit {
  hostId: string;
  hostLabel: string;
  trigger: HelperInstallTrigger;
  route: HelperRoute;
  beforeState: HelperState;
  afterState: HelperState;
  ok: boolean;
  output: string;
  error?: string;
}

let installRecorder: ((event: HelperInstallAudit) => void) | undefined;

/** Registered by the guardian so every install reaches the hash-chained journal. */
export function setHelperInstallRecorder(recorder: ((event: HelperInstallAudit) => void) | undefined): void {
  installRecorder = recorder;
}

/**
 * Where the bundled resources live. Set once by createRuntime so the desktop
 * app, the MCP server and the guardian all compare against the same helper. A
 * direct call from a script falls back to the working directory, which is the
 * project root in a source checkout.
 */
let configuredRoot: string | undefined;
export function setHelperAppRoot(root: string): void {
  configuredRoot = path.resolve(root);
}
export function helperAppRoot(): string {
  return configuredRoot ?? process.cwd();
}

const RESOURCE_HELPER = "nexus-priv.sh";
const RESOURCE_SUDOERS = "nexus-priv.sudoers";

function resourcePath(appRoot: string, name: string): string {
  return path.join(appRoot, "resources", name);
}

function readResource(appRoot: string, name: string): Buffer {
  const file = resourcePath(appRoot, name);
  try {
    return fs.readFileSync(file);
  } catch {
    throw new Error(`bundled resource is missing: resources/${name}`);
  }
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** Hash of the helper this build would install — the version check baseline. */
export function expectedHelperHash(appRoot: string): string {
  return sha256(readResource(appRoot, RESOURCE_HELPER));
}

/* -------------------------------------------------------------- inspection */

const CHECK_SCRIPT = String.raw`
set +e
printf 'user=%s\n' "$(id -un)"
printf 'uid=%s\n' "$(id -u)"
if [ -x HELPER_PATH ]; then
  printf 'helper=present\n'
  printf 'helper_sha=%s\n' "$(sha256sum HELPER_PATH 2>/dev/null | awk '{print $1}')"
  printf 'helper_mode=%s\n' "$(stat -c '%a %U:%G' HELPER_PATH 2>/dev/null)"
else
  printf 'helper=absent\n'
fi
if [ -f SUDOERS_PATH ]; then printf 'sudoers=present\n'; else printf 'sudoers=absent\n'; fi
printf 'rule_lines=%s\n' "$(sudo -n -l 2>/dev/null | grep -c 'nexus-priv')"
# A bare invocation matches none of the granted patterns, so prove the grant
# with a real read-only subcommand; guard status always exits 0.
OUT=$(sudo -n HELPER_PATH guard status 2>&1)
printf 'priv_rc=%s\n' "$?"
printf 'priv_msg=%s\n' "$(printf '%s' "$OUT" | head -1 | tr -d '\r')"
printf 'have_sudo=%s\n' "$(command -v sudo >/dev/null 2>&1 && echo yes || echo no)"
printf 'have_visudo=%s\n' "$(command -v visudo >/dev/null 2>&1 && echo yes || echo no)"
printf 'have_base64=%s\n' "$(command -v base64 >/dev/null 2>&1 && echo yes || echo no)"
printf 'have_install=%s\n' "$(command -v install >/dev/null 2>&1 && echo yes || echo no)"
`;

function render(script: string): string {
  return script.replaceAll("HELPER_PATH", HELPER_PATH).replaceAll("SUDOERS_PATH", SUDOERS_PATH);
}

function parseKeyValues(stdout: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (!/^[a-z_]+$/.test(key)) continue;
    map[key] = line.slice(at + 1).trim();
  }
  return map;
}

function bootstrapScript(appRoot: string, host: StoredSshHost, asRoot: boolean): string {
  // A host with no route at all has to be onboarded from a root shell (console,
  // rescue mode or root SSH). Give the exact commands rather than a paragraph.
  const target = asRoot ? `${host.username}@${host.host}` : `root@${host.host}`;
  const sudoers = readResource(appRoot, RESOURCE_SUDOERS)
    .toString("utf8")
    .replaceAll("@USER@", host.username)
    .replace(/^#.*$/gm, "")
    .trim();
  const lines = [
    "# from the Nexus PVE project directory; root SSH not available? run the same",
    "# two install commands from the host console instead of over scp/ssh",
    `scp resources/${RESOURCE_HELPER} ${target}:/tmp/nexus-priv`,
    `ssh ${target} 'install -o root -g root -m 0755 /tmp/nexus-priv ${HELPER_PATH} && rm -f /tmp/nexus-priv'`,
  ];
  if (!asRoot) {
    lines.push(
      "# then, still as root on the host, write the sudoers drop-in:",
      `printf '%s\\n' '${sudoers.replaceAll("'", "'\\''")}' > ${SUDOERS_PATH}.tmp`,
      `chmod 0440 ${SUDOERS_PATH}.tmp && visudo -cf ${SUDOERS_PATH}.tmp && mv ${SUDOERS_PATH}.tmp ${SUDOERS_PATH}`,
    );
  }
  lines.push("# afterwards press Recheck in the app");
  return lines.join("\n");
}

function classify(input: {
  host: StoredSshHost;
  uid: number;
  helper: boolean;
  sudoers: boolean;
  helperSha?: string;
  expectedSha: string;
  answers: boolean;
  nopasswd: boolean;
  hasPassword: boolean;
  hasSudo: boolean;
}): { state: HelperState; route: HelperRoute; detail: string } {
  const { host, uid, helper, sudoers, answers, nopasswd, hasPassword, hasSudo, helperSha, expectedSha } = input;
  const root = uid === 0;
  const route: HelperRoute = root
    ? "root"
    : nopasswd
      ? "nopasswd"
      : hasSudo && hasPassword
        ? "password"
        : "none";
  const current = helper && helperSha === expectedSha;
  const ruleOk = root || sudoers;

  if (helper && current && answers && ruleOk) {
    return {
      state: "ready",
      route,
      detail: root
        ? "helper installed, privileged actions run directly as root"
        : "helper and sudoers drop-in installed, passwordless grant is live",
    };
  }

  if (!helper && !sudoers) {
    if (route === "none") {
      return {
        state: "blocked",
        route,
        detail: hasSudo
          ? `no root route from ${host.username}: key auth only, no NOPASSWD grant — onboard once from a root shell`
          : `sudo is not installed on this host and the account is not root — onboard once from a root shell`,
      };
    }
    return { state: "missing", route, detail: `not installed — install with the ${route} route` };
  }

  if (!helper) return { state: "partial", route, detail: `sudoers drop-in present but ${HELPER_PATH} is missing` };
  if (!sudoers && !root) {
    return { state: "partial", route, detail: `helper present but ${SUDOERS_PATH} is missing — actions need elevated auth` };
  }
  if (!current) {
    return {
      state: "outdated",
      route,
      detail:
        `installed helper is a different build (${(helperSha ?? "unreadable").slice(0, 12)}) — ` +
        (route === "nopasswd"
          ? "the NOPASSWD grant can run it but not replace it; enter a sudo password once to reinstall"
          : "reinstall to match this app"),
    };
  }
  return {
    state: "partial",
    route,
    detail: `helper and drop-in are present but sudo does not run it — check the sudoers syntax and file ownership`,
  };
}

/* ------------------------------------------------------------------- check */

export async function checkHelper(store: ConfigStore, appRoot: string, id: string): Promise<HelperStatus> {
  const host = store.sshHost(id);
  if (!host) throw new Error(`Unknown Linux host: ${id}`);
  const password = host.authMode === "password" ? store.sshSecretFor(host.id) : undefined;
  const expectedSha = expectedHelperHash(appRoot);
  const base: HelperStatus = {
    hostId: host.id,
    state: "missing",
    route: "none",
    user: host.username,
    helperPath: HELPER_PATH,
    expectedSha,
    files: { helper: false, sudoers: false },
    passwordless: false,
    detail: "",
    checkedAt: Date.now(),
  };

  if (host.authMode === "password" && !password) {
    return { ...base, state: "blocked", detail: "stored SSH password is missing, reconnect or re-save the host", error: "no credentials" };
  }

  const result = await runRemote(toRunner(store.publicSshHost(host), 25_000, password), render(CHECK_SCRIPT), "sh");
  const kv = parseKeyValues(result.stdout);
  if (!result.ok || !kv.uid) {
    const reason = result.stderr.trim().split(/\r?\n/).slice(-1)[0] || "host did not answer";
    return { ...base, detail: `could not inspect the helper: ${reason}`, latencyMs: result.latencyMs, error: reason };
  }

  const uid = Number(kv.uid);
  const helper = kv.helper === "present";
  const sudoers = kv.sudoers === "present";
  // priv_rc 0 means sudo ran the helper without asking for a password: that is
  // the grant being live, which is stronger than `sudo -n true` succeeding.
  // A root login needs no grant at all (sudo may not even be installed), so it
  // counts as able to run the helper by definition.
  const answers = uid === 0 || kv.priv_rc === "0";
  const nopasswd = answers;
  const user = kv.user || host.username;
  const verdict = classify({
    host,
    uid,
    helper,
    sudoers,
    helperSha: kv.helper_sha || undefined,
    expectedSha,
    answers,
    nopasswd,
    hasPassword: Boolean(password),
    hasSudo: kv.have_sudo === "yes",
  });

  return {
    ...base,
    state: verdict.state,
    route: verdict.route,
    user,
    uid,
    installedSha: kv.helper_sha || undefined,
    files: { helper, sudoers },
    passwordless: nopasswd,
    detail: verdict.detail,
    bootstrap: verdict.state === "blocked" ? bootstrapScript(appRoot, host, uid === 0) : undefined,
    latencyMs: result.latencyMs,
    checkedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ gate */

/**
 * Whether an outdated helper should block a privileged action. Only routes
 * that actually go through the helper are affected: a root login runs commands
 * directly, and a password host pipes sudo its own way, so neither depends on
 * the installed binary. NOPASSWD and no-route hosts do, and a mismatch there is
 * refused loudly rather than left to fail one subcommand at a time.
 */
export function helperBlocksActions(status: HelperStatus): boolean {
  return status.state === "outdated" && status.route !== "root" && status.route !== "password";
}

/**
 * Refuses a privileged action when the installed helper is a different build.
 * `strict` also refuses root and password routes, for callers such as the guard
 * that invoke the installed helper regardless of how they elevate.
 */
export async function assertHelperCurrent(
  store: ConfigStore,
  id: string,
  options: { strict?: boolean } = {},
): Promise<HelperStatus> {
  const status = await checkHelper(store, helperAppRoot(), id);
  if (options.strict ? status.state === "outdated" : helperBlocksActions(status)) {
    const installed = (status.installedSha ?? "unreadable").slice(0, 12);
    const expected = status.expectedSha.slice(0, 12);
    throw new Error(
      `Refusing privileged action on ${status.user || id}: installed helper ${installed} is outdated (this build ships ${expected}). ` +
        "Reinstall it from Linux hosts → Privileged helper, or let the security guard refresh it, then retry.",
    );
  }
  return status;
}

/* ----------------------------------------------------------------- install */

function b64(value: Buffer | string): string {
  return Buffer.from(value).toString("base64");
}

function installScript(appRoot: string, user: string, helperSha: string, withSudoers: boolean): string {
  const helper = b64(readResource(appRoot, RESOURCE_HELPER));
  const sudoers = b64(readResource(appRoot, RESOURCE_SUDOERS).toString("utf8").replaceAll("@USER@", user));
  const lines = [
    "set -u",
    "umask 022",
    `printf 'installer_user=%s\\n' ${JSON.stringify(user)}`,
    "decode() {",
    "  if command -v base64 >/dev/null 2>&1; then base64 -d 2>/dev/null || return 1;",
    "  elif command -v openssl >/dev/null 2>&1; then openssl base64 -d -A 2>/dev/null || return 1;",
    "  else echo 'no base64 decoder on host' >&2; return 1;",
    "  fi",
    "}",
    "tmp=${TMPDIR:-/tmp}/nexus-priv.$$",
    `printf '%s' '${helper}' | decode >"$tmp" || { echo '@@fail=decode-helper'; rm -f "$tmp"; exit 20; }`,
    `got=$(sha256sum "$tmp" 2>/dev/null | awk '{print $1}')`,
    `if [ "$got" != '${helperSha}' ]; then echo '@@fail=helper-hash' "@@got=$got"; rm -f "$tmp"; exit 21; fi`,
    `if ! sh -n "$tmp"; then echo '@@fail=helper-syntax'; rm -f "$tmp"; exit 22; fi`,
    `install -o root -g root -m 0755 "$tmp" ${HELPER_PATH} || { rm -f "$tmp"; echo '@@fail=helper-install'; exit 23; }`,
    'rm -f "$tmp"',
    `printf 'helper=installed\\n'`,
    'printf \'helper_sha=%s\\n\' "$(sha256sum ' + HELPER_PATH + ` | awk '{print $1}')"`,
  ];

  if (withSudoers) {
    lines.push(
      `tmp=${SUDOERS_PATH}.tmp`,
      `printf '%s' '${sudoers}' | decode >"$tmp" || { echo '@@fail=decode-sudoers'; rm -f "$tmp"; exit 30; }`,
      `chown root:root "$tmp"; chmod 0440 "$tmp"`,
      `if ! command -v visudo >/dev/null 2>&1; then echo '@@fail=no-visudo'; rm -f "$tmp"; exit 33; fi`,
      `if ! visudo -cf "$tmp" >/dev/null 2>&1; then echo '@@fail=sudoers-invalid'; visudo -cf "$tmp" 2>&1 | tail -3; rm -f "$tmp"; exit 31; fi`,
      `mv -f "$tmp" ${SUDOERS_PATH} || { rm -f "$tmp"; echo '@@fail=sudoers-install'; exit 32; }`,
      `printf 'sudoers=installed\\n'`,
    );
  } else {
    // root needs no grant for itself; drop a stale drop-in rather than leave a
    // rule that claims something it does not do.
    lines.push(`rm -f ${SUDOERS_PATH} && printf 'sudoers=not-needed\\n'`);
  }

  lines.push(`printf 'user=%s\\n' '${user}'`, `printf 'helper_path=%s\\n' ${JSON.stringify(HELPER_PATH)}`, "echo @@done");
  return lines.join("\n");
}

interface ElevationResult {
  ok: boolean;
  route: HelperRoute;
  output: string;
  code: number | null;
  latencyMs: number;
}

/**
 * Runs `script` as root on the host. The payload travels base64-encoded on
 * stdin, so neither the script nor the password ever reaches a remote argv or a
 * shell history: `sudo -S` reads the password from the pipe.
 */
async function runElevated(
  store: ConfigStore,
  host: StoredSshHost,
  script: string,
  sudoPassword?: string,
): Promise<ElevationResult> {
  // Two different secrets: the SSH password authenticates the transport, the
  // sudo password feeds `sudo -S`. A key-auth host has no SSH password but may
  // still need a sudo one, so the override is kept separate on purpose.
  const password = host.authMode === "password" ? store.sshSecretFor(host.id) : undefined;
  const elevatedSecret = sudoPassword?.trim() || password;
  const payload = b64(script);
  const secret = b64(elevatedSecret ?? "");
  const wrapper = [
    "set +e",
    `PW=$(printf '%s' '${secret}' | base64 -d 2>/dev/null)`,
    `CMD=$(printf '%s' '${payload}' | base64 -d 2>/dev/null)`,
    `if [ -z "$CMD" ]; then echo '@@fail=payload'; echo '@@exit:78'; exit 0; fi`,
    'if [ "$(id -u)" = 0 ]; then',
    '  ROUTE=root',
    '  sh -c "$CMD" 2>&1',
    '  RC=$?',
    'elif [ -n "$PW" ]; then',
    '  ROUTE=password',
    `  printf '%s\\n' "$PW" | sudo -S -p '' sh -c "$CMD" 2>&1`,
    "  RC=$?",
    'elif sudo -n true >/dev/null 2>&1; then',
    '  ROUTE=nopasswd',
    '  sudo -n sh -c "$CMD" 2>&1',
    '  RC=$?',
    'else',
    '  ROUTE=none',
    '  echo "@@fail=no-root-route"',
    '  RC=77',
    'fi',
    'printf "@@route=%s\\n" "$ROUTE"',
    'printf "@@exit:%s\\n" "$RC"',
  ].join("\n");

  const result = await runRemote(toRunner(store.publicSshHost(host), 90_000, password), wrapper, "sh");
  const routeLine = /@@route=(root|nopasswd|password|none)/.exec(result.stdout)?.[1];
  const exitLine = /@@exit:(\d+)/.exec(result.stdout);
  const code = exitLine ? Number(exitLine[1]) : result.code;
  // A stored password can show up in sudo's own diagnostics; never echo it back
  // into the renderer, the journal or an agent transcript.
  const hidden = elevatedSecret && elevatedSecret.length >= 4 ? elevatedSecret : undefined;
  const raw = `${result.stdout}\n${result.stderr}`.trim();
  const output = (hidden ? raw.split(hidden).join("[redacted]") : raw || "no output").slice(0, 4000);
  return {
    ok: result.ok && code === 0 && /@@done/.test(result.stdout),
    route: routeLine === "root" || routeLine === "nopasswd" || routeLine === "password" ? routeLine : "none",
    output,
    code,
    latencyMs: result.latencyMs,
  };
}

export async function installHelper(
  store: ConfigStore,
  appRoot: string,
  id: string,
  sudoPassword?: string,
  options: { trigger?: HelperInstallTrigger } = {},
): Promise<HelperInstallResult> {
  const host = store.sshHost(id);
  if (!host) throw new Error(`Unknown Linux host: ${id}`);
  const before = await checkHelper(store, appRoot, id);
  if (before.state === "ready") {
    return { hostId: host.id, ok: true, route: before.route, output: "already installed and current — nothing to do", status: before };
  }

  const audit = (event: { route: HelperRoute; afterState: HelperState; ok: boolean; output: string; error?: string }) => {
    if (!installRecorder) return;
    try {
      installRecorder({
        hostId: host.id,
        hostLabel: host.label,
        trigger: options.trigger ?? "manual",
        beforeState: before.state,
        ...event,
      });
    } catch (error) {
      // A journal problem must not turn a completed install into a failure.
      console.error("[nexus] helper install audit failed", error);
    }
  };

  // "blocked" means no root route is known yet. A one-time sudo password turns
  // that into a usable route without storing anything new on this machine.
  if (before.state === "blocked" && !sudoPassword?.trim()) {
    const blocked: HelperInstallResult = {
      hostId: host.id,
      ok: false,
      route: "none",
      output: before.detail,
      status: before,
      error: "this host offers no root route yet; supply a sudo password once or use the bootstrap commands",
    };
    audit({ route: blocked.route, afterState: before.state, ok: false, output: blocked.output, error: blocked.error });
    return blocked;
  }
  // A live grant proves the helper is usable, but the sudoers rule only lists
  // its own subcommands. Replacing the binary needs a real elevation route.
  // Only a password-auth host has a stored secret `runElevated` can reuse; a
  // key-auth host needs the password typed for this one install.
  if (
    !sudoPassword?.trim() &&
    host.authMode !== "password" &&
    before.passwordless &&
    before.route === "nopasswd" &&
    (before.uid ?? 0) !== 0
  ) {
    const refused: HelperInstallResult = {
      hostId: host.id,
      ok: false,
      route: before.route,
      output: before.detail,
      status: before,
      error: "the NOPASSWD grant can run the helper but cannot replace it; enter a sudo password once in Linux hosts to reinstall",
    };
    audit({ route: refused.route, afterState: before.state, ok: false, output: refused.output, error: refused.error });
    return refused;
  }

  const user = before.user || host.username;
  const script = installScript(appRoot, user, before.expectedSha, (before.uid ?? 0) !== 0);
  const result = await runElevated(store, host, script, sudoPassword);
  const status = await checkHelper(store, appRoot, id);
  const failure = /@@fail=([a-z-]+)/.exec(result.output)?.[1];
  const ok = result.ok && status.state === "ready";
  const output = result.output.trim() || (ok ? "installed" : `installer exited ${result.code ?? "without a code"}`);
  // Prefer the installer's own diagnostic (e.g. sudo rejecting a one-time
  // password) over the unchanged status detail, which only says "outdated".
  const diagnostic = result.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("@@"))
    .at(-1);
  const error = ok
    ? undefined
    : failure
      ? `installer refused: ${failure}`
      : !result.ok && diagnostic
        ? diagnostic.slice(0, 200)
        : status.detail;
  audit({ route: result.route, afterState: status.state, ok, output, error });
  return {
    hostId: host.id,
    ok,
    route: result.route,
    output,
    status,
    error,
  };
}
