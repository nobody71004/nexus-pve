/**
 * DDoS shield contract shared by the main process, preload, renderer and MCP.
 *
 * The edge host runs `nexus-shieldd`; the desktop app only holds the desired
 * policy and the last sampled state. Absolute counters come from nftables, so a
 * restart of the app never resets what the edge is enforcing.
 */

export type DdosMode = "observe" | "defend" | "lockdown";
export type DdosProtocol = "tcp" | "udp";

export interface DdosPortRange {
  from: number;
  to: number;
}

export interface DdosForward {
  id: string;
  label: string;
  proto: DdosProtocol;
  ports: DdosPortRange[];
  /** Optional UDP ceiling for this service, overriding limits.udpPps. */
  pps?: number;
  /** IPv4 origin reachable from the edge (the home WireGuard peer today). */
  target: string;
  enabled: boolean;
}

export interface DdosLimits {
  /** Packets per second allowed per forwarded UDP service before excess is dropped. */
  udpPps: number;
  /** New TCP connections per second allowed per forwarded TCP service. */
  tcpNewPerSec: number;
  /** Per-source UDP pps that becomes an automatic ban candidate. */
  autoBanPps: number;
  /** How long an automatic or manual ban stays in the drop set. */
  blockSeconds: number;
  /** Consecutive samples above autoBanPps before a source is banned. */
  autoBanSamples: number;
}

export interface DdosConfig {
  mode: DdosMode;
  wan: string;
  wireguardInterface: string;
  wireguardPort: number;
  adminPort: number;
  forwards: DdosForward[];
  limits: DdosLimits;
  allowlist: string[];
  autoBan: boolean;
  pollSeconds: number;
  updatedAt: number;
}

export interface DdosSource {
  ip: string;
  pps: number;
  bps: number;
  connections: number;
  blocked: boolean;
  allowlisted: boolean;
}

export interface DdosDropStats {
  invalid: number;
  blocked: number;
  rate: number;
  total: number;
  malformed?: number;
  fragments?: number;
}

export interface DdosEvent {
  at: number;
  kind: string;
  message: string;
}

export interface DdosStatus {
  hostId: string;
  installed: boolean;
  running: boolean;
  mode: DdosMode;
  /** True while an attack window has halved the rate limits. */
  tight?: boolean;
  since: number;
  sampledAt: number;
  uptimeSec: number;
  publicIp: string;
  wan: string;
  ingressBps: number;
  egressBps: number;
  ingressPps: number;
  egressPps: number;
  conntrack: { count: number; max: number };
  cpuPct: number;
  memPct: number;
  load1: number;
  drops: DdosDropStats;
  blocked: string[];
  allowlist: string[];
  sources: DdosSource[];
  forwards: DdosForward[];
  limits: DdosLimits;
  autoBan: boolean;
  recent?: DdosEvent[];
  health: "online" | "degraded" | "offline";
  error?: string;
}

export interface DdosIncident {
  id: string;
  at: number;
  kind: "install" | "mode" | "ban" | "unban" | "allow" | "config" | "attack" | "error";
  message: string;
  detail?: string;
  hostId?: string;
}

export interface DdosOverview {
  edgeHostId?: string;
  edgeLabel?: string;
  candidates: Array<{
    id: string;
    label: string;
    host: string;
    port: number;
    username: string;
    authMode: "key" | "password";
    hasSecret: boolean;
    color: string;
    createdAt: number;
    lastSeenAt?: number;
  }>;
  config: DdosConfig;
  status?: DdosStatus;
  incidents: DdosIncident[];
  error?: string;
  checkedAt: number;
}

export interface DdosInstallResult {
  hostId: string;
  ok: boolean;
  output: string;
  status?: DdosStatus;
  error?: string;
}
