// Contract for the PRAETOR/1 egress rollout managed by Nexus PVE.

export type PraetorSuite = "PSEAL" | "FAST" | "BOLT" | "PMARINE";
export type PraetorProfileColor = "mint" | "violet" | "amber" | "ice";

/** A profile compatible with the PRAETOR Command desktop profile schema. */
export interface PraetorProfile {
  id: string;
  name: string;
  description: string;
  location: string;
  endpoint: string;
  protocol: "PRAETOR/1";
  suite: PraetorSuite;
  transport: "tcp";
  cellSize: 512 | 1024 | 2048 | 4096;
  serverPublicKey: string;
  autoConnect: boolean;
  tags: string[];
  color: PraetorProfileColor;
  createdAt: string;
  updatedAt: string;
}

export type PraetorState = "ready" | "outdated" | "missing" | "error";

/** One retained PRAETOR reachability and firewall probe. */
export interface PraetorCheck {
  checkedAt: number;
  state: PraetorState;
  tcpReachable: boolean;
  tcpLatencyMs?: number;
  tcpError?: string;
  portListening: boolean | null;
  bindAddress?: string;
  firewallBlocked: boolean;
  firewallActive: boolean;
  firewallAllow: boolean | null;
  firewallDetail: string;
}

/** Compact result of the dashboard's recurring single-host health probe. */
export interface PraetorHealth {
  hostId: string;
  label: string;
  endpoint: string;
  state: PraetorState;
  detail: string;
  tcpReachable: boolean;
  tcpLatencyMs?: number;
  tcpError?: string;
  firewallBlocked: boolean;
  checkedAt: number;
  /** Bounded recent checks, oldest first. */
  history: PraetorCheck[];
}

export interface PraetorHostStatus {
  hostId: string;
  label: string;
  host: string;
  port: number;
  username: string;
  state: PraetorState;
  detail: string;
  endpoint: string;
  expectedSha: string;
  installedSha?: string;
  nodeVersion?: string;
  publicKey?: string;
  /** Whether /opt/praetor-egress/profiles.json is present on the host. */
  profilesOnHost: boolean;
  profiles: PraetorProfile[];
  /** Whether the workstation opened a TCP connection to the egress endpoint. */
  tcpReachable: boolean;
  tcpLatencyMs?: number;
  tcpError?: string;
  /** Whether the host was listening on TCP 9443; null means `ss` was unavailable. */
  portListening: boolean | null;
  bindAddress?: string;
  /** True when reachability failure is explained by an active Proxmox firewall without an allow rule. */
  firewallBlocked: boolean;
  /** Whether the host reports an active Proxmox firewall. */
  firewallActive: boolean;
  /** Whether the effective firewall allows TCP 9443; null when it cannot be read or is not a Proxmox host. */
  firewallAllow: boolean | null;
  firewallDetail: string;
  checkedAt: number;
  /** Bounded recent checks, oldest first. */
  history: PraetorCheck[];
  error?: string;
}

export interface PraetorOverview {
  hosts: PraetorHostStatus[];
  expectedSha: string;
  profilesPath: string;
  historyPath: string;
  checkedAt: number;
}

export interface PraetorInstallResult {
  hostId: string;
  label: string;
  ok: boolean;
  state: PraetorState;
  route: "root" | "nopasswd" | "password" | "none";
  endpoint: string;
  publicKey?: string;
  profiles: PraetorProfile[];
  output: string;
  latencyMs: number;
  warning?: string;
  error?: string;
}

export interface PraetorRotateResult extends PraetorInstallResult {
  /** Public key that was pinned before this rotation. */
  oldPublicKey?: string;
}
