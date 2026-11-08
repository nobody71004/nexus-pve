import type { ConfigStore } from "../config";
import type { SshAction, SshActionResult, SshHostSummary } from "../../shared/types";
import { parseProbe, runRemote } from "./probe";
import { sshRunner } from "./collect";
import { assertHelperCurrent } from "./helper";

export { runSpeedTest, runSpeedTestAll } from "./speedtest";

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function shq(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

const UNIT = /^[A-Za-z0-9@._-]+$/;

/** Installed by resources/nexus-priv.sh; the only NOPASSWD entry on the host. */
const PRIV_HELPER = "/usr/local/sbin/nexus-priv";

/**
 * Runs one privileged command as root, by the strongest route the host offers:
 *
 *  - root login: the script runs directly;
 *  - password host: the stored password is base64-decoded remotely and piped to
 *    `sudo -S`, so it never appears in the command line or in argv;
 *  - key host: `sudo -n /usr/local/sbin/nexus-priv <subcommand>`, the single
 *    NOPASSWD entry the host grants. The helper validates every argument, so no
 *    caller-supplied command string ever reaches a root shell.
 */
export async function runPrivileged(
  store: ConfigStore,
  id: string,
  command: string,
  options: { helper?: string[]; timeoutMs?: number; requireCurrentHelper?: boolean } = {},
): Promise<{ ok: boolean; output: string }> {
  const host = store.sshHost(id)!;
  const password = host.authMode === "password" ? (store.sshSecretFor(host.id) ?? "") : "";
  // A key-auth, non-root login is the usual path that depends on the installed
  // helper. Refuse an outdated build before it misreads a subcommand; a root
  // login runs directly and a password host uses its own sudo path for host
  // actions. Guard actions invoke the helper on every route, so they pass
  // requireCurrentHelper and are checked strictly.
  if (options.helper && (options.requireCurrentHelper || (host.authMode !== "password" && host.username !== "root"))) {
    await assertHelperCurrent(store, id, { strict: options.requireCurrentHelper === true });
  }
  const helper = options.helper ? [PRIV_HELPER, ...options.helper].map(shq).join(" ") : "";
  const fallback = helper
    ? [
        `elif [ -x ${PRIV_HELPER} ]; then`,
        `  sudo -n ${helper} 2>&1`,
        "else",
        `  echo ${shq(`${PRIV_HELPER} is not installed and this account has no sudo password; run resources/nexus-priv.sh`)} >&2`,
        "  false",
      ]
    : ["else", `  echo ${shq("no root route for this account")} >&2`, "  false"];
  const script = [
    `PW=$(printf %s '${base64(password)}' | base64 -d 2>/dev/null || true)`,
    `CMD=$(printf %s '${base64(command)}' | base64 -d)`,
    'if [ "$(id -u)" = 0 ]; then',
    '  bash -c "$CMD" 2>&1',
    'elif [ -n "$PW" ]; then',
    '  printf "%s\\n" "$PW" | sudo -S -p "" bash -c "$CMD" 2>&1',
    ...fallback,
    'fi',
    'echo "@@exit:$?"',
  ].join("\n");
  const result = await runRemote(sshRunner(store, id, options.timeoutMs ?? 60_000), `${script}\n`, "bash");
  const output = result.stdout.replace(/@@exit:(\d+)\s*$/, "").trim();
  const exitCode = Number(/@@exit:(\d+)/.exec(result.stdout)?.[1] ?? (result.ok ? 0 : 1));
  return { ok: result.ok && exitCode === 0, output: (output || result.stderr).slice(0, 4_000) };
}

export async function actOnSshHost(
  store: ConfigStore,
  id: string,
  action: SshAction,
  target?: string,
): Promise<SshActionResult> {
  const host = store.sshHost(id);
  if (!host) throw new Error(`Unknown Linux host: ${id}`);
  const summary: SshHostSummary = store.publicSshHost(host);

  if (action === "reboot" || action === "shutdown") {
    const verb = action === "reboot" ? "systemctl reboot" : "systemctl poweroff";
    // Background it so the SSH channel can close before the host drops.
    const outcome = await runPrivileged(store, id, `(sleep 2; ${verb}) >/dev/null 2>&1 &`, {
      helper: ["power", action],
    });
    return { host: summary.label, action, ok: true, output: outcome.output || `${verb} scheduled` };
  }

  if (action === "backup") {
    return backupHost(store, id, summary, target);
  }

  const unit = (target ?? "").trim();
  if (!unit) throw new Error("A service name is required");
  if (!UNIT.test(unit)) throw new Error("Service name contains unsupported characters");
  const verb = action === "restart-service" ? "restart" : action === "stop-service" ? "stop" : "start";
  const systemctl = `systemctl ${verb} ${unit}`;
  const outcome = await runPrivileged(store, id, `${systemctl}; systemctl is-active ${unit}`, {
    helper: ["service", verb, unit],
  });
  return { host: summary.label, action, target: unit, ok: outcome.ok, output: outcome.output };
}

/**
 * Config/data backup on the host itself: one timestamped tar.gz under
 * /var/backups/nexus, with the three newest kept per host. It deliberately does
 * not try to image the whole disk — that is what Proxmox snapshots are for.
 */
async function backupHost(
  store: ConfigStore,
  id: string,
  summary: SshHostSummary,
  target?: string,
): Promise<SshActionResult> {
  const requested = (target ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const paths = requested.length > 0 ? requested : ["/etc", "/home"];
  if (paths.length > 8) throw new Error("At most 8 paths per backup");
  for (const entry of paths) {
    if (!/^\/[A-Za-z0-9/._-]*$/.test(entry) || entry.includes("..")) {
      throw new Error(`Unsupported backup path: ${entry} (absolute path, no shell characters)`);
    }
  }
  const slug = summary.label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "host";
  const script = [
    "set -o pipefail",
    `DEST=/var/backups/nexus`,
    'mkdir -p "$DEST" || exit 4',
    `EXISTING="$(for p in ${paths.join(" ")}; do [ -e "$p" ] && printf '%s ' "$p"; done)"`,
    '[ -n "$EXISTING" ] || { echo "none of the requested paths exist on this host"; exit 3; }',
    'TS=$(date +%Y%m%d-%H%M%S)',
    `ARCHIVE="$DEST/${slug}-$TS.tar.gz"`,
    'echo "paths=$EXISTING"',
    'tar -czf "$ARCHIVE" $EXISTING 2>/dev/null',
    "RC=$?",
    'echo "archive=$ARCHIVE"',
    'ls -lh "$ARCHIVE" 2>/dev/null | awk \'{print "size="$5}\'',
    `ls -1t "$DEST"/${slug}-*.tar.gz 2>/dev/null | tail -n +4 | while read -r old; do rm -f "$old"; done`,
    "exit $RC",
  ].join("\n");
  const outcome = await runPrivileged(store, id, script, {
    helper: ["backup", slug, ...paths],
    timeoutMs: 15 * 60_000,
  });
  return {
    host: summary.label,
    action: "backup",
    target: paths.join(" "),
    ok: outcome.ok,
    output: outcome.output || "backup finished with no output",
  };
}

/** Exported for the mock-free smoke path: a cheap way to confirm a host answers. */
export function probeSummary(snapshotSource: string): string {
  return parseProbe(
    {
      id: "probe",
      label: "probe",
      host: "probe",
      port: 22,
      username: "probe",
      authMode: "key",
      hasSecret: false,
      color: "#000",
      createdAt: 0,
    },
    snapshotSource,
    { latencyMs: 0, ok: true },
  ).identity.hostname;
}
