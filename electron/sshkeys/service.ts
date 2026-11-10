import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { utils, type ParsedKey } from "ssh2";
import type {
  AuthorizedSshKey,
  ManagedSshKey,
  NexusEvent,
  SshKeyDeployResult,
  SshKeyEnforceResult,
  SshKeyEvent,
  SshKeyHostReport,
  SshKeyOverview,
  SshKeyPolicy,
} from "../../shared/types";
import { ConfigStore, configStore } from "../config";
import { nexusHome } from "../paths";
import { decryptSecret, encryptSecret, signPayload } from "../vault";
import { sshRunner } from "../ssh/collect";
import { runRemote } from "../ssh/probe";

interface StoredSshKey extends ManagedSshKey {
  privateKeyEnc?: string;
}

interface StoredSshKeyState {
  version: 1;
  keys: StoredSshKey[];
  policy: SshKeyPolicy;
  policySig: string;
  /** host id -> fingerprints the operator explicitly accepted. */
  trusted: Record<string, string[]>;
  reports: Record<string, SshKeyHostReport>;
  events: SshKeyEvent[];
}

const DEFAULT_POLICY: SshKeyPolicy = {
  enabled: true,
  intervalSec: 60,
  autoEnforce: false,
  updatedAt: 0,
};

const MAX_EVENTS = 80;
const MIN_INTERVAL = 30;
const MAX_INTERVAL = 86_400;

function cleanText(value: unknown, name: string, max = 80): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) throw new Error(`${name} is required`);
  if (cleaned.length > max) throw new Error(`${name} must be ${max} characters or fewer`);
  return cleaned;
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function fingerprintOfBlob(blob: Buffer): string {
  return `SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

export function fingerprintOfPublicKey(publicKey: string): string {
  const blob = publicKey.trim().split(/\s+/)[1];
  if (!blob) throw new Error("Public key has no key material");
  return fingerprintOfBlob(Buffer.from(blob, "base64"));
}

function expandHome(value: string): string {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function loginKeyPath(keyPath?: string): string | undefined {
  if (keyPath?.trim()) {
    const resolved = expandHome(keyPath.trim());
    return fs.existsSync(resolved) ? resolved : undefined;
  }
  for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const candidate = path.join(os.homedir(), ".ssh", name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The key the configured host logs in with, so enforcement can never remove it. */
function loginFingerprint(host: { authMode: string; keyPath?: string }): string | undefined {
  if (host.authMode !== "key") return undefined;
  const file = loginKeyPath(host.keyPath);
  if (!file) return undefined;
  try {
    const parsed = utils.parseKey(fs.readFileSync(file));
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key || !("getPublicSSH" in key)) return undefined;
    return fingerprintOfBlob((key as ParsedKey).getPublicSSH());
  } catch {
    return undefined;
  }
}

function emptyReport(host: { id: string; label: string; host: string; username: string }): SshKeyHostReport {
  return {
    hostId: host.id,
    label: host.label,
    host: host.host,
    username: host.username,
    path: "~/.ssh/authorized_keys",
    exists: false,
    scannedAt: 0,
    keys: [],
    managed: 0,
    trusted: 0,
    unknown: 0,
  };
}

function parseAuthorizedKeys(
  content: string,
  managed: Map<string, StoredSshKey>,
  trusted: Set<string>,
  previous: Map<string, AuthorizedSshKey>,
  now: number,
): AuthorizedSshKey[] {
  const found = new Map<string, AuthorizedSshKey>();
  const keyLine = /(?:^|\s)(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-[A-Za-z0-9.-]+|sk-[A-Za-z0-9@._-]+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$/;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = keyLine.exec(line);
    if (!match) continue;
    const [, type, material, comment = ""] = match;
    let blob: Buffer;
    try {
      blob = Buffer.from(material, "base64");
    } catch {
      continue;
    }
    if (blob.length < 16) continue;
    const fingerprint = fingerprintOfBlob(blob);
    if (found.has(fingerprint)) continue;
    const owner = managed.get(fingerprint);
    const source = owner ? "managed" : trusted.has(fingerprint) ? "trusted" : "unknown";
    found.set(fingerprint, {
      fingerprint,
      type,
      comment: comment.trim(),
      publicKey: `${type} ${material}${comment.trim() ? ` ${comment.trim()}` : ""}`,
      source,
      ...(owner ? { keyId: owner.id, owner: owner.owner } : {}),
      firstSeenAt: previous.get(fingerprint)?.firstSeenAt ?? now,
    });
  }
  return [...found.values()];
}

function countSources(keys: AuthorizedSshKey[]): { managed: number; trusted: number; unknown: number } {
  return {
    managed: keys.filter((key) => key.source === "managed").length,
    trusted: keys.filter((key) => key.source === "trusted").length,
    unknown: keys.filter((key) => key.source === "unknown").length,
  };
}

function parsePairLines(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index);
    if (/^[a-z][a-z0-9_]*$/i.test(key)) result[key] = line.slice(index + 1);
  }
  return result;
}

function publicKey(key: StoredSshKey): ManagedSshKey {
  const { privateKeyEnc: _privateKeyEnc, ...rest } = key;
  return rest;
}

export class SshKeyService {
  private running = false;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private initial: NodeJS.Timeout | null = null;
  private emit: ((event: NexusEvent) => void) | null = null;

  constructor(private readonly store: ConfigStore = configStore) {}

  bindEmit(emit: (event: NexusEvent) => void): void {
    this.emit = emit;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.initial) clearTimeout(this.initial);
    if (this.timer) clearInterval(this.timer);
    this.initial = null;
    this.timer = null;
  }

  private schedule(): void {
    if (this.initial) clearTimeout(this.initial);
    if (this.timer) clearInterval(this.timer);
    const state = this.read();
    const interval = Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, state.policy.intervalSec)) * 1000;
    // Let the desktop window and MCP handshake finish first. Timers are unref'd
    // so a headless MCP process can still exit when its stdin closes.
    this.initial = setTimeout(() => {
      void this.tick();
    }, 5_000);
    this.initial.unref?.();
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    this.timer.unref?.();
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    const data = this.read();
    if (!data.policy.enabled) return;
    this.busy = true;
    try {
      for (const host of this.store.sshHosts()) {
        try {
          const report = await this.scanHost(host, data);
          if (data.policy.autoEnforce && !report.error && report.unknown > 0) {
            try {
              await this.enforceReport(host, data, report);
            } catch (error) {
              this.record(data, "error", false, `Auto-enforcement refused on ${host.label}: ${this.message(error)}`, host.id, host.label);
            }
          }
        } catch (error) {
          const report: SshKeyHostReport = {
            ...emptyReport(host),
            scannedAt: Date.now(),
            error: this.message(error),
          };
          data.reports[host.id] = report;
          this.record(data, "error", false, `Scan failed on ${host.label}: ${report.error}`, host.id, host.label);
          this.persist(data);
        }
      }
    } finally {
      this.busy = false;
      this.emitOverview();
    }
  }

  overview(): SshKeyOverview {
    const data = this.read();
    const hosts = this.store.sshHosts().map((host) => {
      const previous = data.reports[host.id];
      return {
        ...(previous ?? emptyReport(host)),
        hostId: host.id,
        label: host.label,
        host: host.host,
        username: host.username,
        loginFingerprint: previous?.loginFingerprint ?? loginFingerprint(host),
      };
    });
    return {
      running: this.running,
      policy: data.policy,
      keys: data.keys.map(publicKey).sort((left, right) => right.createdAt - left.createdAt),
      hosts,
      events: data.events,
    };
  }

  generate(input: { label?: unknown; owner?: unknown }): SshKeyOverview {
    const label = cleanText(input.label, "Key label", 64);
    const owner = cleanText(input.owner ?? "operator", "Owner", 64);
    const data = this.read();
    const id = crypto.randomUUID();
    const generated = utils.generateKeyPairSync("ed25519");
    const comment = `nexus/${owner}/${label}`.replace(/[^\w .@/-]+/g, "-").replace(/\s+/g, "-");
    const fingerprint = fingerprintOfPublicKey(generated.public);
    const now = Date.now();
    data.keys.push({
      id,
      label,
      owner,
      comment,
      algorithm: "ssh-ed25519",
      fingerprint,
      publicKey: `${generated.public} ${comment}`,
      createdAt: now,
      status: "active",
      hosts: [],
      privateKeyEnc: encryptSecret(generated.private),
    });
    this.record(data, "generate", true, `Generated ${label} (${fingerprint.slice(0, 20)}…) for ${owner}`);
    this.persist(data);
    this.emitOverview();
    return this.overview();
  }

  async deploy(hostRef: string, keyRef: string): Promise<SshKeyDeployResult> {
    const host = this.requireHost(hostRef);
    const data = this.read();
    const key = this.requireKey(data, keyRef);
    if (key.status !== "active") throw new Error(`${key.label} is revoked and cannot be deployed`);
    const line = key.publicKey;
    const keyB64 = line.split(/\s+/)[1];
    if (!keyB64) throw new Error("Managed key has no public key material");
    const script = [
      "set -eu",
      "umask 077",
      'F="$HOME/.ssh/authorized_keys"',
      "mkdir -p \"$HOME/.ssh\"",
      "chmod 700 \"$HOME/.ssh\"",
      `LINE=$(printf %s '${base64(line)}' | base64 -d)`,
      `KEYB64='${keyB64}'`,
      "STATE=present",
      'if [ ! -f "$F" ] || ! grep -Fq -- "$KEYB64" "$F"; then',
      '  if [ -f "$F" ]; then cp -p "$F" "$F.nexus-$(date +%s).bak"; fi',
      '  printf \'%s\\n\' "$LINE" >> "$F"',
      "  STATE=added",
      "fi",
      'chmod 600 "$F"',
      'MODE=$(stat -c %a "$F" 2>/dev/null || stat -f %Lp "$F" 2>/dev/null || echo "?")',
      'echo "state=$STATE"',
      'echo "path=$F"',
      'echo "mode=$MODE"',
    ].join("\n");
    const result = await runRemote(sshRunner(this.store, host.id, 30_000), script, "bash");
    if (!result.ok) throw new Error(`Deploy to ${host.label} failed: ${(result.stderr || result.stdout).trim().slice(0, 1_000)}`);
    const parsed = parsePairLines(result.stdout);
    const file = this.ensurePrivateFile(key, data);
    this.store.saveSshHost({
      id: host.id,
      label: host.label,
      host: host.host,
      port: host.port,
      username: host.username,
      authMode: "key",
      keyPath: file,
      color: host.color,
      vncPort: host.vncPort,
    });
    key.hosts = [...new Set([...key.hosts, host.id])];
    key.lastDeployedAt = Date.now();
    this.record(data, "deploy", true, `Deployed ${key.label} to ${host.label} (${parsed.state ?? "present"})`, host.id, host.label);
    this.persist(data);
    this.emitOverview();
    return {
      hostId: host.id,
      host: host.label,
      keyId: key.id,
      fingerprint: key.fingerprint,
      path: parsed.path ?? "~/.ssh/authorized_keys",
      mode: parsed.mode,
      added: parsed.state === "added",
      output: result.stdout.trim(),
    };
  }

  async scan(hostRef: string): Promise<SshKeyHostReport> {
    const host = this.requireHost(hostRef);
    const data = this.read();
    const report = await this.scanHost(host, data);
    this.persist(data);
    this.emitOverview();
    return report;
  }

  async trust(hostRef: string, fingerprints?: string[]): Promise<SshKeyHostReport> {
    const host = this.requireHost(hostRef);
    const data = this.read();
    // Trust must never accept a stale scan captured before an operator changed
    // the file. Re-read the host first, exactly like enforcement does.
    const report = await this.scanHost(host, data);
    if (report.error) throw new Error(`Cannot trust keys while the scan is failing: ${report.error}`);
    const requested = Array.isArray(fingerprints) ? fingerprints.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim()) : [];
    const eligible = report.keys.filter((key) => key.source === "unknown" && (requested.length === 0 || requested.includes(key.fingerprint)));
    if (eligible.length === 0) throw new Error("No unmanaged keys on this host to trust");
    const trusted = new Set(data.trusted[host.id] ?? []);
    for (const key of eligible) trusted.add(key.fingerprint);
    data.trusted[host.id] = [...trusted];
    for (const key of report.keys) {
      if (trusted.has(key.fingerprint) && !key.keyId) key.source = "trusted";
    }
    Object.assign(report, countSources(report.keys));
    data.reports[host.id] = report;
    this.record(data, "trust", true, `Trusted ${eligible.length} key${eligible.length === 1 ? "" : "s"} on ${host.label}`, host.id, host.label);
    this.persist(data);
    this.emitOverview();
    return report;
  }

  async enforce(hostRef: string, confirm: boolean): Promise<SshKeyEnforceResult> {
    if (!confirm) throw new Error("Explicit confirmation is required to remove unmanaged keys");
    const host = this.requireHost(hostRef);
    const data = this.read();
    const report = await this.scanHost(host, data);
    if (report.error) throw new Error(`Refusing enforcement because the scan failed: ${report.error}`);
    const result = await this.enforceReport(host, data, report);
    this.persist(data);
    this.emitOverview();
    return result;
  }

  setPolicy(patch: Record<string, unknown>): SshKeyPolicy {
    const data = this.read();
    if (typeof patch.enabled === "boolean") data.policy.enabled = patch.enabled;
    if (typeof patch.autoEnforce === "boolean") data.policy.autoEnforce = patch.autoEnforce;
    if (patch.intervalSec !== undefined) {
      const interval = Number(patch.intervalSec);
      if (!Number.isInteger(interval) || interval < MIN_INTERVAL || interval > MAX_INTERVAL) {
        throw new Error(`Watcher interval must be ${MIN_INTERVAL}–${MAX_INTERVAL} seconds`);
      }
      data.policy.intervalSec = interval;
    }
    data.policy.updatedAt = Date.now();
    this.record(
      data,
      "policy",
      true,
      `Policy updated: watcher ${data.policy.enabled ? "enabled" : "paused"}, auto-enforce ${data.policy.autoEnforce ? "on" : "off"}, every ${data.policy.intervalSec}s`,
    );
    this.persist(data);
    if (this.running) this.schedule();
    this.emitOverview();
    return data.policy;
  }

  async revoke(keyRef: string, confirm: boolean): Promise<SshKeyOverview> {
    if (!confirm) throw new Error("Explicit confirmation is required to revoke an SSH key");
    const data = this.read();
    const key = this.requireKey(data, keyRef);
    if (key.status === "retired") return this.overview();
    const keyB64 = key.publicKey.split(/\s+/)[1];
    if (!keyB64) throw new Error("Managed key has no public key material");
    const failures: string[] = [];
    const remaining: string[] = [];
    for (const hostId of key.hosts) {
      const host = this.store.sshHost(hostId);
      if (!host) continue;
      const script = [
        "set -eu",
        'F="$HOME/.ssh/authorized_keys"',
        `KEYB64='${keyB64}'`,
        "REMOVED=0",
        "BACKUP=",
        'if [ -f "$F" ]; then',
        '  TMP=$(mktemp "${TMPDIR:-/tmp}/nexus-revoke.XXXXXX")',
        '  trap \'rm -f "$TMP"\' EXIT',
        '  while IFS= read -r line || [ -n "$line" ]; do',
        '    if printf \'%s\\n\' "$line" | grep -Fq -- "$KEYB64"; then REMOVED=$((REMOVED+1)); else printf \'%s\\n\' "$line" >> "$TMP"; fi',
        "  done < \"$F\"",
        "  if [ \"$REMOVED\" -gt 0 ]; then",
        '    BACKUP="$F.nexus-$(date +%s).bak"',
        '    cp -p "$F" "$BACKUP"',
        '    cat "$TMP" > "$F"',
        '    chmod 600 "$F"',
        "  fi",
        "fi",
        'echo "removed=$REMOVED"',
        'echo "backup=$BACKUP"',
      ].join("\n");
      const result = await runRemote(sshRunner(this.store, host.id, 30_000), script, "bash");
      if (!result.ok) {
        failures.push(`${host.label}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
        remaining.push(host.id);
        continue;
      }
      this.record(data, "revoke", true, `Removed ${key.label} from ${host.label}`, host.id, host.label);
    }
    key.hosts = remaining;
    if (failures.length > 0) {
      this.record(data, "revoke", false, `Revocation incomplete for ${key.label}: ${failures.join("; ")}`);
      this.persist(data);
      this.emitOverview();
      throw new Error(`Revocation incomplete; the key is still active on ${failures.join("; ")}`);
    }
    for (const [hostId, values] of Object.entries(data.trusted)) {
      data.trusted[hostId] = values.filter((fingerprint) => fingerprint !== key.fingerprint);
    }
    for (const report of Object.values(data.reports)) {
      report.keys = report.keys.filter((entry) => entry.fingerprint !== key.fingerprint);
      Object.assign(report, countSources(report.keys));
    }
    key.status = "retired";
    delete key.privateKeyEnc;
    const privateFile = path.join(nexusHome(), "sshkeys", `${key.id}.key`);
    try {
      fs.rmSync(privateFile, { force: true });
    } catch {
      /* no materialised private key */
    }
    this.record(data, "revoke", true, `Revoked ${key.label} (${key.fingerprint.slice(0, 20)}…)`);
    this.persist(data);
    this.emitOverview();
    return this.overview();
  }

  private async scanHost(host: { id: string; label: string; host: string; username: string; authMode: string; keyPath?: string }, data: StoredSshKeyState): Promise<SshKeyHostReport> {
    const current = loginFingerprint(host);
    if (current) {
      const trusted = new Set(data.trusted[host.id] ?? []);
      if (!trusted.has(current)) {
        trusted.add(current);
        data.trusted[host.id] = [...trusted];
      }
    }
    const script = [
      "set -u",
      'F="$HOME/.ssh/authorized_keys"',
      'if [ ! -e "$F" ]; then echo "missing=1"; echo "path=$F"; exit 0; fi',
      'if [ ! -f "$F" ]; then echo "error=authorized_keys is not a regular file"; exit 0; fi',
      'MODE=$(stat -c %a "$F" 2>/dev/null || stat -f %Lp "$F" 2>/dev/null || echo "?")',
      'echo "path=$F"',
      'echo "mode=$MODE"',
      'printf "data="',
      'base64 "$F" | tr -d "\\n"',
      'printf "\\n"',
    ].join("\n");
    const result = await runRemote(sshRunner(this.store, host.id, 30_000), script, "bash");
    const now = Date.now();
    const previous = data.reports[host.id];
    const previousByFp = new Map((previous?.keys ?? []).map((key) => [key.fingerprint, key]));
    if (!result.ok) {
      const report: SshKeyHostReport = {
        ...(previous ?? emptyReport(host)),
        hostId: host.id,
        label: host.label,
        host: host.host,
        username: host.username,
        scannedAt: now,
        loginFingerprint: current,
        error: (result.stderr || result.stdout || "scan failed").trim().slice(0, 1_000),
      };
      data.reports[host.id] = report;
      if (previous?.error !== report.error) {
        this.record(data, "error", false, `Scan failed on ${host.label}: ${report.error}`, host.id, host.label);
      }
      this.persist(data);
      return report;
    }
    const parsed = parsePairLines(result.stdout);
    if (parsed.error) {
      const report: SshKeyHostReport = {
        ...(previous ?? emptyReport(host)),
        hostId: host.id,
        label: host.label,
        host: host.host,
        username: host.username,
        scannedAt: now,
        loginFingerprint: current,
        error: parsed.error,
      };
      data.reports[host.id] = report;
      if (previous?.error !== report.error) this.record(data, "error", false, `Scan failed on ${host.label}: ${report.error}`, host.id, host.label);
      this.persist(data);
      return report;
    }
    const missing = parsed.missing === "1";
    const managedKeys = new Map(data.keys.filter((key) => key.status === "active").map((key) => [key.fingerprint, key]));
    const trusted = new Set(data.trusted[host.id] ?? []);
    const content = missing || !parsed.data ? "" : Buffer.from(parsed.data, "base64").toString("utf8");
    const keys = missing ? [] : parseAuthorizedKeys(content, managedKeys, trusted, previousByFp, now);
    const report: SshKeyHostReport = {
      hostId: host.id,
      label: host.label,
      host: host.host,
      username: host.username,
      path: parsed.path ?? "~/.ssh/authorized_keys",
      mode: parsed.mode,
      exists: !missing,
      scannedAt: now,
      keys,
      ...countSources(keys),
      loginFingerprint: current,
    };
    data.reports[host.id] = report;
    if (!previous || previous.unknown !== report.unknown || previous.error) {
      const detail = !report.exists
        ? "authorized_keys does not exist yet"
        : `${report.managed} managed, ${report.trusted} trusted, ${report.unknown} unmanaged`;
      this.record(data, "scan", true, `Scanned ${host.label}: ${detail}`, host.id, host.label);
    }
    this.persist(data);
    return report;
  }

  private async enforceReport(
    host: { id: string; label: string; host: string; username: string },
    data: StoredSshKeyState,
    report: SshKeyHostReport,
  ): Promise<SshKeyEnforceResult> {
    const unknown = report.keys.filter((key) => key.source === "unknown");
    if (unknown.length === 0) {
      return { hostId: host.id, host: host.label, removed: [], kept: report.keys.length, output: "No unmanaged keys present" };
    }
    const allowed = report.keys.filter((key) => key.source !== "unknown");
    if (allowed.length === 0) {
      throw new Error("Refusing enforcement: no managed or trusted key would remain, which would lock out every login");
    }
    const allowedBlobs = allowed.map((key) => key.publicKey.split(/\s+/)[1]).filter(Boolean);
    const allowedB64 = base64(allowedBlobs.join("\n"));
    const script = [
      "set -eu",
      'F="$HOME/.ssh/authorized_keys"',
      `ALLOWED=$(printf %s '${allowedB64}' | base64 -d)`,
      "KEPT=0",
      "REMOVED=0",
      'if [ ! -f "$F" ]; then echo "removed=0"; echo "kept=0"; exit 0; fi',
      'TMP=$(mktemp "${TMPDIR:-/tmp}/nexus-enforce.XXXXXX")',
      'trap \'rm -f "$TMP"\' EXIT',
      'while IFS= read -r line || [ -n "$line" ]; do',
      '  KEY=$(printf \'%s\\n\' "$line" | sed -nE \'s/.*(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-[^ ]+|sk-[^ ]+) ([A-Za-z0-9+\\/=]+).*/\\2/p\' | head -n 1)',
      '  if [ -n "$KEY" ] && ! printf \'%s\\n\' "$ALLOWED" | grep -Fqx -- "$KEY"; then',
      "    REMOVED=$((REMOVED+1))",
      "    continue",
      "  fi",
      '  [ -n "$KEY" ] && KEPT=$((KEPT+1))',
      '  printf \'%s\\n\' "$line" >> "$TMP"',
      'done < "$F"',
      'if [ "$KEPT" -eq 0 ]; then echo "refused=no keys remain" >&2; exit 3; fi',
      'BACKUP="$F.nexus-$(date +%s).bak"',
      'cp -p "$F" "$BACKUP"',
      'cat "$TMP" > "$F"',
      'chmod 600 "$F"',
      'ls -1t "$F".nexus-*.bak 2>/dev/null | tail -n +6 | while read -r old; do rm -f "$old"; done || true',
      'echo "removed=$REMOVED"',
      'echo "kept=$KEPT"',
      'echo "backup=$BACKUP"',
    ].join("\n");
    const result = await runRemote(sshRunner(this.store, host.id, 30_000), script, "bash");
    if (!result.ok) throw new Error(`Enforcement on ${host.label} failed: ${(result.stderr || result.stdout).trim().slice(0, 1_000)}`);
    const parsed = parsePairLines(result.stdout);
    report.keys = allowed;
    Object.assign(report, countSources(report.keys));
    data.reports[host.id] = report;
    const removed = Number(parsed.removed ?? unknown.length);
    const kept = Number(parsed.kept ?? allowed.length);
    this.record(data, "enforce", true, `Removed ${removed} unmanaged key${removed === 1 ? "" : "s"} from ${host.label}; ${kept} kept`, host.id, host.label);
    this.persist(data);
    return {
      hostId: host.id,
      host: host.label,
      removed: unknown.map((key) => key.fingerprint),
      kept,
      ...(parsed.backup ? { backup: parsed.backup } : {}),
      output: result.stdout.trim(),
    };
  }

  private ensurePrivateFile(key: StoredSshKey, data: StoredSshKeyState): string {
    if (!key.privateKeyEnc) throw new Error(`${key.label} has no private key material`);
    const dir = path.join(nexusHome(), "sshkeys");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${key.id}.key`);
    const pem = decryptSecret(key.privateKeyEnc);
    fs.writeFileSync(file, pem, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
      fs.chmodSync(dir, 0o700);
    } catch {
      /* Windows ACLs apply inside the per-user profile. */
    }
    // Keep the vault as the source of truth if a later build rotates it.
    this.persist(data);
    return file;
  }

  private requireHost(ref: string): { id: string; label: string; host: string; port: number; username: string; authMode: string; keyPath?: string; color: string; vncPort?: number } {
    const value = cleanText(ref, "Linux host", 200);
    const host = this.store.sshHost(value);
    if (!host) throw new Error(`No Linux host matches "${value}". Configure one in Nexus PVE → Linux hosts.`);
    return host;
  }

  private requireKey(data: StoredSshKeyState, ref: string): StoredSshKey {
    const value = cleanText(ref, "SSH key", 200).toLowerCase();
    const key = data.keys.find(
      (entry) =>
        entry.id === value ||
        entry.fingerprint.toLowerCase() === value ||
        entry.label.toLowerCase() === value,
    );
    if (!key) throw new Error(`No managed SSH key matches "${ref}"`);
    return key;
  }

  private record(
    data: StoredSshKeyState,
    kind: SshKeyEvent["kind"],
    ok: boolean,
    message: string,
    hostId?: string,
    host?: string,
  ): void {
    data.events.unshift({ at: Date.now(), kind, ok, message, ...(hostId ? { hostId } : {}), ...(host ? { host } : {}) });
    if (data.events.length > MAX_EVENTS) data.events.length = MAX_EVENTS;
  }

  private emitOverview(): void {
    if (!this.emit) return;
    try {
      this.emit({ type: "sshkeys", sshKeys: this.overview() });
    } catch {
      /* an IPC window may be closing */
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private read(): StoredSshKeyState {
    const empty: StoredSshKeyState = {
      version: 1,
      keys: [],
      policy: { ...DEFAULT_POLICY, updatedAt: Date.now() },
      // Never touch the vault merely by opening the panel or starting the
      // watcher: the shared master key may be seeded after the process starts.
      policySig: "",
      trusted: {},
      reports: {},
      events: [],
    };
    let raw: Partial<StoredSshKeyState> = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file(), "utf8")) as Partial<StoredSshKeyState>;
    } catch {
      return empty;
    }
    const policy = raw.policy && typeof raw.policy === "object" ? { ...DEFAULT_POLICY, ...raw.policy } : { ...DEFAULT_POLICY };
    const expected = signPayload(JSON.stringify(policy));
    const validPolicy = typeof raw.policySig === "string" && raw.policySig === expected;
    const state: StoredSshKeyState = {
      version: 1,
      keys: Array.isArray(raw.keys) ? raw.keys.filter((key): key is StoredSshKey => Boolean(key && typeof key === "object" && typeof (key as StoredSshKey).id === "string")) : [],
      policy: validPolicy ? policy : { ...DEFAULT_POLICY, updatedAt: Date.now() },
      policySig: validPolicy ? raw.policySig! : "",
      trusted: raw.trusted && typeof raw.trusted === "object" ? raw.trusted : {},
      reports: raw.reports && typeof raw.reports === "object" ? raw.reports : {},
      events: Array.isArray(raw.events) ? raw.events.slice(0, MAX_EVENTS) : [],
    };
    if (!validPolicy) {
      state.events.unshift({
        at: Date.now(),
        kind: "policy",
        ok: false,
        message: "SSH-key policy signature was invalid; reset to monitor-only defaults",
      });
    }
    return state;
  }

  private persist(data: StoredSshKeyState): void {
    const root = nexusHome();
    const dir = path.join(root, "sshkeys");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    data.policySig = signPayload(JSON.stringify(data.policy));
    data.events = data.events.slice(0, MAX_EVENTS);
    const file = this.file();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
      fs.chmodSync(dir, 0o700);
    } catch {
      /* Windows ACLs */
    }
  }

  private file(): string {
    return path.join(nexusHome(), "sshkeys", "state.json");
  }
}

export const sshKeys = new SshKeyService();
