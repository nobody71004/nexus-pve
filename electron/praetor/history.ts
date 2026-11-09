import fs from "node:fs";
import path from "node:path";
import type { PraetorCheck, PraetorHostStatus } from "../../shared/types";
import { nexusHome } from "../paths";

const HISTORY_VERSION = 1;
const MAX_CHECKS = 96;

interface HostHistory {
  label: string;
  checks: PraetorCheck[];
}

interface HistoryFile {
  version: number;
  hosts: Record<string, HostHistory>;
}

/** Persist a compact probe history beside the profile bundle. */
export function historyPath(): string {
  return path.join(nexusHome(), "praetor", "history.json");
}

function emptyState(): HistoryFile {
  return { version: HISTORY_VERSION, hosts: {} };
}

function readState(): HistoryFile {
  let raw: string;
  try {
    raw = fs.readFileSync(historyPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HistoryFile>;
    if (parsed.version !== HISTORY_VERSION || !parsed.hosts || typeof parsed.hosts !== "object") return emptyState();
    const hosts: Record<string, HostHistory> = {};
    for (const [id, entry] of Object.entries(parsed.hosts)) {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.checks)) continue;
      hosts[id] = {
        label: typeof entry.label === "string" ? entry.label : id,
        checks: entry.checks.slice(-MAX_CHECKS),
      };
    }
    return { version: HISTORY_VERSION, hosts };
  } catch {
    return emptyState();
  }
}

function writeState(state: HistoryFile): void {
  const file = historyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function toCheck(host: PraetorHostStatus): PraetorCheck {
  return {
    checkedAt: host.checkedAt,
    state: host.state,
    tcpReachable: host.tcpReachable,
    tcpLatencyMs: host.tcpLatencyMs,
    tcpError: host.tcpError,
    portListening: host.portListening,
    bindAddress: host.bindAddress,
    firewallBlocked: host.firewallBlocked,
    firewallActive: host.firewallActive,
    firewallAllow: host.firewallAllow,
    firewallDetail: host.firewallDetail,
  };
}

/**
 * Append one probe per host and return the retained history. History is
 * best-effort: a disk error must never make the live overview fail.
 */
export function recordChecks(hosts: PraetorHostStatus[]): Record<string, PraetorCheck[]> {
  if (hosts.length === 0) return {};
  try {
    const state = readState();
    const result: Record<string, PraetorCheck[]> = {};
    for (const host of hosts) {
      const previous = state.hosts[host.hostId]?.checks ?? [];
      const checks = [...previous, toCheck(host)].slice(-MAX_CHECKS);
      state.hosts[host.hostId] = { label: host.label, checks };
      result[host.hostId] = checks;
    }
    writeState(state);
    return result;
  } catch {
    return Object.fromEntries(hosts.map((host) => [host.hostId, []]));
  }
}
