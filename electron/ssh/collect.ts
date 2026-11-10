import type { ConfigStore, StoredHost, StoredSshHost } from "../config";
import type { GpuTelemetry, NodeStats, SensorReading, SshHealth, SshHostInput, SshHostSummary, SshSnapshot, SshTestResult } from "../../shared/types";
import { cpuPackageTemp } from "../../shared/sensors";
import { clearGpuHistory, GPU_PROBE, parseGpuProbe, recordGpuHistory } from "./gpu";
import { dropSamples, parseProbe, recordSample, runRemote, summarizeTest, toRunner } from "./probe";

const CACHE_MS = 1500;
const cache = new Map<string, { at: number; value: SshSnapshot }>();
const GPU_CACHE_MS = 4000;
const gpuCache = new Map<string, { at: number; value: { gpus: GpuTelemetry[]; error?: string } }>();
const PVE_TEMP_CACHE_MS = 15_000;
const pveTempCache = new Map<string, { at: number; value: SensorReading[] }>();

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
  gpuCache.delete(saved.id);
  pveTempCache.delete(saved.id);
  clearGpuHistory(saved.id);
  dropSamples(saved.id);
  return saved;
}

export function removeSshHost(store: ConfigStore, id: string): void {
  const host = store.sshHost(id);
  store.removeSshHost(id);
  if (host) {
    cache.delete(host.id);
    gpuCache.delete(host.id);
    pveTempCache.delete(host.id);
    clearGpuHistory(host.id);
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
  if (snapshot.status.health === "online") snapshot.gpus = recordGpuHistory(host.id, snapshot.gpus);
  snapshot.samples = recordSample(host.id, snapshot);
  if (snapshot.status.health === "online") store.touchSshHost(host.id);
  cache.set(host.id, { at: Date.now(), value: snapshot });
  return snapshot;
}

export interface SshGpuResult {
  gpus: GpuTelemetry[];
  error?: string;
}

/**
 * Live GPU counters are a separate, cheap probe because a Proxmox node has no
 * API endpoint that can run nvidia-smi. The dedicated probe keeps full host
 * telemetry and node telemetry from paying for each other.
 */
export async function collectSshGpuTelemetry(store: ConfigStore, id: string): Promise<SshGpuResult> {
  const host = store.sshHost(id);
  if (!host) throw new Error(`Unknown Linux host: ${id}`);
  const hit = gpuCache.get(host.id);
  if (hit && Date.now() - hit.at < GPU_CACHE_MS) return hit.value;

  const password = credentials(store, host);
  if (host.authMode === "password" && !password) {
    return { gpus: [], error: `${host.label}: stored password is missing` };
  }
  const result = await runRemote(toRunner(store.publicSshHost(host), 18_000, password), GPU_PROBE);
  const parsed = parseGpuProbe(result.stdout);
  const hasSection = /(^|\r?\n)@@gpu(\r?\n|$)/.test(result.stdout);
  const failure = !result.ok && !parsed.gpus.length
    ? result.stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) || "GPU probe failed"
    : !hasSection && !parsed.gpus.length
      ? "GPU probe returned no data (is bash available on this host?)"
      : undefined;
  const error = parsed.error ?? failure;
  // A failed probe must not erase a good trend; a successful empty probe does.
  const gpus = failure ? parsed.gpus : recordGpuHistory(host.id, parsed.gpus);
  const value: SshGpuResult = { gpus, ...(error ? { error } : {}) };
  gpuCache.set(host.id, { at: Date.now(), value });
  return value;
}

function cleanHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function loopback(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

function pveEndpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").split(":")[0];
  }
}

/**
 * A Proxmox node cannot be sampled through its API for GPU counters. Match it
 * to an explicitly configured SSH host by node name, node address or the only
 * configured host for a standalone endpoint. The node card explains the miss
 * instead of showing a zero that looks like an idle GPU.
 */
export function findSshHostForPveNode(
  store: ConfigStore,
  endpoint: StoredHost,
  node: NodeStats,
): StoredSshHost | undefined {
  const addresses = new Set<string>();
  addresses.add(cleanHost(node.node));
  for (const nic of node.network) {
    const address = nic.address ? cleanHost(nic.address) : "";
    const cidr = nic.cidr ? cleanHost(nic.cidr.split("/")[0]) : "";
    if (address && !loopback(address)) addresses.add(address);
    if (cidr && !loopback(cidr)) addresses.add(cidr);
  }
  const endpointHost = cleanHost(pveEndpointHost(endpoint.baseUrl));
  const hosts = store.sshHosts();
  const byAddress = hosts.find((host) => addresses.has(cleanHost(host.host)) || cleanHost(host.label) === cleanHost(node.node));
  if (byAddress) return byAddress;
  if (!loopback(endpointHost) && hosts.length === 1 && cleanHost(hosts[0].host) === endpointHost) return hosts[0];
  return undefined;
}

export async function collectPveNodeGpuTelemetry(
  store: ConfigStore,
  endpoint: StoredHost,
  node: NodeStats,
): Promise<void> {
  if (node.status !== "online") return;
  const match = findSshHostForPveNode(store, endpoint, node);
  if (!match) {
    if (node.gpus.length > 0) {
      node.gpuTelemetryError =
        "Live GPU counters need an SSH host. Add this node under Connections → Linux hosts to measure utilization, temperature, memory and power.";
    }
    return;
  }
  node.gpuTelemetryHost = match.label;
  try {
    const result = await collectSshGpuTelemetry(store, match.id);
    node.gpuTelemetry = result.gpus;
    if (result.error) {
      node.gpuTelemetryError = result.error;
    } else if (node.gpus.length > 0 && node.gpuTelemetry.length === 0) {
      node.gpuTelemetryError = `${match.label} reported no NVIDIA or AMD GPU telemetry. Confirm nvidia-smi or the amdgpu driver is available to this SSH user.`;
    }
  } catch (error) {
    node.gpuTelemetryError = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Stock Proxmox exposes no temperature through its API unless lm-sensors data
 * is patched into /nodes/{node}/status (PVE-mods) or the newer PVE 9 sensor
 * endpoints exist. When the API has no CPU package reading and this node has a
 * matching SSH host, reuse the host probe's hwmon readings so the node card
 * still shows a real temperature instead of a dash.
 */
export async function collectPveNodeSshTemps(
  store: ConfigStore,
  endpoint: StoredHost,
  node: NodeStats,
): Promise<void> {
  if (node.status !== "online" || cpuPackageTemp(node.sensors) !== null) return;
  const match = findSshHostForPveNode(store, endpoint, node);
  if (!match) return;

  const hit = pveTempCache.get(match.id);
  let readings: SensorReading[];
  if (hit && Date.now() - hit.at < PVE_TEMP_CACHE_MS) {
    readings = hit.value;
  } else {
    try {
      const snapshot = await collectSshSnapshot(store, match.id);
      readings = snapshot.temps
        .filter((temp) => /package|socket|pkg|tctl|tdie|tccd|core|cpu|soc|k10|peci|x86/i.test(temp.label))
        .map((temp) => ({ name: temp.label, value: temp.celsius, unit: "°C" }));
    } catch {
      readings = [];
    }
    pveTempCache.set(match.id, { at: Date.now(), value: readings });
  }
  if (readings.length === 0) return;

  const existing = new Set(node.sensors.map((sensor) => `${sensor.name.toLowerCase()}|${sensor.value}`));
  for (const reading of readings) {
    const key = `${reading.name.toLowerCase()}|${reading.value}`;
    if (existing.has(key)) continue;
    existing.add(key);
    node.sensors.push(reading);
  }
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
