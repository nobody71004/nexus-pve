import type { ConfigStore, StoredSshHost } from "../config";
import type { SshHealth, SshHostInput, SshHostSummary, SshSnapshot, SshTestResult } from "../../shared/types";
import { dropSamples, parseProbe, recordSample, runRemote, summarizeTest, toRunner } from "./probe";

const CACHE_MS = 1500;
const cache = new Map<string, { at: number; value: SshSnapshot }>();

export function listSshHosts(store: ConfigStore): SshHostSummary[] {
  return store.sshHosts().map((host) => store.publicSshHost(host));
}

/**
 * Liveness for the whole fleet. A full probe reads a dozen files and is far too
 * heavy to run per card, so each host gets one authenticated command instead:
 * enough to prove sshd, auth and shell work, cheap enough to poll alongside the
 * active snapshot. Failures stay per-host so one dead box cannot hide the rest.
 */
export async function probeSshHealth(store: ConfigStore): Promise<SshHealth[]> {
  return Promise.all(
    store.sshHosts().map(async (stored): Promise<SshHealth> => {
      const password = stored.authMode === "password" ? store.sshSecretFor(stored.id) : undefined;
      if (stored.authMode === "password" && !password) {
        return { id: stored.id, health: "offline", latencyMs: 0, error: "stored password is missing" };
      }
      const result = await runRemote(toRunner(store.publicSshHost(stored), 12_000, password), "true\n", "bash");
      const ok = result.ok && result.code === 0;
      return {
        id: stored.id,
        health: ok ? "online" : "offline",
        latencyMs: result.latencyMs,
        error: ok ? undefined : result.stderr.trim().split(/\r?\n/).slice(-1)[0] || "unreachable",
      };
    }),
  );
}

export function saveSshHost(store: ConfigStore, input: SshHostInput): SshHostSummary {
  const saved = store.saveSshHost(input);
  cache.delete(saved.id);
  dropSamples(saved.id);
  return saved;
}

export function removeSshHost(store: ConfigStore, id: string): void {
  const host = store.sshHost(id);
  store.removeSshHost(id);
  if (host) {
    cache.delete(host.id);
    dropSamples(host.id);
  }
}

function candidateSummary(input: SshHostInput): SshHostSummary {
  return {
    id: input.id ?? "probe",
    label: input.label?.trim() || input.host,
    host: (input.host || "").trim(),
    port: Number(input.port) > 0 ? Number(input.port) : 22,
    username: (input.username || "").trim(),
    authMode: input.authMode === "password" ? "password" : "key",
    keyPath: input.keyPath?.trim() || undefined,
    hasSecret: Boolean(input.password),
    color: "#38f2ff",
    createdAt: 0,
  };
}

/** Validate a candidate connection without saving it. */
export async function testSshHost(input: SshHostInput): Promise<SshTestResult> {
  const candidate = candidateSummary(input);
  if (!candidate.host || !candidate.username) {
    return { ok: false, latencyMs: 0, error: "Host and username are required" };
  }
  if (candidate.authMode === "password" && !input.password) {
    return { ok: false, latencyMs: 0, error: "Password is required for password authentication" };
  }
  const result = await runRemote(toRunner(candidate, 25_000, input.password));
  const snapshot = parseProbe(candidate, result.stdout, { latencyMs: result.latencyMs, stderr: result.stderr, ok: result.ok });
  return summarizeTest(result, snapshot);
}

function credentials(store: ConfigStore, host: StoredSshHost): string | undefined {
  return host.authMode === "password" ? store.sshSecretFor(host.id) : undefined;
}

/** Live telemetry for one configured host, with a short cache for poll bursts. */
export async function collectSshSnapshot(store: ConfigStore, id: string): Promise<SshSnapshot> {
  const host = store.sshHost(id);
  if (!host) throw new Error(`Unknown Linux host: ${id}`);
  const hit = cache.get(host.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const password = credentials(store, host);
  if (host.authMode === "password" && !password) throw new Error(`${host.label}: stored password is missing`);

  const result = await runRemote(toRunner(store.publicSshHost(host), 30_000, password));
  const snapshot = parseProbe(store.publicSshHost(host), result.stdout, {
    latencyMs: result.latencyMs,
    stderr: result.stderr,
    ok: result.ok && /@@end/.test(result.stdout),
  });
  if (!snapshot.status.error && result.ok === false) snapshot.status.error = "ssh exited with an error";
  snapshot.samples = recordSample(host.id, snapshot);
  if (snapshot.status.health === "online") store.touchSshHost(host.id);
  cache.set(host.id, { at: Date.now(), value: snapshot });
  return snapshot;
}

export interface SshExecResult {
  host: string;
  ok: boolean;
  code: number | null;
  latencyMs: number;
  stdout: string;
  stderr: string;
}

const SAFE_COMMAND = /^[A-Za-z0-9 _./:@%+=\-,]+$/;

/**
 * Arbitrary remote commands are the one genuinely unbounded capability here, so
 * the tool layer marks them destructive and this guard rejects obvious shell
 * metacharacters unless the caller explicitly opted into a shell pipeline.
 */
export async function execOnHost(
  store: ConfigStore,
  id: string,
  command: string,
  options: { allowShell?: boolean; timeoutMs?: number } = {},
): Promise<SshExecResult> {
  const host = store.sshHost(id);
  if (!host) throw new Error(`Unknown Linux host: ${id}`);
  const trimmed = command.trim();
  if (!trimmed) throw new Error("command is required");
  if (trimmed.length > 2000) throw new Error("command is too long");
  if (!options.allowShell && !SAFE_COMMAND.test(trimmed)) {
    throw new Error('Command contains shell metacharacters. Re-run with "shell": true if that is intended.');
  }
  const password = credentials(store, host);
  const result = await runRemote(toRunner(store.publicSshHost(host), options.timeoutMs ?? 45_000, password), `${trimmed}\n`, "bash");
  return {
    host: host.label,
    ok: result.ok,
    code: result.code,
    latencyMs: result.latencyMs,
    stdout: result.stdout.slice(0, 60_000),
    stderr: result.stderr.slice(0, 8_000),
  };
}

export function sshRunner(store: ConfigStore, id: string, timeoutMs = 45_000) {
  const host = store.sshHost(id);
  if (!host) throw new Error(`Unknown Linux host: ${id}`);
  return toRunner(store.publicSshHost(host), timeoutMs, credentials(store, host));
}
