import type { TeamActivityEntry, TeamRole, TeamStatus } from "./team-types";

/**
 * Cross-device sync is deliberately a workspace snapshot protocol. The main
 * process merges the snapshot with the local SQLite directory, and the relay
 * only stores the latest merged revision. Password hashes are part of the
 * encrypted-in-transit snapshot so a member can sign in on a second computer;
 * tokens and machine secrets are never included.
 */
export interface TeamSyncUser {
  username: string;
  displayName: string;
  role: TeamRole;
  status: TeamStatus;
  passwordSalt: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
}

export interface TeamSyncMachine {
  /** Stable workspace key: lower-case host + port + username. */
  key: string;
  label: string;
  host: string;
  port: number;
  username: string;
  color: string;
  updatedAt: number;
  /** Whole-set timestamp; links are replaced as a set, not unioned. */
  linksUpdatedAt: number;
  /** Usernames, never local database ids. */
  linkedUsernames: string[];
}

export interface TeamSyncUserTombstone {
  username: string;
  deletedAt: number;
}

export interface TeamSyncMachineTombstone {
  /** Stable workspace key: lower-case host + port + username. */
  key: string;
  deletedAt: number;
}

export interface TeamSyncSnapshot {
  version: 1;
  workspaceName: string;
  workspaceUpdatedAt: number;
  users: TeamSyncUser[];
  machines: TeamSyncMachine[];
  activity: TeamActivityEntry[];
  userTombstones: TeamSyncUserTombstone[];
  machineTombstones: TeamSyncMachineTombstone[];
}

export interface TeamSyncRemoteState {
  revision: number;
  updatedAt: number;
  snapshot: TeamSyncSnapshot | null;
}

export type TeamSyncPhase = "disabled" | "idle" | "syncing" | "online" | "error";

export interface TeamSyncStatus {
  enabled: boolean;
  phase: TeamSyncPhase;
  endpoint?: string;
  workspace: string;
  deviceName: string;
  tokenSet: boolean;
  revision: number;
  lastSyncAt?: number;
  lastAttemptAt?: number;
  error?: string;
  counts: { users: number; machines: number; activity: number };
}

export interface TeamSyncConfigInput {
  endpoint: string;
  token: string;
  workspace?: string;
  deviceName?: string;
}

export interface TeamSyncRunResult {
  status: TeamSyncStatus;
  pulled: number;
  pushed: number;
  changed: boolean;
}

export type TeamAuditTarget = TeamActivityEntry["targetType"] | "all";

export interface TeamAuditFilter {
  actorId?: string;
  action?: string;
  targetType?: TeamAuditTarget;
  query?: string;
  from?: number;
  to?: number;
  limit?: number;
}

export interface TeamAuditResult {
  entries: TeamActivityEntry[];
  total: number;
}

export interface TeamAuditExportResult {
  count: number;
  filename: string;
  path: string;
}
