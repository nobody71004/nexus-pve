import { configStore, type ConfigStore } from "../config";
import type {
  DdosConfig,
  DdosForward,
  DdosIncident,
  DdosInstallResult,
  DdosMode,
  DdosOverview,
  DdosStatus,
} from "../../shared/ddos-types";
import { DdosStore, DEFAULT_CONFIG } from "./store";
import { edgeFiles, installScript } from "./install";
import { buildInstallScript, edgeCommand, extractJson, runEdge, shellQuote } from "./remote";

let appRoot = process.cwd();

/** Called once by the runtime; the resource bundle lives under the app root. */
export function setDdosAppRoot(root: string): void {
  appRoot = root;
}

const MODES: DdosMode[] = ["observe", "defend", "lockdown"];
const CACHE_MS = 5_000;

function isIpv4(value: string): boolean {
  return /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(value);
}

function assertConfig(config: DdosConfig): void {
  if (!MODES.includes(config.mode)) throw new Error("mode must be observe, defend or lockdown");
  if (!/^[A-Za-z0-9_.:-]{1,32}$/.test(config.wan)) throw new Error("WAN interface name is not valid");
  if (!/^[A-Za-z0-9_.:-]{1,32}$/.test(config.wireguardInterface)) throw new Error("WireGuard interface name is not valid");
  if (!Number.isInteger(config.wireguardPort) || config.wireguardPort < 1 || config.wireguardPort > 65535) {
    throw new Error("WireGuard port must be 1-65535");
  }
  if (!Array.isArray(config.forwards) || config.forwards.length === 0) throw new Error("At least one forward is required");
  const ids = new Set<string>();
  for (const forward of config.forwards) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(forward.id)) throw new Error(`Forward id is not safe: ${forward.id}`);
    if (ids.has(forward.id)) throw new Error(`Duplicate forward id: ${forward.id}`);
    ids.add(forward.id);
    if (forward.proto !== "tcp" && forward.proto !== "udp") throw new Error(`${forward.id}: protocol must be tcp or udp`);
    if (!isIpv4(forward.target)) throw new Error(`${forward.id}: target must be an IPv4 address`);
    if (!Array.isArray(forward.ports) || forward.ports.length === 0) throw new Error(`${forward.id}: at least one port range is required`);
    for (const range of forward.ports) {
      if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 1 || range.to > 65535 || range.from > range.to) {
        throw new Error(`${forward.id}: invalid port range ${range.from}-${range.to}`);
      }
    }
  }
  for (const ip of config.allowlist) {
    if (!isIpv4(ip)) throw new Error(`Allowlist entry is not an IPv4 address: ${ip}`);
  }
  const limits = config.limits;
  const bounds: Array<[keyof typeof limits, number, number]> = [
    ["udpPps", 50, 200_000],
    ["tcpNewPerSec", 5, 20_000],
    ["autoBanPps", 100, 200_000],
    ["blockSeconds", 60, 604_800],
    ["autoBanSamples", 2, 60],
  ];
  for (const [key, low, high] of bounds) {
    const value = Number(limits[key]);
    if (!Number.isFinite(value) || value < low || value > high) throw new Error(`limits.${key} must be ${low}-${high}`);
  }
}

function offlineStatus(hostId: string, config: DdosConfig, error?: string, installed = false): DdosStatus {
  return {
    hostId,
    installed,
    running: false,
    mode: config.mode,
    since: 0,
    sampledAt: Date.now(),
    uptimeSec: 0,
    publicIp: "",
    wan: config.wan,
    ingressBps: 0,
    egressBps: 0,
    ingressPps: 0,
    egressPps: 0,
    conntrack: { count: 0, max: 0 },
    cpuPct: 0,
    memPct: 0,
    load1: 0,
    drops: { invalid: 0, blocked: 0, rate: 0, total: 0 },
    blocked: [],
    allowlist: config.allowlist,
    sources: [],
    forwards: config.forwards,
    limits: config.limits,
    autoBan: config.autoBan,
    health: "offline",
    error,
  };
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function mapStatus(raw: Record<string, unknown>, hostId: string, config: DdosConfig): DdosStatus {
  const conntrack = (raw.conntrack ?? {}) as Record<string, unknown>;
  const drops = (raw.drops ?? {}) as Record<string, unknown>;
  const forwards = Array.isArray(raw.forwards) ? (raw.forwards as DdosForward[]) : config.forwards;
  const limits = (raw.limits && typeof raw.limits === "object" ? raw.limits : config.limits) as DdosConfig["limits"];
  return {
    hostId,
    installed: raw.installed !== false,
    running: raw.running !== false,
    mode: MODES.includes(raw.mode as DdosMode) ? (raw.mode as DdosMode) : config.mode,
    tight: raw.tight === true,
    since: number(raw.since, Date.now()),
    sampledAt: number(raw.sampledAt, Date.now()),
    uptimeSec: number(raw.uptimeSec),
    publicIp: string(raw.publicIp),
    wan: string(raw.wan, config.wan),
    ingressBps: number(raw.ingressBps),
    egressBps: number(raw.egressBps),
    ingressPps: number(raw.ingressPps),
    egressPps: number(raw.egressPps),
    conntrack: { count: number(conntrack.count), max: number(conntrack.max) },
    cpuPct: number(raw.cpuPct),
    memPct: number(raw.memPct),
    load1: number(raw.load1),
    drops: {
      invalid: number(drops.invalid),
      blocked: number(drops.blocked),
      rate: number(drops.rate),
      total: number(drops.total),
      malformed: number(drops.malformed),
      fragments: number(drops.fragments),
    },
    blocked: Array.isArray(raw.blocked) ? raw.blocked.map(String) : [],
    allowlist: Array.isArray(raw.allowlist) ? raw.allowlist.map(String) : config.allowlist,
    sources: Array.isArray(raw.sources)
      ? (raw.sources as Array<Record<string, unknown>>).map((entry) => ({
          ip: string(entry.ip),
          pps: number(entry.pps),
          bps: number(entry.bps),
          connections: number(entry.connections),
          blocked: entry.blocked === true,
          allowlisted: entry.allowlisted === true,
        }))
      : [],
    forwards,
    limits,
    autoBan: raw.autoBan !== false,
    recent: Array.isArray(raw.recent)
      ? (raw.recent as Array<Record<string, unknown>>).map((entry) => ({
          at: number(entry.at),
          kind: string(entry.kind, "event"),
          message: string(entry.message),
        }))
      : undefined,
    health: raw.health === "degraded" ? "degraded" : raw.running === false ? "offline" : "online",
  };
}

export class DdosService {
  private readonly local = new DdosStore();
  private readonly cache = new Map<string, { at: number; value: DdosStatus }>();

  constructor(private readonly store: ConfigStore) {}

  overview(): Promise<DdosOverview> {
    return this.buildOverview();
  }

  private async buildOverview(): Promise<DdosOverview> {
    const local = this.local.read();
    const candidates = this.store.sshHosts().map((host) => this.store.publicSshHost(host));
    const edgeHostId = local.edgeHostId ?? this.autoDetect(candidates.map((host) => host.id));
    let status: DdosStatus | undefined;
    let error: string | undefined;
    if (edgeHostId) {
      try {
        status = await this.status(edgeHostId);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    const edge = candidates.find((host) => host.id === edgeHostId);
    return {
      edgeHostId,
      edgeLabel: edge?.label,
      candidates,
      config: local.config,
      status,
      incidents: this.local.incidents(60),
      error,
      checkedAt: Date.now(),
    };
  }

  private autoDetect(ids: string[]): string | undefined {
    const hosts = ids
      .map((id) => this.store.sshHost(id))
      .filter((host): host is NonNullable<typeof host> => Boolean(host));
    const preferred = hosts.find(
      (host) => /edge|relay|shield/i.test(host.label),
    );
    return preferred?.id;
  }

  async status(hostId: string, force = false): Promise<DdosStatus> {
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    const config = this.local.config();
    const hit = this.cache.get(host.id);
    if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.value;

    let result;
    try {
      result = await runEdge(
        this.store,
        host.id,
        "if command -v nexus-shieldctl >/dev/null 2>&1; then nexus-shieldctl status; else echo __NEXUS_SHIELD_NOT_INSTALLED__; fi\n",
        25_000,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An unreachable host is an offline shield, not a first install: keep the
      // installed flag conservative so the UI does not offer a risky reinstall.
      const offline = offlineStatus(host.id, config, message, true);
      this.cache.set(host.id, { at: Date.now(), value: offline });
      return offline;
    }
    const text = `${result.stdout}\n${result.stderr}`;
    if (text.includes("__NEXUS_SHIELD_NOT_INSTALLED__") || /command not found/i.test(text)) {
      const offline = offlineStatus(host.id, config);
      this.cache.set(host.id, { at: Date.now(), value: offline });
      return offline;
    }
    const parsed = extractJson(result.stdout);
    if (!parsed || typeof parsed !== "object") {
      const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(" ");
      const installed = !/unreachable|not installed/i.test(detail) ? true : false;
      const offline = offlineStatus(host.id, config, detail || "edge returned no status", installed);
      this.cache.set(host.id, { at: Date.now(), value: offline });
      return offline;
    }
    const status = mapStatus(parsed as Record<string, unknown>, host.id, config);
    this.cache.set(host.id, { at: Date.now(), value: status });
    return status;
  }

  async install(hostId: string): Promise<DdosInstallResult> {
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    const script = installScript(appRoot);
    const result = await runEdge(this.store, hostId, script, 180_000);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (!result.ok || !/NEXUS_SHIELD_OK/.test(result.stdout)) {
      this.local.record({
        kind: "error",
        hostId,
        message: `install failed on ${host.label}`,
        detail: output.slice(-1200),
      });
      throw new Error(`Install failed on ${host.label}: ${output.slice(-1200) || "no output"}`);
    }
    this.local.setEdge(hostId);
    const status = await this.status(hostId, true);
    this.local.record({
      kind: "install",
      hostId,
      message: `Nexus Shield installed on ${host.label}`,
      detail: `mode ${status.mode} · ${status.forwards.length} forwards · edge tables adopted`,
    });
    return {
      hostId,
      ok: true,
      output: result.stdout.slice(-4000),
      status,
      error: status.error,
    };
  }

  async setMode(hostId: string, mode: DdosMode): Promise<DdosStatus> {
    if (!MODES.includes(mode)) throw new Error("mode must be observe, defend or lockdown");
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    await edgeCommand(this.store, hostId, `nexus-shieldctl mode ${mode}`);
    this.local.setMode(mode);
    this.cache.delete(hostId);
    this.local.record({ kind: "mode", hostId, message: `mode set to ${mode} on ${host.label}` });
    return this.status(hostId, true);
  }

  async ban(hostId: string, ip: string, seconds?: number, reason?: string): Promise<DdosStatus> {
    if (!isIpv4(ip)) throw new Error(`Not an IPv4 address: ${ip}`);
    const duration = Math.max(30, Math.min(604_800, Math.round(seconds ?? this.local.config().limits.blockSeconds)));
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    await edgeCommand(
      this.store,
      hostId,
      `nexus-shieldctl ban ${ip} ${duration} ${shellQuote(reason?.trim() || "operator")}`,
    );
    this.cache.delete(hostId);
    this.local.record({
      kind: "ban",
      hostId,
      message: `banned ${ip} on ${host.label} for ${duration}s`,
      detail: reason,
    });
    return this.status(hostId, true);
  }

  async unban(hostId: string, ip: string): Promise<DdosStatus> {
    if (!isIpv4(ip)) throw new Error(`Not an IPv4 address: ${ip}`);
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    await edgeCommand(this.store, hostId, `nexus-shieldctl unban ${ip}`);
    this.cache.delete(hostId);
    this.local.record({ kind: "unban", hostId, message: `unbanned ${ip} on ${host.label}` });
    return this.status(hostId, true);
  }

  async allow(hostId: string, ip: string, add: boolean): Promise<DdosStatus> {
    if (!isIpv4(ip)) throw new Error(`Not an IPv4 address: ${ip}`);
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    await edgeCommand(this.store, hostId, `nexus-shieldctl ${add ? "allow" : "unallow"} ${ip}`);
    this.cache.delete(hostId);
    this.local.record({
      kind: "allow",
      hostId,
      message: `${add ? "allowlisted" : "removed from allowlist"} ${ip} on ${host.label}`,
    });
    return this.status(hostId, true);
  }

  async apply(hostId: string, patch: Partial<DdosConfig>): Promise<DdosStatus> {
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    const current = this.local.config();
    const next: DdosConfig = {
      ...current,
      ...patch,
      forwards: patch.forwards ?? current.forwards,
      limits: { ...current.limits, ...(patch.limits ?? {}) },
      allowlist: patch.allowlist ?? current.allowlist,
      updatedAt: Date.now(),
    };
    assertConfig(next);
    this.local.saveConfig(next);

    const payload = Buffer.from(JSON.stringify(next), "utf8").toString("base64");
    const script = [
      "set -euo pipefail",
      `printf '%s' '${payload}' | base64 -d > /tmp/nexus-shield-config.json`,
      "python3 - <<'PY'",
      "import json",
      'with open("/etc/nexus-shield/config.json", encoding="utf-8") as handle:',
      "    current = json.load(handle)",
      'with open("/tmp/nexus-shield-config.json", encoding="utf-8") as handle:',
      "    incoming = json.load(handle)",
      'incoming["apiToken"] = current.get("apiToken", "")',
      'incoming["apiPort"] = current.get("apiPort", 8791)',
      'with open("/etc/nexus-shield/config.json", "w", encoding="utf-8") as handle:',
      "    json.dump(incoming, handle, indent=2)",
      '    handle.write("\\n")',
      "PY",
      "chmod 600 /etc/nexus-shield/config.json",
      "nexus-shieldctl reload >/dev/null",
      "nexus-shieldctl status",
      "",
    ].join("\n");
    const result = await runEdge(this.store, hostId, script, 60_000);
    if (!result.ok) {
      const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(" ");
      throw new Error(`Edge rejected the configuration: ${detail || "unknown error"}`);
    }
    this.cache.delete(hostId);
    this.local.record({
      kind: "config",
      hostId,
      message: `policy applied on ${host.label}`,
      detail: `mode ${next.mode} · udp ${next.limits.udpPps} pps · auto-ban ${next.autoBan ? "on" : "off"}`,
    });
    const parsed = extractJson(result.stdout);
    if (parsed && typeof parsed === "object") {
      const status = mapStatus(parsed as Record<string, unknown>, hostId, next);
      this.cache.set(hostId, { at: Date.now(), value: status });
      return status;
    }
    return this.status(hostId, true);
  }

  async rules(hostId: string): Promise<string> {
    return edgeCommand(this.store, hostId, "nexus-shieldctl rules", 30_000);
  }

  journal(limit = 100): DdosIncident[] {
    return this.local.incidents(limit);
  }

  /** Switches which configured host owns the shield, without reinstalling. */
  selectEdge(hostId: string): void {
    if (!this.store.sshHost(hostId)) throw new Error(`Unknown Linux host: ${hostId}`);
    this.local.setEdge(hostId);
  }

  async installFromSource(hostId: string, files: Record<string, string>): Promise<DdosInstallResult> {
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    const result = await runEdge(this.store, hostId, buildInstallScript(files), 180_000);
    if (!result.ok) throw new Error(result.stderr.trim() || result.stdout.trim() || "install failed");
    this.local.setEdge(hostId);
    return { hostId, ok: true, output: result.stdout.slice(-4000), status: await this.status(hostId, true) };
  }

  /** Exposed for the installer UI: shows what will be pushed before it runs. */
  bundleFiles(): Record<string, string> {
    return edgeFiles(appRoot);
  }

  defaults(): DdosConfig {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export const ddos = new DdosService(configStore);
