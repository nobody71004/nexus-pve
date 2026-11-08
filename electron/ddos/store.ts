import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nexusHome } from "../paths";
import type { DdosConfig, DdosForward, DdosIncident, DdosLimits, DdosMode } from "../../shared/ddos-types";

export const DEFAULT_LIMITS: DdosLimits = {
  udpPps: 4000,
  tcpNewPerSec: 80,
  autoBanPps: 1200,
  blockSeconds: 3600,
  autoBanSamples: 3,
};

/**
 * The relay's live forwards, grouped the way an operator thinks about them.
 * Ports that were never public on the relay are deliberately absent: the edge
 * must not widen the attack surface while narrowing it.
 */
export const DEFAULT_FORWARDS: DdosForward[] = [
  {
    id: "web-home",
    label: "Demo web (home origin)",
    proto: "tcp",
    ports: [
      { from: 80, to: 80 },
      { from: 443, to: 443 },
    ],
    target: "192.0.2.20",
    enabled: true,
  },
  {
    id: "demo-7777",
    label: "Demo Game 7777",
    proto: "udp",
    ports: [{ from: 7777, to: 7777 }],
    target: "192.0.2.20",
    enabled: true,
  },
  {
    id: "demo-7781",
    label: "Demo Game 7781-7784",
    proto: "udp",
    ports: [{ from: 7781, to: 7784 }],
    target: "192.0.2.20",
    enabled: true,
  },
  {
    id: "demo-7800",
    label: "Demo Game master 7800",
    proto: "udp",
    ports: [{ from: 7800, to: 7800 }],
    target: "192.0.2.20",
    enabled: true,
  },
  {
    id: "mirror-tcp",
    label: "Screen mirror TCP",
    proto: "tcp",
    ports: [{ from: 59100, to: 59103 }],
    target: "192.0.2.20",
    enabled: true,
  },
  {
    id: "mirror-udp",
    label: "Screen mirror UDP",
    proto: "udp",
    ports: [{ from: 59100, to: 59103 }],
    target: "192.0.2.20",
    enabled: true,
  },
  {
    id: "turn-tcp",
    label: "TURN TCP 3478",
    proto: "tcp",
    ports: [{ from: 3478, to: 3478 }],
    target: "192.0.2.20",
    enabled: true,
  },
  {
    id: "turn-udp",
    label: "TURN UDP 3478 + relay pool",
    proto: "udp",
    pps: 12000,
    ports: [
      { from: 3478, to: 3478 },
      { from: 49152, to: 49251 },
    ],
    target: "192.0.2.20",
    enabled: true,
  },
  {
    id: "demo-game-udp",
    label: "Demo game fleet",
    proto: "udp",
    pps: 24000,
    ports: [
      { from: 11778, to: 11778 },
      { from: 11784, to: 11784 },
      { from: 11787, to: 11787 },
      { from: 11790, to: 11790 },
      { from: 11796, to: 11796 },
      { from: 11830, to: 11830 },
      { from: 11840, to: 11840 },
      { from: 11850, to: 11850 },
      { from: 11860, to: 11860 },
    ],
    target: "192.0.2.20",
    enabled: true,
  },
];

export const DEFAULT_CONFIG: DdosConfig = {
  mode: "defend",
  wan: "eth0",
  wireguardInterface: "wg0",
  wireguardPort: 51820,
  adminPort: 22,
  forwards: DEFAULT_FORWARDS,
  limits: DEFAULT_LIMITS,
  allowlist: ["192.0.2.14"],
  autoBan: true,
  pollSeconds: 2,
  updatedAt: Date.now(),
};

interface LocalState {
  version: 1;
  edgeHostId?: string;
  config: DdosConfig;
  incidents: DdosIncident[];
}

function mergeConfig(raw: Partial<DdosConfig> | undefined): DdosConfig {
  if (!raw) return { ...DEFAULT_CONFIG, forwards: structuredClone(DEFAULT_FORWARDS), limits: { ...DEFAULT_LIMITS }, allowlist: [...DEFAULT_CONFIG.allowlist] };
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    forwards: Array.isArray(raw.forwards) && raw.forwards.length > 0 ? raw.forwards : structuredClone(DEFAULT_FORWARDS),
    limits: { ...DEFAULT_LIMITS, ...(raw.limits ?? {}) },
    allowlist: Array.isArray(raw.allowlist) ? raw.allowlist : [...DEFAULT_CONFIG.allowlist],
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function blank(): LocalState {
  return { version: 1, config: mergeConfig(undefined), incidents: [] };
}

/** One small file next to the app config. No secrets live here. */
export class DdosStore {
  private readonly file = path.join(nexusHome(), "ddos.json");

  read(): LocalState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<LocalState>;
      return {
        version: 1,
        edgeHostId: typeof raw.edgeHostId === "string" ? raw.edgeHostId : undefined,
        config: mergeConfig(raw.config),
        incidents: Array.isArray(raw.incidents) ? raw.incidents.slice(-200) : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return blank();
      return blank();
    }
  }

  write(state: LocalState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows */
    }
  }

  config(): DdosConfig {
    return this.read().config;
  }

  saveConfig(config: DdosConfig): DdosConfig {
    const state = this.read();
    state.config = config;
    this.write(state);
    return config;
  }

  patchConfig(patch: Partial<DdosConfig>): DdosConfig {
    const state = this.read();
    state.config = mergeConfig({
      ...state.config,
      ...patch,
      limits: { ...state.config.limits, ...(patch.limits ?? {}) },
      forwards: patch.forwards ?? state.config.forwards,
      allowlist: patch.allowlist ?? state.config.allowlist,
      updatedAt: Date.now(),
    });
    this.write(state);
    return state.config;
  }

  setMode(mode: DdosMode): void {
    this.patchConfig({ mode });
  }

  setEdge(hostId: string | undefined): void {
    const state = this.read();
    state.edgeHostId = hostId;
    this.write(state);
  }

  incidents(limit = 100): DdosIncident[] {
    return this.read().incidents.slice(-Math.max(1, Math.min(200, limit))).reverse();
  }

  record(input: Omit<DdosIncident, "id" | "at"> & { at?: number }): DdosIncident {
    const state = this.read();
    const entry: DdosIncident = {
      id: crypto.randomUUID(),
      at: input.at ?? Date.now(),
      kind: input.kind,
      message: input.message,
      detail: input.detail,
      hostId: input.hostId,
    };
    state.incidents = [...state.incidents, entry].slice(-200);
    this.write(state);
    return entry;
  }
}
