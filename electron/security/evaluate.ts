import crypto from "node:crypto";
import type {
  HelperStatus,
  SecurityCheck,
  SecurityDrift,
  SecurityLayer,
  SecurityPolicy,
  SecuritySeverity,
  SecurityStatus,
} from "../../shared/types";
import type { AuditFacts } from "./audit";

/**
 * Layer 3 — evaluation. Pure functions over collected facts, so the same policy
 * produces the same verdict whether it runs from the desktop, the MCP server or
 * a test harness.
 */

const WEIGHT: Record<SecuritySeverity, number> = {
  critical: 30,
  high: 18,
  medium: 8,
  low: 3,
  info: 0,
};

const LAYERS: SecurityLayer[] = ["access", "network", "patch", "kernel", "integrity", "persistence"];

const FIM_SEVERITY: Array<{ match: RegExp; severity: SecuritySeverity; title: string }> = [
  { match: /^\/etc\/sudoers/, severity: "critical", title: "sudo policy" },
  { match: /^\/etc\/passwd$|^\/etc\/shadow$/, severity: "high", title: "account database" },
  { match: /^\/etc\/group$/, severity: "medium", title: "group database" },
  { match: /^\/etc\/ssh\//, severity: "high", title: "sshd configuration" },
  { match: /^\/etc\/cron|^\/var\/spool\/cron/, severity: "high", title: "cron configuration" },
  { match: /^\/etc\/systemd\//, severity: "high", title: "systemd units" },
  { match: /^\/etc\/rc\.local$/, severity: "high", title: "boot script" },
  { match: /^\/etc\/hosts$/, severity: "low", title: "hosts file" },
];

/** Ports that should not be reachable on a public interface without a proxy. */
const RISKY_PORTS = new Set([2375, 2376, 3306, 5432, 6379, 27017, 9200, 9300, 11211, 5984, 6443, 10250]);

/**
 * Cron lines that fetch-and-execute, decode a payload inline or expose a socket.
 * `perl -e` alone is too broad: Ubuntu's stock certbot entry randomises its own
 * sleep with `perl -e 'sleep int(rand(43200))'`, so require a socket/exec call
 * before calling it suspicious — a security bot that cries wolf on the distro's
 * own jobs trains the operator to ignore it.
 */
const SUSPICIOUS_CRON =
  /(curl|wget)\s+[^\n|]*\|\s*(ba)?sh|base64\s+(-d|--decode)|\/dev\/tcp\/|nc\s+(-e|--exec)|python[0-9.]*\s+-c|perl\s+-e\s+[^|\n]*(?:socket|system\s*\(|exec\s*\(|`)|chmod\s+\+x\s+\/tmp\//i;

const SYSCTL_EXPECTED: Record<string, string> = {
  "net.ipv4.conf.all.rp_filter": "1",
  "net.ipv4.tcp_syncookies": "1",
  "net.ipv4.conf.all.accept_redirects": "0",
  "net.ipv4.conf.all.send_redirects": "0",
  "net.ipv4.conf.all.accept_source_route": "0",
  "net.ipv6.conf.all.accept_ra": "0",
  "kernel.randomize_va_space": "2",
  "kernel.kptr_restrict": "2",
  "kernel.dmesg_restrict": "1",
  "kernel.yama.ptrace_scope": "1",
  "fs.protected_hardlinks": "1",
  "fs.protected_symlinks": "1",
  "fs.suid_dumpable": "0",
};

export interface EvaluationInput {
  facts: AuditFacts;
  baseline: Record<string, string>;
  policy: SecurityPolicy;
  policyTampered?: boolean;
  /** Live helper version check, when the guardian could reach the host. */
  helper?: HelperStatus;
}

export interface Evaluation {
  checks: SecurityCheck[];
  drift: SecurityDrift[];
  baseline: Record<string, string>;
  candidates: string[];
}

function sha(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clip(value: string, max = 240): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function gradeFor(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function scoreFor(checks: SecurityCheck[]): number {
  let penalty = 0;
  for (const check of checks) {
    if (check.status === "fail") penalty += WEIGHT[check.severity];
    else if (check.status === "warn") penalty += Math.ceil(WEIGHT[check.severity] / 2);
  }
  return Math.max(0, Math.min(100, 100 - penalty));
}

export function layersOf(checks: SecurityCheck[]): Array<{ layer: SecurityLayer; pass: number; warn: number; fail: number; score: number }> {
  return LAYERS.map((layer) => {
    const scoped = checks.filter((check) => check.layer === layer);
    const pass = scoped.filter((check) => check.status === "pass").length;
    const warn = scoped.filter((check) => check.status === "warn").length;
    const fail = scoped.filter((check) => check.status === "fail").length;
    const relevant = pass + warn + fail;
    return { layer, pass, warn, fail, score: relevant === 0 ? 100 : Math.round((pass / relevant) * 100) };
  });
}

export function evaluate({ facts, baseline, policy, policyTampered, helper }: EvaluationInput): Evaluation {
  const raw = facts.values;
  const value = (key: string) => raw[key] ?? "";
  const lines = (key: string) =>
    value(key)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  const sshdEffective = value("sshd_effective");
  const sshdRaw = value("sshd_raw");
  const privileged = facts.privileged;

  const sshdSetting = (name: string): string => {
    if (sshdEffective) {
      const match = new RegExp(`^${name}\\s+(\\S+)`, "mi").exec(sshdEffective);
      if (match) return match[1].toLowerCase();
    }
    // Fall back to the on-disk config when sshd -T was unavailable: the last
    // matching directive wins, which matches sshd's own precedence.
    let found = "";
    const pattern = new RegExp(`^\\s*${name}\\s+(\\S+)`, "gim");
    for (const match of sshdRaw.matchAll(pattern)) found = match[1].toLowerCase();
    return found;
  };

  const checks: SecurityCheck[] = [];
  const add = (
    id: string,
    layer: SecurityLayer,
    severity: SecuritySeverity,
    status: SecurityStatus,
    title: string,
    detail: string,
    extra: Partial<SecurityCheck> = {},
  ) => {
    checks.push({ id, layer, severity, status, title, detail, ...extra });
  };

  /* ------------------------------------------------------------------ access */

  const rootLogin = sshdSetting("permitrootlogin");
  if (!rootLogin) {
    add("ssh.root-login", "access", "high", "unknown", "Root SSH login", "effective sshd configuration could not be read", {
      remediation: "ssh-permit-root",
    });
  } else if (rootLogin === "yes") {
    add("ssh.root-login", "access", "high", "fail", "Root SSH login", "PermitRootLogin yes — root can authenticate over SSH", {
      remediation: "ssh-permit-root",
      evidence: "permitrootlogin yes",
    });
  } else {
    add("ssh.root-login", "access", "high", "pass", "Root SSH login", `restricted (${rootLogin})`);
  }

  const passwordAuth = sshdSetting("passwordauthentication");
  if (!passwordAuth) {
    add("ssh.password-auth", "access", "high", "unknown", "SSH password authentication", "not visible without the root helper");
  } else if (passwordAuth === "yes") {
    const passwordTransport = value("transport") === "password";
    add(
      "ssh.password-auth",
      "access",
      "high",
      "warn",
      "SSH password authentication",
      passwordTransport
        ? "enabled — this host is configured with password sign-in, so disabling SSH passwords would lock the app out; add a key and switch the host to key auth first"
        : "enabled — keys are phishing- and brute-force resistant, passwords are not",
      {
        remediation: passwordTransport ? undefined : "ssh-key-only",
        guarded: true,
      },
    );
  } else {
    add("ssh.password-auth", "access", "high", "pass", "SSH password authentication", "disabled (keys only)");
  }

  const emptyUsers = lines("empty_users");
  if (!privileged && !("empty_users" in raw)) {
    add("ssh.empty-passwords", "access", "critical", "unknown", "Empty passwords", "requires the root helper");
  } else if (emptyUsers.length > 0) {
    add("ssh.empty-passwords", "access", "critical", "fail", "Empty passwords", `${emptyUsers.length} account(s) with no password hash: ${emptyUsers.join(", ")}`, {
      evidence: emptyUsers.join(", "),
    });
  } else {
    add("ssh.empty-passwords", "access", "critical", "pass", "Empty passwords", "no account has an empty password");
  }

  const sudoers = lines("sudo_nopasswd").filter((line) => !line.startsWith("#"));
  const wide = sudoers.filter((line) =>
    /NOPASSWD\s*:\s*ALL/i.test(line) ||
    /NOPASSWD\s*:\s*(\/usr)?\/bin\/(ba|da|z)?sh\b/i.test(line) ||
    /NOPASSWD\s*:\s*(\/usr)?\/bin\/(vi|vim|less|more|man|awk|sed|find|tee|dd|cp|mv|env|python[0-9.]*|perl|ruby|node)\b/i.test(line),
  );
  const others = sudoers.filter((line) => !/nexus-priv/.test(line));
  if (wide.length > 0) {
    add("sudo.nopasswd-wide", "access", "critical", "fail", "Passwordless sudo breadth", "a NOPASSWD rule grants a general-purpose interpreter or ALL", {
      remediation: "sudo-narrow",
      evidence: clip(wide.join(" | ")),
    });
  } else if (others.length > 0) {
    add("sudo.nopasswd-wide", "access", "medium", "warn", "Passwordless sudo breadth", `${others.length} NOPASSWD rule(s) outside the guard helper`, {
      evidence: clip(others.join(" | ")),
    });
  } else {
    add("sudo.nopasswd-wide", "access", "critical", "pass", "Passwordless sudo breadth", "only the narrow guard helper is passwordless");
  }

  const uid0 = lines("uid0").filter((name) => name !== "root");
  if (uid0.length > 0) {
    add("accounts.uid0", "access", "critical", "fail", "Extra root accounts", `non-root accounts with uid 0: ${uid0.join(", ")}`, {
      evidence: uid0.join(", "),
    });
  } else if (privileged) {
    add("accounts.uid0", "access", "critical", "pass", "Extra root accounts", "root is the only uid 0 account");
  } else {
    add("accounts.uid0", "access", "critical", "unknown", "Extra root accounts", "requires the root helper");
  }

  const failed = Number(value("failed_logins") || 0);
  if (failed > 500) {
    add("auth.bruteforce", "access", "high", "fail", "SSH brute force", `${failed} failed logins in 24h — active attack`, {
      evidence: clip(lines("failed_ips").slice(0, 5).join(" · ")),
    });
  } else if (failed > 50) {
    add("auth.bruteforce", "access", "medium", "warn", "SSH brute force", `${failed} failed logins in 24h`, {
      evidence: clip(lines("failed_ips").slice(0, 5).join(" · ")),
    });
  } else {
    add("auth.bruteforce", "access", "high", "pass", "SSH brute force", `${failed} failed logins in 24h`);
  }

  const acceptedRoot = Number(value("accepted_root") || 0);
  if (acceptedRoot > 0) {
    add("auth.root-sessions", "access", "medium", "warn", "Root sessions", `${acceptedRoot} successful root login(s) in 24h`);
  } else {
    add("auth.root-sessions", "access", "medium", "pass", "Root sessions", "no root logins in 24h");
  }

  /* ----------------------------------------------------------------- network */

  const ufw = value("ufw");
  const nft = value("firewall_nft");
  const iptables = value("firewall_iptables") || value("iptables");
  const ufwActive = /status:\s*active/i.test(ufw);
  // nftables prints the input policy inside its chain block; iptables-save uses
  // ":INPUT DROP" rather than the word "policy".
  const nftActive = /hook\s+input[^}]*policy\s+drop/i.test(nft);
  const iptablesActive =
    /^:INPUT\s+(DROP|REJECT)/im.test(iptables) ||
    /policy\s+(DROP|REJECT)/i.test(iptables) ||
    /^-A INPUT\s+.*-j\s+(DROP|REJECT)\b/im.test(iptables);
  if (!privileged && !ufw && !nft && !iptables) {
    add("net.firewall", "network", "high", "unknown", "Host firewall", "requires the root helper");
  } else if (ufwActive || nftActive || iptablesActive) {
    add(
      "net.firewall",
      "network",
      "high",
      "pass",
      "Host firewall",
      ufwActive ? "ufw is active" : nftActive ? "nftables input policy is drop" : "iptables input policy is drop",
    );
  } else {
    add("net.firewall", "network", "high", "fail", "Host firewall", "no active host firewall — every listening service is directly reachable", {
      remediation: "firewall-baseline",
      guarded: true,
    });
  }

  const fail2ban = value("fail2ban");
  const fail2banActive = /currently banned|status for the jail|jail list/i.test(fail2ban);
  if (fail2banActive) {
    add("net.fail2ban", "network", "medium", "pass", "Intrusion prevention", "fail2ban is watching sshd");
  } else if (privileged) {
    add("net.fail2ban", "network", "medium", "warn", "Intrusion prevention", "fail2ban is not active — repeated SSH guesses are not throttled", {
      remediation: "fail2ban-baseline",
    });
  } else {
    add("net.fail2ban", "network", "medium", "unknown", "Intrusion prevention", "requires the root helper");
  }

  const exposed: string[] = [];
  for (const entry of lines("listeners")) {
    const fields = entry.split(/\s+/);
    const local = fields[fields.length - 1] ?? "";
    const port = Number(local.split(":").pop()?.replace(/\]/g, "") ?? "");
    if (!RISKY_PORTS.has(port)) continue;
    if (!/^(0\.0\.0\.0|\[::\]|\*|::)/.test(local)) continue;
    exposed.push(`${port}`);
  }
  if (exposed.length > 0) {
    add("net.exposed-services", "network", "high", "warn", "Exposed admin services", `database/container ports on a public interface: ${[...new Set(exposed)].join(", ")}`, {
      evidence: clip(lines("listeners").join(" · ")),
    });
  } else {
    add("net.exposed-services", "network", "high", "pass", "Exposed admin services", "no database or container port is bound publicly");
  }

  /* ------------------------------------------------------------------- patch */

  const pending = Number(value("apt_pending") || 0);
  if (pending > 80) {
    add("patch.pending", "patch", "high", "fail", "Pending updates", `${pending} package updates pending`);
  } else if (pending > 20) {
    add("patch.pending", "patch", "medium", "warn", "Pending updates", `${pending} package updates pending`);
  } else {
    add("patch.pending", "patch", "medium", "pass", "Pending updates", pending === 0 ? "up to date" : `${pending} pending`);
  }

  const unattended = value("unattended");
  if (privileged && /Unattended-Upgrade\s+"1"/i.test(unattended) && /Update-Package-Lists\s+"1"/i.test(unattended)) {
    add("patch.unattended", "patch", "high", "pass", "Automatic security updates", "unattended-upgrades is enabled");
  } else if (!privileged) {
    add("patch.unattended", "patch", "high", "unknown", "Automatic security updates", "requires the root helper");
  } else {
    add("patch.unattended", "patch", "high", "warn", "Automatic security updates", "unattended-upgrades is not configured", {
      remediation: "unattended-upgrades",
    });
  }

  if (value("reboot_required") === "yes") {
    add("patch.reboot", "patch", "low", "warn", "Reboot required", "a kernel or library update is waiting for a reboot");
  } else {
    add("patch.reboot", "patch", "low", "pass", "Reboot required", "no pending reboot");
  }

  /* ------------------------------------------------------------------ kernel */

  const sysctl = new Map<string, string>();
  for (const line of lines("sysctl")) {
    const index = line.indexOf("=");
    if (index > 0) sysctl.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const weak = Object.entries(SYSCTL_EXPECTED).filter(([key, want]) => sysctl.has(key) && sysctl.get(key) !== want);
  const container = value("container").trim();
  if (!privileged && sysctl.size === 0) {
    add("kernel.sysctl", "kernel", "medium", "unknown", "Kernel hardening", "requires the root helper");
  } else if (weak.length > 0) {
    add(
      "kernel.sysctl",
      "kernel",
      "medium",
      "warn",
      "Kernel hardening",
      container
        ? `${weak.length} sysctl protection(s) are off, and this guest is a ${container} container — the host kernel controls these values`
        : `${weak.length} of ${Object.keys(SYSCTL_EXPECTED).length} sysctl protections are off`,
      {
        // A container cannot change most kernel.* settings; applying would look
        // successful while the read-back stayed wrong. Do not offer a fake fix.
        remediation: container ? undefined : "sysctl-hardening",
        evidence: clip(
          weak
            .map(([key, want]) => `${key}=${sysctl.get(key) ?? "?"} (want ${want})${container ? " [host-controlled]" : ""}`)
            .join(" · "),
        ),
      },
    );
  } else {
    add("kernel.sysctl", "kernel", "medium", "pass", "Kernel hardening", "ASLR, kptr/dmesg restrictions, rp_filter, syncookies and ptrace scope are set");
  }

  /* --------------------------------------------------------------- integrity */

  const keysBlob = value("authorized_keys");
  const keyBlocks = keysBlob.split(/^### /m).filter((block) => block.trim());
  const badPerms: string[] = [];
  for (const block of keyBlocks) {
    const header = block.split(/\r?\n/, 1)[0] ?? "";
    const path = header.split(" ")[0];
    const mode = /mode=(\d+)/.exec(header)?.[1];
    if (mode && mode !== "600") badPerms.push(`${path} (${mode})`);
  }
  if (keyBlocks.length === 0) {
    add("integrity.key-perms", "integrity", "high", "unknown", "SSH key permissions", privileged ? "no authorized_keys on this host" : "requires the root helper");
  } else if (badPerms.length > 0) {
    add("integrity.key-perms", "integrity", "high", "fail", "SSH key permissions", `authorized_keys is more permissive than 600: ${badPerms.join(", ")}`, {
      remediation: "key-permissions",
      evidence: badPerms.join(", "),
    });
  } else {
    add("integrity.key-perms", "integrity", "high", "pass", "SSH key permissions", `${keyBlocks.length} authorized_keys file(s) are 600`);
  }

  const worldWritable = lines("world_writable");
  if (worldWritable.length > 0) {
    add("integrity.world-writable", "integrity", "high", "fail", "World-writable config", `${worldWritable.length} world-writable file(s) under /etc`, {
      evidence: clip(worldWritable.slice(0, 6).join(", ")),
    });
  } else {
    add("integrity.world-writable", "integrity", "high", "pass", "World-writable config", "no world-writable files under /etc");
  }

  /* ------------------------------------------------------------- persistence */

  const cron = value("cron_all");
  const cronHits = cron
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .filter((line) => SUSPICIOUS_CRON.test(line));
  if (cronHits.length > 0) {
    add("persist.cron", "persistence", "high", "fail", "Scheduled job review", `${cronHits.length} cron entry makes a network call or decodes a payload`, {
      evidence: clip(cronHits.slice(0, 4).join(" · ")),
    });
  } else {
    add("persist.cron", "persistence", "high", "pass", "Scheduled job review", "no cron entry downloads or decodes anything");
  }

  if (value("rc_local") === "executable") {
    add("persist.rc-local", "persistence", "medium", "warn", "Legacy boot hook", "/etc/rc.local is executable", {
      evidence: "/etc/rc.local",
    });
  } else {
    add("persist.rc-local", "persistence", "medium", "pass", "Legacy boot hook", "no executable rc.local");
  }

  /* ------------------------------------------------------------------ guard */

  if (privileged) {
    add("guard.helper", "access", "high", "pass", "Root helper", "narrow nexus-priv helper is installed and answering");
  } else {
    add("guard.helper", "access", "high", "warn", "Root helper", "not installed — deep checks and enforcement are unavailable", {
      evidence: "install /usr/local/sbin/nexus-priv and /etc/sudoers.d/nexus-actions",
    });
  }

  // An old helper can still answer the basic guard probe while rejecting or
  // misunderstanding a subcommand this build now sends. Report the version gap
  // as its own fixable finding instead of letting actions fail one at a time.
  if (helper?.state === "outdated") {
    const installed = (helper.installedSha ?? "unreadable").slice(0, 12);
    add("guard.helper-version", "access", "high", "fail", "Root helper version", "installed helper is a different build than this app — privileged actions are refused until it is reinstalled", {
      remediation: "helper-refresh",
      evidence: `${helper.helperPath} ${installed} · expected ${helper.expectedSha.slice(0, 12)}`,
    });
  } else if (helper?.state === "ready") {
    add("guard.helper-version", "access", "high", "pass", "Root helper version", "installed helper matches the build this app ships");
  }

  const resident = value("resident_enforce");
  if (resident.trim()) {
    add("guard.resident", "persistence", "medium", "pass", "Resident enforcer", `systemd timer enforces: ${resident.trim().split(/\r?\n/).join(", ")}`);
  } else {
    add("guard.resident", "persistence", "medium", "warn", "Resident enforcer", "session-only — protection pauses when the app closes", {
      remediation: "resident-install",
    });
  }

  if (policyTampered) {
    add("guard.policy", "integrity", "critical", "fail", "Policy signature", "policy.json was modified outside the guard and enforcement is suspended");
  } else {
    add("guard.policy", "integrity", "critical", "pass", "Policy signature", `signed policy, mode ${policy.mode}`);
  }

  /* ------------------------------------------------------- integrity · drift */

  const nextBaseline: Record<string, string> = {};
  const drift: SecurityDrift[] = [];
  const now = Date.now();

  for (const line of lines("fim")) {
    const [hash, file] = line.split(/\s+/, 2);
    if (!hash || !file) continue;
    const key = `fim:${file}`;
    nextBaseline[key] = hash;
    const before = baseline[key];
    if (before && before !== hash) {
      const rule = FIM_SEVERITY.find((entry) => entry.match.test(file));
      drift.push({ key, before, after: hash, at: now });
      add(`integrity.drift${file}`, "integrity", rule?.severity ?? "medium", "fail", `Changed: ${rule?.title ?? file}`, `${file} changed since the last baseline`, {
        evidence: `${before.slice(0, 12)} → ${hash.slice(0, 12)}`,
      });
    }
  }

  const unitsHash = sha(lines("units").join("\n"));
  nextBaseline["meta:units"] = unitsHash;
  if (baseline["meta:units"] && baseline["meta:units"] !== unitsHash) {
    drift.push({ key: "meta:units", before: baseline["meta:units"], after: unitsHash, at: now });
    add("persist.new-units", "persistence", "high", "fail", "New systemd units", "the set of installed unit files changed since the last baseline", {
      evidence: clip(lines("units").slice(-8).join(", ")),
    });
  } else {
    add("persist.new-units", "persistence", "high", "pass", "New systemd units", "unit file set matches the baseline");
  }

  const suidHash = sha(lines("suid").join("\n"));
  nextBaseline["meta:suid"] = suidHash;
  if (baseline["meta:suid"] && baseline["meta:suid"] !== suidHash) {
    drift.push({ key: "meta:suid", before: baseline["meta:suid"], after: suidHash, at: now });
    add("integrity.suid-drift", "integrity", "high", "fail", "SUID set changed", "setuid binaries changed since the last baseline", {
      evidence: `${baseline["meta:suid"].slice(0, 12)} → ${suidHash.slice(0, 12)}`,
    });
  } else {
    add("integrity.suid-drift", "integrity", "high", "pass", "SUID set changed", "setuid set matches the baseline");
  }

  const keysHash = sha(keysBlob);
  nextBaseline["meta:authorized-keys"] = keysHash;
  if (baseline["meta:authorized-keys"] && baseline["meta:authorized-keys"] !== keysHash) {
    drift.push({ key: "meta:authorized-keys", before: baseline["meta:authorized-keys"], after: keysHash, at: now });
    add("integrity.authorized-keys", "integrity", "critical", "fail", "Authorized keys changed", "a new SSH key was trusted on this host", {
      evidence: `${baseline["meta:authorized-keys"].slice(0, 12)} → ${keysHash.slice(0, 12)}`,
    });
  } else {
    add("integrity.authorized-keys", "integrity", "critical", "pass", "Authorized keys changed", "authorized_keys matches the baseline");
  }

  if (!baseline["fim:/etc/passwd"]) {
    checks.push({
      id: "integrity.first-run",
      layer: "integrity",
      severity: "info",
      status: "pass",
      title: "Baseline recorded",
      detail: "first scan for this host — file fingerprints are now the reference",
    });
  }

  /* ------------------------------------------------------------- containment */

  const allow = new Set(policy.allowlist.map((entry) => entry.split("/")[0]));
  if (facts.peerIp) allow.add(facts.peerIp);
  const candidates: string[] = [];
  for (const line of lines("failed_ips")) {
    const match = /^(\d+)\s+(\S+)$/.exec(line.trim());
    if (!match) continue;
    const count = Number(match[1]);
    const address = match[2];
    if (count < policy.banThreshold) continue;
    if (allow.has(address)) continue;
    if (candidates.includes(address)) continue;
    candidates.push(address);
  }

  return { checks, drift, baseline: nextBaseline, candidates: candidates.slice(0, Math.max(0, policy.maxBansPerRun)) };
}
