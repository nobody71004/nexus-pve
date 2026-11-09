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
  checkedAt: number;
  error?: string;
}

export interface PraetorOverview {
  hosts: PraetorHostStatus[];
  expectedSha: string;
  profilesPath: string;
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
