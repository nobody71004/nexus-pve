// Shared contract for the local Nexus team workspace. Accounts, sessions,
// machine links and audit records live in the SQLite database owned by the
// Electron main process; the renderer only ever receives sanitized views.

export type TeamRole = "admin" | "moderator" | "user";
export type TeamStatus = "active" | "suspended";

export interface TeamUser {
  id: string;
  username: string;
  displayName: string;
  role: TeamRole;
  status: TeamStatus;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
  /** Number of SSH machines explicitly linked to this account. */
  linkedMachines: number;
  /** A live session touched within the last five minutes. */
  online: boolean;
}

export interface TeamMachine {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  color: string;
  /** Local machines are backed by this computer's SSH inventory. */
  source: "local" | "remote";
  /** IDs of members allowed to use this machine over SSH/VNC. */
  linkedUserIds: string[];
  linkedUsers: Array<Pick<TeamUser, "id" | "username" | "displayName" | "role">>;
  updatedAt: number;
}

export interface TeamActivityEntry {
  id: string;
  at: number;
  actorId?: string;
  actorName: string;
  action: string;
  targetType: "user" | "machine" | "session" | "workspace";
  targetId?: string;
  targetName?: string;
  detail?: string;
}

export interface TeamPermissions {
  manageUsers: boolean;
  manageRoles: boolean;
  deleteUsers: boolean;
  manageLinks: boolean;
  manageMachines: boolean;
}

export interface TeamOverview {
  workspaceName: string;
  database: "SQLite";
  users: TeamUser[];
  machines: TeamMachine[];
  activity: TeamActivityEntry[];
  counts: {
    members: number;
    admins: number;
    moderators: number;
    machines: number;
    links: number;
    online: number;
  };
  permissions: TeamPermissions;
}

export interface TeamAuthState {
  initialized: boolean;
  user: TeamUser | null;
  /** Session expiry for the local warning banner; null when signed out. */
  expiresAt: number | null;
}

export interface TeamBootstrapInput {
  username: string;
  displayName: string;
  password: string;
}

export interface TeamLoginInput {
  username: string;
  password: string;
}

export interface TeamUserInput {
  username: string;
  displayName: string;
  role: TeamRole;
  password: string;
}

export interface TeamUserPatch {
  displayName?: string;
  role?: TeamRole;
  status?: TeamStatus;
  password?: string;
}
