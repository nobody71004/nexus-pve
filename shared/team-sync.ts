import type { TeamActivityEntry, TeamRole, TeamStatus } from "./team-types";

export interface TeamSyncChatMessage {
  id: string;
  authorUsername: string;
  authorName: string;
  authorRole: TeamRole;
  body: string;
  createdAt: number;
}

export interface TeamSyncBoardList {
  id: string;
  title: string;
  position: number;
  createdByUsername?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamSyncBoardTask {
  id: string;
  listId: string;
  title: string;
  detail?: string;
  pinned: boolean;
  authorUsername: string;
  authorName: string;
  authorRole: TeamRole;
  createdAt: number;
  updatedAt: number;
}

export interface TeamSyncBoardTombstone {
  id: string;
  deletedAt: number;
}

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
  chat: TeamSyncChatMessage[];
  boardLists: TeamSyncBoardList[];
  boardTasks: TeamSyncBoardTask[];
  boardListTombstones: TeamSyncBoardTombstone[];
  boardTaskTombstones: TeamSyncBoardTombstone[];
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

export interface TeamSyncJoinInput extends TeamSyncConfigInput {
  /** Discard this computer's standalone workspace before importing the relay copy. */
  replaceLocal?: boolean;
}

export interface TeamSyncPreviewUser {
  username: string;
  displayName: string;
  role: TeamRole;
  status: TeamStatus;
}

/** Read-only view of the relay directory before a new station adopts it. */
export interface TeamSyncPreview {
  endpoint: string;
  workspace: string;
  workspaceName: string;
  revision: number;
  users: TeamSyncPreviewUser[];
  machines: number;
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
