import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import type { Database, SqlValue } from "sql.js";
import type { HostSummary, SshHostSummary } from "../../shared/types";
import type {
  TeamActivityEntry,
  TeamAuthState,
  TeamBoard,
  TeamBoardList,
  TeamBoardTask,
  TeamBoardTaskInput,
  TeamBoardTaskPatch,
  TeamBootstrapInput,
  TeamChat,
  TeamChatMessage,
  TeamLoginInput,
  TeamMachine,
  TeamOverview,
  TeamPermissions,
  TeamRole,
  TeamStatus,
  TeamUser,
  TeamUserInput,
  TeamUserPatch,
} from "../../shared/team-types";
import type {
  TeamAuditFilter,
  TeamAuditResult,
  TeamSyncBoardList,
  TeamSyncBoardTask,
  TeamSyncBoardTombstone,
  TeamSyncChatMessage,
  TeamSyncMachine,
  TeamSyncMachineTombstone,
  TeamSyncSnapshot,
  TeamSyncUser,
  TeamSyncUserTombstone,
} from "../../shared/team-sync";
import { nexusHome } from "../paths";

type Row = Record<string, SqlValue>;
type Param = string | number | null;

const SESSION_MS = 12 * 60 * 60 * 1000;
const ONLINE_MS = 5 * 60 * 1000;
const TOUCH_MS = 60_000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 2 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const AUDIT_DEFAULT_LIMIT = 250;
const AUDIT_MAX_LIMIT = 2_000;
const SYNC_ACTIVITY_LIMIT = 1_000;
const CHAT_VIEW_LIMIT = 300;
const CHAT_SYNC_LIMIT = 500;
const CHAT_STORE_LIMIT = 1_000;
const CHAT_BODY_MAX = 2_000;
const BOARD_LIST_LIMIT = 12;
const BOARD_TASK_LIMIT = 1_000;
const BOARD_LIST_TITLE_MAX = 40;
const BOARD_TASK_TITLE_MAX = 140;
const BOARD_TASK_DETAIL_MAX = 2_000;
const TEAM_SCHEMA_VERSION = 2;
const DEFAULT_BOARD_LISTS = [
  { id: "board-list-todo", title: "To do", position: 0 },
  { id: "board-list-doing", title: "In progress", position: 1 },
  { id: "board-list-done", title: "Done", position: 2 },
] as const;

function uid(): string {
  return crypto.randomUUID();
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDisplayName(value: string): string {
  const name = value.trim();
  if (name.length < 2 || name.length > 60) throw new Error("Display name must be 2–60 characters.");
  return name;
}

function normalizePassword(value: string): string {
  if (value.length < 8) throw new Error("Password must be at least 8 characters.");
  if (value.length > 200) throw new Error("Password is too long.");
  return value;
}

function normalizeRole(value: string): TeamRole {
  if (value === "superadmin" || value === "admin" || value === "moderator" || value === "user") return value;
  throw new Error("Unknown team role.");
}

function normalizeStatus(value: string): TeamStatus {
  if (value === "active" || value === "suspended") return value;
  throw new Error("Unknown account status.");
}

function roleLabel(role: TeamRole): string {
  return role === "superadmin"
    ? "Super admin"
    : role === "admin"
      ? "Admin"
      : role === "moderator"
        ? "Moderator"
        : "Member";
}

function machineKey(host: string, port: number, username: string): string {
  return `${host.trim().toLowerCase()}:${port}:${username.trim().toLowerCase()}`;
}

function normalizePveBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/** Workspace key for either an SSH endpoint or a Proxmox API endpoint. */
function machineSyncKey(row: Record<string, unknown>): string {
  if (String(row.kind ?? "ssh") === "pve") return `pve:${normalizePveBaseUrl(String(row.base_url ?? ""))}`;
  return machineKey(String(row.host), Number(row.port), String(row.username));
}

function pveEndpoint(baseUrl: string): { host: string; port: number } {
  try {
    const url = new URL(baseUrl.trim());
    return { host: url.hostname, port: Number(url.port) || 8006 };
  } catch {
    return { host: baseUrl.trim(), port: 8006 };
  }
}

function normalizeChatBody(value: unknown): string {
  const body = typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
  if (!body) throw new Error("Write a message before sending.");
  if (body.length > CHAT_BODY_MAX) throw new Error(`Chat messages are limited to ${CHAT_BODY_MAX} characters.`);
  return body;
}

function normalizeBoardListTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title) throw new Error("Give the list a name.");
  if (title.length > BOARD_LIST_TITLE_MAX) throw new Error(`List names are limited to ${BOARD_LIST_TITLE_MAX} characters.`);
  return title;
}

function normalizeBoardTaskTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title) throw new Error("Give the task a title.");
  if (title.length > BOARD_TASK_TITLE_MAX) throw new Error(`Task titles are limited to ${BOARD_TASK_TITLE_MAX} characters.`);
  return title;
}

function normalizeBoardTaskDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const detail = typeof value === "string" ? value.trim() : "";
  if (!detail) return undefined;
  if (detail.length > BOARD_TASK_DETAIL_MAX) throw new Error(`Task notes are limited to ${BOARD_TASK_DETAIL_MAX} characters.`);
  return detail;
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  // Spreadsheet formula injection is a real export risk even for a local app.
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * SQLite-backed team directory.
 *
 * sql.js is used deliberately instead of a native SQLite addon: Nexus ships as
 * a portable Electron build with npmRebuild disabled, so a native module would
 * make the packaged app depend on the build machine's ABI. The database is
 * still ordinary SQLite and is persisted atomically to `<Nexus home>/team.sqlite`.
 */
export class TeamService {
  private readonly db: Database;
  private readonly file: string;
  private currentUserId: string | null = null;
  private currentSessionId: string | null = null;
  private lastTouchAt = 0;
  private closed = false;

  private constructor(db: Database, file: string) {
    this.db = db;
    this.file = file;
  }

  static async open(appRoot: string): Promise<TeamService> {
    const wasm = [
      path.join(appRoot, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
      path.join(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
      path.join(__dirname, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    ].find((candidate) => fs.existsSync(candidate));
    if (!wasm) {
      throw new Error("sql.js WASM runtime is missing. Run npm install before starting Nexus.");
    }

    const bytes = fs.readFileSync(wasm);
    const wasmBinary = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const SQL = await initSqlJs({ wasmBinary });
    const file = path.join(nexusHome(), "team.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const db = fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
    const service = new TeamService(db, file);
    service.migrate();
    service.persist();
    return service;
  }

  close(): void {
    if (this.closed) return;
    try {
      this.persist();
    } finally {
      this.closed = true;
      this.db.close();
    }
  }

  /* --------------------------------------------------------------- schema */

  private migrate(): void {
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('superadmin', 'admin', 'moderator', 'user')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        color TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        links_updated_at INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS machine_links (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        machine_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        PRIMARY KEY (user_id, machine_id)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        actor_id TEXT,
        actor_name TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        target_name TEXT,
        detail TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS login_throttle (
        key TEXT PRIMARY KEY,
        failed_count INTEGER NOT NULL,
        first_failed_at INTEGER NOT NULL,
        last_failed_at INTEGER NOT NULL,
        locked_until INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_user_tombstones (
        username TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_machine_tombstones (
        key TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS team_chat_messages (
        id TEXT PRIMARY KEY,
        author_id TEXT,
        author_username TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_role TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS team_board_lists (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_by_username TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS team_board_tasks (
        id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        author_username TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS board_list_tombstones (
        id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS board_task_tombstones (
        id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      )
    `);
    this.ensureColumn("machines", "source", "TEXT NOT NULL DEFAULT 'local'");
    this.ensureColumn("machines", "links_updated_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("machines", "kind", "TEXT NOT NULL DEFAULT 'ssh'");
    this.ensureColumn("machines", "base_url", "TEXT");
    this.db.run("CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS links_machine ON machine_links(machine_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS activity_at ON activity(at)");
    this.db.run("CREATE INDEX IF NOT EXISTS activity_actor ON activity(actor_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS login_throttle_lock ON login_throttle(locked_until)");
    this.db.run("CREATE INDEX IF NOT EXISTS team_chat_created ON team_chat_messages(created_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS board_tasks_list ON team_board_tasks(list_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS board_tasks_updated ON team_board_tasks(updated_at)");
    this.db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('workspace_name', 'Nexus Operations')");
    this.db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('workspace_updated_at', ?)", [Date.now()]);
    this.db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('schema_version', '1')");
    this.migrateMachineLinkRevisions();
    this.migrateSuperAdminRole();
    this.ensureSuperAdminPresent();
    this.ensureDefaultBoardLists();
  }

  /**
   * Pre-1.0.12 created local machine rows with links_updated_at set to the
   * insert time. That makes a real grant from another computer look older, so
   * a later sync never applies it. Reset only rows whose revision is still the
   * exact insert marker and which have no link or machine-link audit history;
   * rows with any evidence of an edit keep their revision.
   */
  private migrateMachineLinkRevisions(): void {
    const current = this.one("SELECT value FROM settings WHERE key = 'schema_version'");
    if (Number(current?.value ?? 0) >= TEAM_SCHEMA_VERSION) return;

    this.transaction(() => {
      this.run(`
        UPDATE machines
        SET links_updated_at = 0
        WHERE source = 'local'
          AND links_updated_at > 0
          AND links_updated_at = updated_at
          AND NOT EXISTS (
            SELECT 1 FROM machine_links WHERE machine_links.machine_id = machines.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM activity
            WHERE activity.action = 'machine.links'
              AND activity.target_type = 'machine'
              AND activity.target_id = machines.id
          )
      `);
      this.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)", [
        String(TEAM_SCHEMA_VERSION),
      ]);
    });
  }

  private ensureDefaultBoardLists(): void {
    if (this.count("SELECT COUNT(*) AS count FROM team_board_lists") > 0) return;
    const now = Date.now();
    for (const list of DEFAULT_BOARD_LISTS) {
      this.run(
        "INSERT OR IGNORE INTO team_board_lists (id, title, position, created_by_username, created_at, updated_at) VALUES (?, ?, ?, 'system', ?, ?)",
        [list.id, list.title, list.position, now, now],
      );
    }
  }

  /**
   * SQLite cannot widen an existing CHECK constraint in place. Older Nexus
   * databases only allow admin/moderator/user, so rebuild the users table once
   * while preserving every id, password hash, session and machine link.
   */
  private migrateSuperAdminRole(): void {
    const table = this.one("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'");
    if (!table || String(table.sql ?? "").toLowerCase().includes("superadmin")) return;

    this.db.run("PRAGMA foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.db.run("DROP TABLE IF EXISTS users_superadmin_migration");
        this.db.run(`
          CREATE TABLE users_superadmin_migration (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('superadmin', 'admin', 'moderator', 'user')),
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
            password_salt TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_login_at INTEGER
          )
        `);
        this.run(`
          INSERT INTO users_superadmin_migration
            (id, username, display_name, role, status, password_salt, password_hash, created_at, updated_at, last_login_at)
          SELECT id, username, display_name, role, status, password_salt, password_hash, created_at, updated_at, last_login_at
          FROM users
        `);
        this.db.run("DROP TABLE users");
        this.db.run("ALTER TABLE users_superadmin_migration RENAME TO users");
      });
    } finally {
      this.db.run("PRAGMA foreign_keys = ON");
    }
  }

  /**
   * The first/owner account is the super admin. Normally bootstrap writes that
   * role directly; this also repairs a legacy workspace or a sync snapshot that
   * would otherwise leave no active super admin behind.
   */
  private ensureSuperAdminPresent(): void {
    if (this.count("SELECT COUNT(*) AS count FROM users") === 0) return;
    if (this.count("SELECT COUNT(*) AS count FROM users WHERE role = 'superadmin' AND status = 'active'") > 0) return;

    // Only an existing admin is eligible. Never silently grant super-admin
    // rights to a moderator or standard member while repairing legacy data.
    const owner =
      this.one("SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at ASC, rowid ASC LIMIT 1") ??
      this.one("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, rowid ASC LIMIT 1");
    if (!owner) return;
    this.transaction(() => {
      this.run("UPDATE users SET role = 'superadmin', updated_at = ? WHERE id = ?", [Date.now(), String(owner.id)]);
    });
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.all(`PRAGMA table_info(${table})`).map((row) => String(row.name));
    if (!columns.includes(column)) this.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private persist(): void {
    if (this.closed) return;
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, Buffer.from(this.db.export()), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows uses the profile ACL instead of POSIX modes. */
    }
  }

  private all(sql: string, params: Param[] = []): Row[] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows: Row[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as Row);
      return rows;
    } finally {
      statement.free();
    }
  }

  private one(sql: string, params: Param[] = []): Row | null {
    return this.all(sql, params)[0] ?? null;
  }

  private run(sql: string, params: Param[] = []): void {
    this.db.run(sql, params);
  }

  private count(sql: string, params: Param[] = []): number {
    return Number(this.one(sql, params)?.count ?? 0);
  }

  private transaction<T>(work: () => T): T {
    this.db.run("BEGIN");
    try {
      const result = work();
      this.db.run("COMMIT");
      this.persist();
      return result;
    } catch (error) {
      try {
        this.db.run("ROLLBACK");
      } catch {
        /* preserve the original failure */
      }
      throw error;
    }
  }

  /* --------------------------------------------------------------- users */

  status(): TeamAuthState {
    const initialized = this.count("SELECT COUNT(*) AS count FROM users") > 0;
    if (!initialized || !this.currentUserId || !this.currentSessionId) {
      if (!initialized) this.clearSession();
      return { initialized, user: null, expiresAt: null };
    }

    const session = this.one("SELECT expires_at FROM sessions WHERE id = ? AND user_id = ?", [
      this.currentSessionId,
      this.currentUserId,
    ]);
    if (!session || Number(session.expires_at) <= Date.now()) {
      this.clearSession();
      return { initialized, user: null, expiresAt: null };
    }

    const user = this.toTeamUser(this.currentUserId);
    if (!user || user.status !== "active") {
      this.clearSession();
      return { initialized, user: null, expiresAt: null };
    }

    this.touchSession();
    return { initialized, user, expiresAt: Number(session.expires_at) };
  }

  hasUsers(): boolean {
    return this.count("SELECT COUNT(*) AS count FROM users") > 0;
  }

  /**
   * Discard this computer's local team directory. Used only when an operator
   * explicitly adopts an existing relay workspace after accidentally creating
   * a standalone one. SSH keys and host credentials live outside this database
   * and are not touched.
   */
  replaceDirectory(): void {
    this.clearSession();
    this.transaction(() => {
      this.run("DELETE FROM sessions");
      this.run("DELETE FROM machine_links");
      this.run("DELETE FROM users");
      this.run("DELETE FROM machines");
      this.run("DELETE FROM activity");
      this.run("DELETE FROM team_chat_messages");
      this.run("DELETE FROM team_board_tasks");
      this.run("DELETE FROM team_board_lists");
      this.run("DELETE FROM sync_user_tombstones");
      this.run("DELETE FROM sync_machine_tombstones");
      this.run("DELETE FROM board_list_tombstones");
      this.run("DELETE FROM board_task_tombstones");
      this.run("DELETE FROM login_throttle");
      // Keep schema_version so the next launch does not run a data migration
      // against the freshly imported relay directory.
      this.run("DELETE FROM settings WHERE key IN ('workspace_name', 'workspace_updated_at')");
    });
  }

  /**
   * Adopt the relay's workspace identity before applying its snapshot so a
   * fresh station's default name and timestamp cannot overwrite the team's.
   */
  adoptWorkspaceMetadata(name: string, updatedAt: number): void {
    const workspaceName = (name ?? "").trim() || "Nexus Operations";
    const workspaceUpdatedAt = Number(updatedAt) > 0 ? Number(updatedAt) : 1;
    this.transaction(() => {
      this.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('workspace_name', ?)", [workspaceName]);
      this.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('workspace_updated_at', ?)", [
        workspaceUpdatedAt,
      ]);
    });
  }

  /** Extend only the current session; a member cannot revive another device. */
  refreshSession(): TeamAuthState {
    const state = this.status();
    if (!state.user || !this.currentSessionId) return state;
    const expiresAt = Date.now() + SESSION_MS;
    this.run("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?", [
      expiresAt,
      Date.now(),
      this.currentSessionId,
    ]);
    this.persist();
    return { ...state, expiresAt };
  }

  currentUser(): TeamUser {
    const state = this.status();
    if (!state.user) throw new Error("Sign in to Nexus to continue.");
    return state.user;
  }

  async bootstrap(input: TeamBootstrapInput): Promise<TeamUser> {
    if (this.count("SELECT COUNT(*) AS count FROM users") > 0) {
      throw new Error("This workspace already has an owner. Sign in instead.");
    }
    const username = normalizeUsername(input?.username ?? "");
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
      throw new Error("Username must be 3–32 characters: letters, numbers, dots, dashes or underscores.");
    }
    const displayName = normalizeDisplayName(input?.displayName ?? "");
    const password = normalizePassword(input?.password ?? "");
    const now = Date.now();
    const id = uid();
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
    const user = this.toTeamUser(id) ?? {
      id,
      username,
      displayName,
      role: "superadmin" as const,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
      linkedMachines: 0,
      online: false,
    };

    this.transaction(() => {
      this.run(
        "INSERT INTO users (id, username, display_name, role, status, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, 'superadmin', 'active', ?, ?, ?, ?)",
        [id, username, displayName, salt, passwordHash, now, now],
      );
      this.audit(
        { ...user, id, username, displayName, role: "superadmin", status: "active" },
        "workspace.bootstrap",
        "workspace",
        "workspace",
        "Nexus Operations",
        "Created the workspace owner account as Super admin",
      );
    });

    return this.login({ username, password });
  }

  async login(input: TeamLoginInput): Promise<TeamUser> {
    const username = normalizeUsername(input?.username ?? "");
    const password = input?.password ?? "";
    const throttleKey = username || "__unknown__";
    this.assertLoginAllowed(throttleKey);
    const row = this.one("SELECT * FROM users WHERE username = ?", [username]);
    if (!row || !this.verifyPassword(password, String(row.password_salt), String(row.password_hash))) {
      const lockedFor = this.recordLoginFailure(throttleKey);
      if (lockedFor > 0) {
        throw new Error(`Too many failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60_000)} minute${lockedFor > 60_000 ? "s" : ""}.`);
      }
      throw new Error("Invalid username or password.");
    }
    if (String(row.status) !== "active") throw new Error("This account is suspended. Ask an admin to restore it.");

    const userId = String(row.id);
    const now = Date.now();
    const sessionId = uid();
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = sha256(token);

    this.transaction(() => {
      this.run("DELETE FROM sessions WHERE expires_at <= ?", [now]);
      this.run(
        "INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        [sessionId, userId, tokenHash, now, now, now + SESSION_MS],
      );
      this.run("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?", [now, now, userId]);
    });

    this.currentUserId = userId;
    this.currentSessionId = sessionId;
    this.lastTouchAt = now;
    this.clearLoginFailures(throttleKey);
    const user = this.toTeamUser(userId);
    if (!user) throw new Error("Account disappeared during sign-in.");
    this.transaction(() => this.audit(user, "auth.login", "session", sessionId, user.displayName, "Signed in"));
    return this.toTeamUser(userId) ?? user;
  }

  async logout(): Promise<void> {
    const user = this.currentUserId ? this.toTeamUser(this.currentUserId) : null;
    const sessionId = this.currentSessionId;
    if (user) {
      this.transaction(() => {
        this.audit(user, "auth.logout", "session", sessionId ?? undefined, user.displayName, "Signed out");
        if (sessionId) this.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
      });
    }
    this.clearSession();
  }

  async changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    const actor = this.currentUser();
    const row = this.one("SELECT password_salt, password_hash FROM users WHERE id = ?", [actor.id]);
    if (!row || !this.verifyPassword(currentPassword, String(row.password_salt), String(row.password_hash))) {
      throw new Error("Current password is incorrect.");
    }
    const next = normalizePassword(nextPassword);
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(next, salt, 64).toString("hex");
    this.transaction(() => {
      this.run("UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?", [
        salt,
        hash,
        Date.now(),
        actor.id,
      ]);
      this.run("DELETE FROM sessions WHERE user_id = ? AND id <> ?", [actor.id, this.currentSessionId ?? ""]);
      this.audit(actor, "user.password", "user", actor.id, actor.displayName, "Changed their own password");
    });
  }

  overview(): TeamOverview {
    const actor = this.currentUser();
    this.cleanupSessions();
    const users = this.listUsers(actor);
    const machines = this.listMachines(actor);
    const activity = this.listActivity(actor);
    const permissions = this.permissions(actor);
    const admins = users.filter((user) => user.role === "admin" || user.role === "superadmin").length;
    const moderators = users.filter((user) => user.role === "moderator").length;
    return {
      workspaceName: String(this.one("SELECT value FROM settings WHERE key = 'workspace_name'")?.value ?? "Nexus Operations"),
      database: "SQLite",
      users,
      machines,
      activity,
      counts: {
        members: users.length,
        admins,
        moderators,
        machines: machines.length,
        links: machines.reduce((sum, machine) => sum + machine.linkedUserIds.length, 0),
        online: users.filter((user) => user.online).length,
      },
      permissions,
    };
  }

  createUser(input: TeamUserInput): TeamOverview {
    const actor = this.currentUser();
    this.assertManager(actor);
    const username = normalizeUsername(input?.username ?? "");
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
      throw new Error("Username must be 3–32 characters: letters, numbers, dots, dashes or underscores.");
    }
    const displayName = normalizeDisplayName(input?.displayName ?? "");
    const role = normalizeRole(input?.role ?? "user");
    if (actor.role === "moderator" && role !== "user") {
      throw new Error("Moderators can only create standard members.");
    }
    if (role === "superadmin" && actor.role !== "superadmin") {
      throw new Error("Only a super admin can create another super admin.");
    }
    if (this.one("SELECT id FROM users WHERE username = ?", [username])) {
      throw new Error(`The username “${username}” is already in use.`);
    }
    const password = normalizePassword(input?.password ?? "");
    const now = Date.now();
    const id = uid();
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");

    this.transaction(() => {
      this.run(
        "INSERT INTO users (id, username, display_name, role, status, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)",
        [id, username, displayName, role, salt, hash, now, now],
      );
      this.audit(actor, "user.create", "user", id, displayName, `Created ${roleLabel(role)} @${username}`);
    });
    return this.overview();
  }

  updateUser(id: string, patch: TeamUserPatch): TeamOverview {
    const actor = this.currentUser();
    this.assertManager(actor);
    const target = this.userRow(id);
    if (!target) throw new Error("Member not found.");
    const targetRole = normalizeRole(String(target.role));
    const targetStatus = normalizeStatus(String(target.status));
    const nextRole = patch.role === undefined ? targetRole : normalizeRole(patch.role);
    const nextStatus = patch.status === undefined ? targetStatus : normalizeStatus(patch.status);
    const nextName = patch.displayName === undefined ? String(target.display_name) : normalizeDisplayName(patch.displayName);

    if (actor.role === "moderator" && (targetRole !== "user" || nextRole !== "user")) {
      throw new Error("Moderators can only manage standard member accounts.");
    }
    if (actor.role !== "superadmin" && (targetRole === "superadmin" || nextRole === "superadmin")) {
      throw new Error("Only a super admin can manage a super admin.");
    }
    if (id === actor.id && nextRole !== targetRole) throw new Error("You cannot change your own role.");
    if (id === actor.id && nextStatus !== "active") throw new Error("You cannot suspend your own account.");
    const activeElevated = this.count(
      "SELECT COUNT(*) AS count FROM users WHERE role IN ('admin', 'superadmin') AND status = 'active'",
    );
    const activeSuperAdmins = this.count("SELECT COUNT(*) AS count FROM users WHERE role = 'superadmin' AND status = 'active'");
    const wasActiveSuperAdmin = targetRole === "superadmin" && targetStatus === "active";
    const remainsActiveSuperAdmin = nextRole === "superadmin" && nextStatus === "active";
    if (wasActiveSuperAdmin && !remainsActiveSuperAdmin && activeSuperAdmins <= 1) {
      throw new Error("The workspace needs at least one active super admin.");
    }
    const wasActiveElevated = (targetRole === "admin" || targetRole === "superadmin") && targetStatus === "active";
    const remainsActiveElevated = (nextRole === "admin" || nextRole === "superadmin") && nextStatus === "active";
    if (wasActiveElevated && !remainsActiveElevated && activeElevated <= 1) {
      throw new Error("The workspace needs at least one active admin or super admin.");
    }

    let salt: string | null = null;
    let hash: string | null = null;
    let passwordChanged = false;
    if (patch.password !== undefined && patch.password !== "") {
      const password = normalizePassword(patch.password);
      salt = crypto.randomBytes(16).toString("hex");
      hash = crypto.scryptSync(password, salt, 64).toString("hex");
      passwordChanged = true;
    }

    const now = Date.now();
    this.transaction(() => {
      this.run(
        "UPDATE users SET display_name = ?, role = ?, status = ?, updated_at = ?, password_salt = COALESCE(?, password_salt), password_hash = COALESCE(?, password_hash) WHERE id = ?",
        [nextName, nextRole, nextStatus, now, salt, hash, id],
      );
      if (nextStatus === "suspended" || passwordChanged) {
        // A reset or suspension revokes every other session; the acting
        // admin's current session survives when they reset their own password.
        this.run("DELETE FROM sessions WHERE user_id = ? AND id <> ?", [id, this.currentSessionId ?? ""]);
      }
      const changes = [
        nextName !== String(target.display_name) ? "display name" : "",
        nextRole !== targetRole ? `role=${roleLabel(nextRole)}` : "",
        nextStatus !== targetStatus ? `status=${nextStatus}` : "",
        passwordChanged ? "password reset" : "",
      ].filter(Boolean);
      this.audit(
        actor,
        "user.update",
        "user",
        id,
        nextName,
        changes.length > 0 ? changes.join(", ") : "Profile updated",
      );
    });
    return this.overview();
  }

  deleteUser(id: string): TeamOverview {
    const actor = this.currentUser();
    if (actor.role === "moderator" || actor.role === "user") throw new Error("Admin or super admin access required.");
    if (id === actor.id) throw new Error("You cannot delete the account you are signed in with.");
    const target = this.userRow(id);
    if (!target) throw new Error("Member not found.");
    const targetRole = normalizeRole(String(target.role));
    if (targetRole === "superadmin" && actor.role !== "superadmin") {
      throw new Error("Only a super admin can delete a super admin.");
    }
    const activeElevated = this.count(
      "SELECT COUNT(*) AS count FROM users WHERE role IN ('admin', 'superadmin') AND status = 'active'",
    );
    if ((targetRole === "admin" || targetRole === "superadmin") && String(target.status) === "active" && activeElevated <= 1) {
      throw new Error("The workspace needs at least one active admin or super admin.");
    }
    const activeSuperAdmins = this.count("SELECT COUNT(*) AS count FROM users WHERE role = 'superadmin' AND status = 'active'");
    if (targetRole === "superadmin" && String(target.status) === "active" && activeSuperAdmins <= 1) {
      throw new Error("The workspace needs at least one active super admin.");
    }
    const targetName = String(target.display_name);
    const now = Date.now();
    this.transaction(() => {
      this.run("INSERT OR REPLACE INTO sync_user_tombstones (username, deleted_at) VALUES (?, ?)", [
        String(target.username),
        now,
      ]);
      this.run("DELETE FROM users WHERE id = ?", [id]);
      this.audit(actor, "user.delete", "user", id, targetName, `Removed @${String(target.username)}`);
    });
    return this.overview();
  }

  setMachineLinks(machineId: string, userIds: string[]): TeamOverview {
    const actor = this.currentUser();
    this.assertManager(actor);
    const machine = this.one("SELECT id, label FROM machines WHERE id = ?", [machineId]);
    if (!machine) throw new Error("Machine not found. Refresh the SSH inventory and try again.");
    const unique = [...new Set(userIds.filter((id) => typeof id === "string" && id.length > 0))];
    const existing = new Set(
      this.all("SELECT user_id FROM machine_links WHERE machine_id = ?", [machineId]).map((row) => String(row.user_id)),
    );
    for (const userId of unique) {
      const target = this.userRow(userId);
      if (!target) throw new Error("One of the selected members no longer exists.");
      // Moderators may preserve existing admin/moderator links, but cannot add
      // new ones. Those roles already have implicit access to every machine.
      if (actor.role === "moderator" && String(target.role) !== "user" && !existing.has(userId)) {
        throw new Error("Moderators can only grant machines to standard members.");
      }
    }

    this.transaction(() => {
      const now = Date.now();
      for (const userId of existing) {
        if (!unique.includes(userId)) this.run("DELETE FROM machine_links WHERE machine_id = ? AND user_id = ?", [machineId, userId]);
      }
      for (const userId of unique) {
        if (!existing.has(userId)) {
          this.run("INSERT INTO machine_links (user_id, machine_id, created_at, created_by) VALUES (?, ?, ?, ?)", [
            userId,
            machineId,
            now,
            actor.id,
          ]);
        }
      }
      this.run("UPDATE machines SET links_updated_at = ? WHERE id = ?", [now, machineId]);
      this.audit(
        actor,
        "machine.links",
        "machine",
        machineId,
        String(machine.label),
        `${unique.length} member${unique.length === 1 ? "" : "s"} linked`,
      );
    });
    return this.overview();
  }

  /**
   * Replace a member's complete machine grant set in one transaction. A
   * failure while adding or removing any link rolls the whole set back, so the
   * member can never end up with only part of the selected machines.
   */
  setUserMachineLinks(userId: string, machineIds: string[]): TeamOverview {
    const actor = this.currentUser();
    this.assertManager(actor);
    const target = this.userRow(userId);
    if (!target) throw new Error("Member not found.");
    if (actor.role === "moderator" && normalizeRole(String(target.role)) !== "user") {
      throw new Error("Moderators can only manage standard member access.");
    }

    const wanted = [...new Set(machineIds.filter((id) => typeof id === "string" && id.length > 0))];
    const available = new Set(this.all("SELECT id FROM machines").map((row) => String(row.id)));
    if (wanted.some((id) => !available.has(id))) {
      throw new Error("One of the selected machines no longer exists. Refresh the inventory and try again.");
    }

    const existing = new Set(
      this.all("SELECT machine_id FROM machine_links WHERE user_id = ?", [userId]).map((row) => String(row.machine_id)),
    );
    const desired = new Set(wanted);
    const added = wanted.filter((id) => !existing.has(id));
    const removed = [...existing].filter((id) => !desired.has(id));
    if (added.length === 0 && removed.length === 0) return this.overview();

    this.transaction(() => {
      const now = Date.now();
      for (const machineId of removed) {
        this.run("DELETE FROM machine_links WHERE user_id = ? AND machine_id = ?", [userId, machineId]);
      }
      for (const machineId of added) {
        this.run("INSERT INTO machine_links (user_id, machine_id, created_at, created_by) VALUES (?, ?, ?, ?)", [
          userId,
          machineId,
          now,
          actor.id,
        ]);
      }
      for (const machineId of new Set([...added, ...removed])) {
        this.run("UPDATE machines SET links_updated_at = ? WHERE id = ?", [now, machineId]);
      }
      this.audit(
        actor,
        "machine.links",
        "user",
        userId,
        String(target.display_name),
        wanted.length === 0
          ? "All machine access revoked"
          : `${wanted.length} machine${wanted.length === 1 ? "" : "s"} granted`,
      );
    });
    return this.overview();
  }

  removeMachine(machineId: string, actor: TeamUser): void {
    if (actor.role === "user") throw new Error("Admin or moderator access required.");
    const machine = this.one("SELECT label, kind, base_url, host, port, username FROM machines WHERE id = ?", [machineId]);
    if (!machine) return;
    const now = Date.now();
    this.transaction(() => {
      this.run("INSERT OR REPLACE INTO sync_machine_tombstones (key, deleted_at) VALUES (?, ?)", [
        machineSyncKey(machine),
        now,
      ]);
      this.run("DELETE FROM machine_links WHERE machine_id = ?", [machineId]);
      this.run("DELETE FROM machines WHERE id = ?", [machineId]);
      this.audit(actor, "machine.remove", "machine", machineId, String(machine.label), "Removed from the SSH inventory");
    });
  }

  /* ------------------------------------------------------------ team chat */

  chat(): TeamChat {
    this.currentUser();
    const rows = this.all("SELECT * FROM team_chat_messages ORDER BY created_at DESC LIMIT ?", [CHAT_VIEW_LIMIT]);
    return { messages: rows.reverse().map((row) => this.chatMessageFromRow(row)) };
  }

  postChatMessage(body: string): TeamChat {
    const actor = this.currentUser();
    const text = normalizeChatBody(body);
    const now = Date.now();
    this.transaction(() => {
      this.run(
        "INSERT INTO team_chat_messages (id, author_id, author_username, author_name, author_role, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [uid(), actor.id, actor.username, actor.displayName, actor.role, text, now],
      );
      this.run(
        "DELETE FROM team_chat_messages WHERE id NOT IN (SELECT id FROM team_chat_messages ORDER BY created_at DESC LIMIT ?)",
        [CHAT_STORE_LIMIT],
      );
    });
    return this.chat();
  }

  /* -------------------------------------------------------------- billboard */

  board(): TeamBoard {
    this.currentUser();
    return { lists: this.listBoardLists(), tasks: this.listBoardTasks() };
  }

  createBoardList(title: string): TeamBoard {
    const actor = this.currentUser();
    if (this.count("SELECT COUNT(*) AS count FROM team_board_lists") >= BOARD_LIST_LIMIT) {
      throw new Error(`The billboard is limited to ${BOARD_LIST_LIMIT} lists.`);
    }
    const name = normalizeBoardListTitle(title);
    const next = this.one("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM team_board_lists");
    const now = Date.now();
    this.transaction(() => {
      this.run(
        "INSERT INTO team_board_lists (id, title, position, created_by_username, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [uid(), name, Number(next?.position ?? 0), actor.username, now, now],
      );
    });
    return this.board();
  }

  deleteBoardList(id: string): TeamBoard {
    const actor = this.currentUser();
    const list = this.one("SELECT * FROM team_board_lists WHERE id = ?", [id]);
    if (!list) throw new Error("Board list not found.");
    if (this.count("SELECT COUNT(*) AS count FROM team_board_lists") <= 1) {
      throw new Error("Keep at least one board list.");
    }
    if (actor.role === "user" && String(list.created_by_username ?? "") !== actor.username) {
      throw new Error("Only the list creator, an admin or a moderator can delete this list.");
    }
    const taskIds = this.all("SELECT id FROM team_board_tasks WHERE list_id = ?", [id]).map((row) => String(row.id));
    const now = Date.now();
    this.transaction(() => {
      for (const taskId of taskIds) {
        this.run("INSERT OR REPLACE INTO board_task_tombstones (id, deleted_at) VALUES (?, ?)", [taskId, now]);
      }
      this.run("DELETE FROM team_board_tasks WHERE list_id = ?", [id]);
      this.run("INSERT OR REPLACE INTO board_list_tombstones (id, deleted_at) VALUES (?, ?)", [id, now]);
      this.run("DELETE FROM team_board_lists WHERE id = ?", [id]);
    });
    return this.board();
  }

  createBoardTask(input: TeamBoardTaskInput): TeamBoard {
    const actor = this.currentUser();
    if (this.count("SELECT COUNT(*) AS count FROM team_board_tasks") >= BOARD_TASK_LIMIT) {
      throw new Error(`The billboard is limited to ${BOARD_TASK_LIMIT} tasks.`);
    }
    const listId = typeof input?.listId === "string" ? input.listId.trim() : "";
    if (!this.one("SELECT id FROM team_board_lists WHERE id = ?", [listId])) {
      throw new Error("Choose an existing board list.");
    }
    const title = normalizeBoardTaskTitle(input?.title);
    const detail = normalizeBoardTaskDetail(input?.detail);
    const now = Date.now();
    this.transaction(() => {
      this.run(
        "INSERT INTO team_board_tasks (id, list_id, title, detail, pinned, author_username, author_name, author_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          uid(),
          listId,
          title,
          detail ?? null,
          input?.pinned === true ? 1 : 0,
          actor.username,
          actor.displayName,
          actor.role,
          now,
          now,
        ],
      );
    });
    return this.board();
  }

  updateBoardTask(id: string, patch: TeamBoardTaskPatch): TeamBoard {
    this.currentUser();
    const task = this.one("SELECT * FROM team_board_tasks WHERE id = ?", [id]);
    if (!task) throw new Error("Board task not found.");
    const nextListId = patch?.listId === undefined ? String(task.list_id) : patch.listId.trim();
    if (!this.one("SELECT id FROM team_board_lists WHERE id = ?", [nextListId])) {
      throw new Error("Choose an existing board list.");
    }
    const title = patch?.title === undefined ? String(task.title) : normalizeBoardTaskTitle(patch.title);
    const detail =
      patch?.detail === undefined ? (task.detail === null ? undefined : String(task.detail)) : normalizeBoardTaskDetail(patch.detail);
    const pinned = patch?.pinned === undefined ? Boolean(task.pinned) : patch.pinned === true;
    this.transaction(() => {
      this.run("UPDATE team_board_tasks SET list_id = ?, title = ?, detail = ?, pinned = ?, updated_at = ? WHERE id = ?", [
        nextListId,
        title,
        detail ?? null,
        pinned ? 1 : 0,
        Date.now(),
        id,
      ]);
    });
    return this.board();
  }

  deleteBoardTask(id: string): TeamBoard {
    const actor = this.currentUser();
    const task = this.one("SELECT * FROM team_board_tasks WHERE id = ?", [id]);
    if (!task) throw new Error("Board task not found.");
    if (actor.role === "user" && String(task.author_username) !== actor.username) {
      throw new Error("Only the task author, an admin or a moderator can delete this task.");
    }
    this.transaction(() => {
      this.run("INSERT OR REPLACE INTO board_task_tombstones (id, deleted_at) VALUES (?, ?)", [id, Date.now()]);
      this.run("DELETE FROM team_board_tasks WHERE id = ?", [id]);
    });
    return this.board();
  }

  syncMachines(hosts: SshHostSummary[]): void {
    const now = Date.now();
    let changed = false;
    const hostIds = new Set(hosts.map((host) => host.id));
    for (const row of this.all("SELECT id, source, kind, host, port, username FROM machines")) {
      const id = String(row.id);
      if (hostIds.has(id)) continue;
      if (String(row.source) === "remote") continue;
      if (String(row.kind ?? "ssh") !== "ssh") continue;
      this.run("INSERT OR REPLACE INTO sync_machine_tombstones (key, deleted_at) VALUES (?, ?)", [
        machineKey(String(row.host), Number(row.port), String(row.username)),
        now,
      ]);
      this.run("DELETE FROM machine_links WHERE machine_id = ?", [id]);
      this.run("DELETE FROM machines WHERE id = ?", [id]);
      changed = true;
    }
    for (const host of hosts) {
      let existing = this.one("SELECT * FROM machines WHERE id = ?", [host.id]);
      if (!existing) {
        // A machine synced from another computer becomes local when this
        // computer adds the same endpoint. Carry its grants across.
        const remote = this.one(
          "SELECT * FROM machines WHERE lower(host) = ? AND port = ? AND lower(username) = ? AND source = 'remote' AND kind = 'ssh'",
          [host.host.toLowerCase(), host.port, host.username.toLowerCase()],
        );
        if (remote) {
          const remoteId = String(remote.id);
          this.run("UPDATE machine_links SET machine_id = ? WHERE machine_id = ?", [host.id, remoteId]);
          // Keep the synced link revision so a later snapshot cannot mistake
          // this machine's carried-over grants for an older local edit.
          this.run("UPDATE machines SET links_updated_at = ? WHERE id = ?", [
            Number(remote.links_updated_at) || 0,
            host.id,
          ]);
          this.run("DELETE FROM machines WHERE id = ?", [remoteId]);
          existing = this.one("SELECT * FROM machines WHERE id = ?", [host.id]);
        }
      }
      if (!existing) {
        // A freshly discovered endpoint has never had its grants edited on
        // this computer, so it starts at revision 0. Using the insert time
        // here would make grants pulled from another computer look stale and
        // they would never be applied.
        this.run(
          "INSERT INTO machines (id, label, host, port, username, color, updated_at, source, links_updated_at, kind, base_url) VALUES (?, ?, ?, ?, ?, ?, ?, 'local', 0, 'ssh', NULL)",
          [host.id, host.label, host.host, host.port, host.username, host.color, now],
        );
        changed = true;
        continue;
      }
      if (
        String(existing.label) !== host.label ||
        String(existing.host) !== host.host ||
        Number(existing.port) !== host.port ||
        String(existing.username) !== host.username ||
        String(existing.color) !== host.color
      ) {
        this.run("UPDATE machines SET label = ?, host = ?, port = ?, username = ?, color = ?, updated_at = ?, source = 'local' WHERE id = ?", [
          host.label,
          host.host,
          host.port,
          host.username,
          host.color,
          now,
          host.id,
        ]);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /**
   * Mirror the local Proxmox endpoints into the workspace directory without
   * exporting credentials. Members see the endpoint and can add it to their
   * own station with their own API token.
   */
  syncPveHosts(hosts: HostSummary[]): void {
    const now = Date.now();
    let changed = false;
    const wanted = new Map<string, HostSummary>();
    for (const host of hosts) {
      const baseUrl = host.baseUrl.trim().replace(/\/+$/, "");
      if (!baseUrl) continue;
      wanted.set(normalizePveBaseUrl(baseUrl), { ...host, baseUrl });
    }
    for (const row of this.all("SELECT id, source, kind, base_url FROM machines WHERE kind = 'pve'")) {
      const key = `pve:${normalizePveBaseUrl(String(row.base_url ?? ""))}`;
      if (wanted.has(normalizePveBaseUrl(String(row.base_url ?? "")))) continue;
      if (String(row.source) === "remote") continue;
      this.run("INSERT OR REPLACE INTO sync_machine_tombstones (key, deleted_at) VALUES (?, ?)", [key, now]);
      this.run("DELETE FROM machine_links WHERE machine_id = ?", [String(row.id)]);
      this.run("DELETE FROM machines WHERE id = ?", [String(row.id)]);
      changed = true;
    }
    for (const [key, host] of wanted) {
      const endpoint = pveEndpoint(host.baseUrl);
      let existing = this.one("SELECT * FROM machines WHERE id = ?", [host.id]);
      let carriedLinksUpdatedAt = 0;
      if (!existing) {
        // A Proxmox endpoint synced from another station becomes local when
        // this station adds the same API URL. Carry its grants across.
        const remote = this.one(
          "SELECT * FROM machines WHERE kind = 'pve' AND source = 'remote' AND lower(base_url) = ?",
          [normalizePveBaseUrl(host.baseUrl)],
        );
        if (remote) {
          const remoteId = String(remote.id);
          carriedLinksUpdatedAt = Number(remote.links_updated_at) || 0;
          this.run("UPDATE machine_links SET machine_id = ? WHERE machine_id = ?", [host.id, remoteId]);
          this.run("DELETE FROM machines WHERE id = ?", [remoteId]);
          existing = this.one("SELECT * FROM machines WHERE id = ?", [host.id]);
        }
      }
      if (!existing) {
        this.run(
          "INSERT INTO machines (id, label, host, port, username, color, updated_at, source, links_updated_at, kind, base_url) VALUES (?, ?, ?, ?, '', ?, ?, 'local', ?, 'pve', ?)",
          [host.id, host.label, endpoint.host, endpoint.port, host.color, now, carriedLinksUpdatedAt, host.baseUrl],
        );
        changed = true;
        continue;
      }
      if (
        String(existing.label) !== host.label ||
        String(existing.host) !== endpoint.host ||
        Number(existing.port) !== endpoint.port ||
        String(existing.color) !== host.color ||
        String(existing.base_url ?? "") !== host.baseUrl
      ) {
        this.run(
          "UPDATE machines SET label = ?, host = ?, port = ?, color = ?, updated_at = ?, source = 'local', kind = 'pve', base_url = ? WHERE id = ?",
          [host.label, endpoint.host, endpoint.port, host.color, now, host.baseUrl, host.id],
        );
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  canAccessMachine(userId: string, machineId: string): boolean {
    const user = this.userRow(userId);
    if (!user || String(user.status) !== "active") return false;
    if (String(user.role) !== "user") return true;
    return this.count("SELECT COUNT(*) AS count FROM machine_links WHERE user_id = ? AND machine_id = ?", [userId, machineId]) > 0;
  }

  /**
   * Whether a member may still use an SSH key issued for a machine. Elevated
   * roles have implicit access, but every role loses keys for machines that
   * have left the team inventory.
   */
  canUseSshKey(userId: string, machineId?: string): boolean {
    const user = this.userRow(userId);
    if (!user || String(user.status) !== "active") return false;
    if (machineId && !this.one("SELECT id FROM machines WHERE id = ?", [machineId])) return false;
    if (String(user.role) !== "user") return true;
    if (machineId) {
      return this.count("SELECT COUNT(*) AS count FROM machine_links WHERE user_id = ? AND machine_id = ?", [userId, machineId]) > 0;
    }
    return this.count("SELECT COUNT(*) AS count FROM machine_links WHERE user_id = ?", [userId]) > 0;
  }

  /* ------------------------------------------------------------- internals */

  private chatMessageFromRow(row: Row): TeamChatMessage {
    return {
      id: String(row.id),
      authorUsername: String(row.author_username),
      authorName: String(row.author_name),
      authorRole: normalizeRole(String(row.author_role)),
      body: String(row.body),
      createdAt: Number(row.created_at),
    };
  }

  private boardListFromRow(row: Row): TeamBoardList {
    return {
      id: String(row.id),
      title: String(row.title),
      position: Number(row.position),
      createdByUsername: row.created_by_username === null ? undefined : String(row.created_by_username),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private boardTaskFromRow(row: Row): TeamBoardTask {
    return {
      id: String(row.id),
      listId: String(row.list_id),
      title: String(row.title),
      detail: row.detail === null ? undefined : String(row.detail),
      pinned: Boolean(row.pinned),
      authorUsername: String(row.author_username),
      authorName: String(row.author_name),
      authorRole: normalizeRole(String(row.author_role)),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private listBoardLists(): TeamBoardList[] {
    return this.all("SELECT * FROM team_board_lists ORDER BY position ASC, created_at ASC").map((row) =>
      this.boardListFromRow(row),
    );
  }

  private listBoardTasks(): TeamBoardTask[] {
    return this.all("SELECT * FROM team_board_tasks ORDER BY pinned DESC, created_at ASC").map((row) =>
      this.boardTaskFromRow(row),
    );
  }

  private userRow(id: string): Row | null {
    return this.one("SELECT * FROM users WHERE id = ?", [id]);
  }

  private toTeamUser(id: string): TeamUser | null {
    const row = this.userRow(id);
    if (!row) return null;
    const linked = this.count("SELECT COUNT(*) AS count FROM machine_links WHERE user_id = ?", [id]);
    const online =
      id === this.currentUserId ||
      this.count("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND last_seen_at > ?", [
        id,
        Date.now() - ONLINE_MS,
      ]) > 0;
    return {
      id,
      username: String(row.username),
      displayName: String(row.display_name),
      role: normalizeRole(String(row.role)),
      status: normalizeStatus(String(row.status)),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastLoginAt: row.last_login_at === null ? undefined : Number(row.last_login_at),
      linkedMachines: linked,
      online,
    };
  }

  /* ---------------------------------------------------------- login throttle */

  private assertLoginAllowed(key: string): void {
    const now = Date.now();
    const row = this.one("SELECT * FROM login_throttle WHERE key = ?", [key]);
    if (!row) return;
    const first = Number(row.first_failed_at);
    const lockedUntil = Number(row.locked_until);
    const expired = now - first > LOGIN_WINDOW_MS;
    const lockConsumed = lockedUntil > 0 && lockedUntil <= now;
    if (expired || (lockConsumed && Number(row.failed_count) >= LOGIN_MAX_FAILURES)) {
      this.run("DELETE FROM login_throttle WHERE key = ?", [key]);
      this.persist();
      return;
    }
    if (lockedUntil > now) {
      const minutes = Math.ceil((lockedUntil - now) / 60_000);
      throw new Error(`Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    }
  }

  private recordLoginFailure(key: string): number {
    const now = Date.now();
    const row = this.one("SELECT * FROM login_throttle WHERE key = ?", [key]);
    const fresh = !row || now - Number(row.first_failed_at) > LOGIN_WINDOW_MS;
    const count = fresh ? 1 : Number(row.failed_count) + 1;
    const first = fresh ? now : Number(row.first_failed_at);
    const lockedUntil = count >= LOGIN_MAX_FAILURES ? now + LOGIN_LOCK_MS : 0;
    this.run(
      "INSERT OR REPLACE INTO login_throttle (key, failed_count, first_failed_at, last_failed_at, locked_until) VALUES (?, ?, ?, ?, ?)",
      [key, count, first, now, lockedUntil],
    );
    this.run("DELETE FROM login_throttle WHERE last_failed_at < ?", [now - 24 * 60 * 60 * 1000]);
    this.persist();
    return lockedUntil > now ? lockedUntil - now : 0;
  }

  private clearLoginFailures(key: string): void {
    const row = this.one("SELECT key FROM login_throttle WHERE key = ?", [key]);
    if (!row) return;
    this.run("DELETE FROM login_throttle WHERE key = ?", [key]);
    this.persist();
  }

  /* --------------------------------------------------------------- audit log */

  auditLog(filter: TeamAuditFilter = {}): TeamAuditResult {
    const actor = this.currentUser();
    return this.queryActivity(actor, filter, AUDIT_MAX_LIMIT);
  }

  syncCounts(): { users: number; machines: number; activity: number } {
    return {
      users: this.count("SELECT COUNT(*) AS count FROM users"),
      machines: this.count("SELECT COUNT(*) AS count FROM machines"),
      activity: this.count("SELECT COUNT(*) AS count FROM activity"),
    };
  }

  auditCsv(filter: TeamAuditFilter = {}): { csv: string; count: number } {
    const actor = this.currentUser();
    const result = this.queryActivity(actor, { ...filter, limit: 10_000 }, 10_000);
    const header = ["timestamp", "actor", "action", "target_type", "target", "detail"].map(csvCell).join(",");
    const rows = result.entries.map((entry) =>
      [
        new Date(entry.at).toISOString(),
        entry.actorName,
        entry.action,
        entry.targetType,
        entry.targetName ?? entry.targetId ?? "",
        entry.detail ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
    return { csv: [header, ...rows].join("\r\n") + "\r\n", count: result.entries.length };
  }

  recordAuditExport(count: number): void {
    const actor = this.currentUser();
    this.transaction(() =>
      this.audit(actor, "audit.export", "workspace", "workspace", "Team audit log", `${count} event${count === 1 ? "" : "s"} exported as CSV`),
    );
  }

  private queryActivity(actor: TeamUser, filter: TeamAuditFilter, maxLimit: number): TeamAuditResult {
    const clauses: string[] = [];
    const params: Param[] = [];
    if (actor.role === "user") {
      clauses.push("(actor_id = ? OR (target_type = 'user' AND target_id = ?))");
      params.push(actor.id, actor.id);
    } else if (filter.actorId) {
      clauses.push("actor_id = ?");
      params.push(filter.actorId);
    }
    if (filter.action) {
      clauses.push("action = ?");
      params.push(filter.action);
    }
    if (filter.targetType && filter.targetType !== "all") {
      clauses.push("target_type = ?");
      params.push(filter.targetType);
    }
    if (Number.isFinite(filter.from)) {
      clauses.push("at >= ?");
      params.push(Number(filter.from));
    }
    if (Number.isFinite(filter.to)) {
      clauses.push("at <= ?");
      params.push(Number(filter.to));
    }
    if (filter.query?.trim()) {
      const needle = `%${filter.query.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      clauses.push("(actor_name LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR target_name LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
      params.push(needle, needle, needle, needle);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = this.count(`SELECT COUNT(*) AS count FROM activity ${where}`, params);
    const limit = Math.max(1, Math.min(maxLimit, Number(filter.limit) || AUDIT_DEFAULT_LIMIT));
    const rows = this.all(`SELECT * FROM activity ${where} ORDER BY at DESC LIMIT ?`, [...params, limit]);
    return { total, entries: rows.map((row) => this.activityFromRow(row)) };
  }

  private activityFromRow(row: Row): TeamActivityEntry {
    return {
      id: String(row.id),
      at: Number(row.at),
      actorId: row.actor_id === null ? undefined : String(row.actor_id),
      actorName: String(row.actor_name),
      action: String(row.action),
      targetType: String(row.target_type) as TeamActivityEntry["targetType"],
      targetId: row.target_id === null ? undefined : String(row.target_id),
      targetName: row.target_name === null ? undefined : String(row.target_name),
      detail: row.detail === null ? undefined : String(row.detail),
    };
  }

  /* ------------------------------------------------------------ sync state */

  /** Export the sanitized-minus-passwords snapshot used by the sync relay. */
  syncSnapshot(): TeamSyncSnapshot {
    const userRows = this.all("SELECT * FROM users ORDER BY created_at");
    const users: TeamSyncUser[] = userRows.map((row) => ({
      username: String(row.username),
      displayName: String(row.display_name),
      role: normalizeRole(String(row.role)),
      status: normalizeStatus(String(row.status)),
      passwordSalt: String(row.password_salt),
      passwordHash: String(row.password_hash),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastLoginAt: row.last_login_at === null ? undefined : Number(row.last_login_at),
    }));

    const links = new Map<string, string[]>();
    const linkRows = this.all(`
      SELECT ml.machine_id, u.username
      FROM machine_links ml JOIN users u ON u.id = ml.user_id
      ORDER BY u.username COLLATE NOCASE
    `);
    for (const row of linkRows) {
      const id = String(row.machine_id);
      links.set(id, [...(links.get(id) ?? []), String(row.username)]);
    }
    const machines: TeamSyncMachine[] = this.all("SELECT * FROM machines ORDER BY label COLLATE NOCASE").map((row) => ({
      key: machineSyncKey(row),
      kind: String(row.kind ?? "ssh") === "pve" ? ("pve" as const) : ("ssh" as const),
      baseUrl: row.base_url === null || row.base_url === undefined ? undefined : String(row.base_url),
      label: String(row.label),
      host: String(row.host),
      port: Number(row.port),
      username: String(row.username),
      color: String(row.color),
      updatedAt: Number(row.updated_at),
      linksUpdatedAt: Number(row.links_updated_at),
      linkedUsernames: links.get(String(row.id)) ?? [],
    }));

    const activity = this.all("SELECT * FROM activity ORDER BY at DESC LIMIT ?", [SYNC_ACTIVITY_LIMIT]).map((row) =>
      this.activityFromRow(row),
    );
    const userTombstones: TeamSyncUserTombstone[] = this.all(
      "SELECT username, deleted_at FROM sync_user_tombstones ORDER BY deleted_at DESC",
    ).map((row) => ({ username: String(row.username), deletedAt: Number(row.deleted_at) }));
    const machineTombstones: TeamSyncMachineTombstone[] = this.all(
      "SELECT key, deleted_at FROM sync_machine_tombstones ORDER BY deleted_at DESC",
    ).map((row) => ({ key: String(row.key), deletedAt: Number(row.deleted_at) }));

    const chat: TeamSyncChatMessage[] = this.all(
      "SELECT * FROM team_chat_messages ORDER BY created_at DESC LIMIT ?",
      [CHAT_SYNC_LIMIT],
    )
      .reverse()
      .map((row) => ({
        id: String(row.id),
        authorUsername: String(row.author_username),
        authorName: String(row.author_name),
        authorRole: normalizeRole(String(row.author_role)),
        body: String(row.body),
        createdAt: Number(row.created_at),
      }));
    const boardLists: TeamSyncBoardList[] = this.all(
      "SELECT * FROM team_board_lists ORDER BY position ASC, created_at ASC",
    ).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      position: Number(row.position),
      createdByUsername: row.created_by_username === null ? undefined : String(row.created_by_username),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
    const boardTasks: TeamSyncBoardTask[] = this.all(
      "SELECT * FROM team_board_tasks ORDER BY created_at ASC",
    ).map((row) => ({
      id: String(row.id),
      listId: String(row.list_id),
      title: String(row.title),
      detail: row.detail === null ? undefined : String(row.detail),
      pinned: Boolean(row.pinned),
      authorUsername: String(row.author_username),
      authorName: String(row.author_name),
      authorRole: normalizeRole(String(row.author_role)),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
    const boardListTombstones: TeamSyncBoardTombstone[] = this.all(
      "SELECT id, deleted_at FROM board_list_tombstones ORDER BY deleted_at DESC",
    ).map((row) => ({ id: String(row.id), deletedAt: Number(row.deleted_at) }));
    const boardTaskTombstones: TeamSyncBoardTombstone[] = this.all(
      "SELECT id, deleted_at FROM board_task_tombstones ORDER BY deleted_at DESC",
    ).map((row) => ({ id: String(row.id), deletedAt: Number(row.deleted_at) }));

    return {
      version: 1,
      workspaceName: String(this.one("SELECT value FROM settings WHERE key = 'workspace_name'")?.value ?? "Nexus Operations"),
      workspaceUpdatedAt: Number(
        this.one("SELECT value FROM settings WHERE key = 'workspace_updated_at'")?.value ?? Date.now(),
      ),
      users,
      machines,
      activity,
      userTombstones,
      machineTombstones,
      chat,
      boardLists,
      boardTasks,
      boardListTombstones,
      boardTaskTombstones,
    };
  }

  /**
   * Apply a merged snapshot. Local ids survive where possible so existing
   * sessions, machine links and the local SSH inventory keep working.
   */
  applySyncSnapshot(remote: TeamSyncSnapshot): void {
    if (!remote || remote.version !== 1) throw new Error("Unsupported team sync snapshot.");
    const workspaceUpdatedAt = Number(remote.workspaceUpdatedAt) || 0;
    const localWorkspaceAt = Number(
      this.one("SELECT value FROM settings WHERE key = 'workspace_updated_at'")?.value ?? 0,
    );
    let revokedCurrentSession = false;

    this.transaction(() => {
      if (workspaceUpdatedAt > localWorkspaceAt && remote.workspaceName.trim()) {
        this.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('workspace_name', ?)", [remote.workspaceName.trim()]);
        this.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('workspace_updated_at', ?)", [workspaceUpdatedAt]);
      }

      const tombstones = new Map<string, number>();
      for (const tombstone of remote.userTombstones ?? []) {
        if (!tombstone || !tombstone.username) continue;
        tombstones.set(tombstone.username, Number(tombstone.deletedAt) || 0);
        this.run("INSERT OR REPLACE INTO sync_user_tombstones (username, deleted_at) VALUES (?, ?)", [
          tombstone.username,
          Number(tombstone.deletedAt) || 0,
        ]);
      }
      for (const [username, deletedAt] of tombstones) {
        const local = this.one("SELECT id, updated_at FROM users WHERE username = ?", [username]);
        if (!local || Number(local.updated_at) > deletedAt) continue;
        if (String(local.id) === this.currentUserId) revokedCurrentSession = true;
        this.run("DELETE FROM sessions WHERE user_id = ?", [String(local.id)]);
        this.run("DELETE FROM users WHERE id = ?", [String(local.id)]);
      }

      const machineTombstones = new Map<string, number>();
      for (const tombstone of remote.machineTombstones ?? []) {
        if (!tombstone || !tombstone.key) continue;
        const key = tombstone.key.toLowerCase();
        const deletedAt = Number(tombstone.deletedAt) || 0;
        machineTombstones.set(key, deletedAt);
        this.run("INSERT OR REPLACE INTO sync_machine_tombstones (key, deleted_at) VALUES (?, ?)", [key, deletedAt]);
      }
      for (const row of this.all("SELECT id, kind, base_url, host, port, username, updated_at FROM machines")) {
        const key = machineSyncKey(row);
        const deletedAt = machineTombstones.get(key) ?? 0;
        if (deletedAt === 0 || deletedAt < Number(row.updated_at)) continue;
        this.run("DELETE FROM machine_links WHERE machine_id = ?", [String(row.id)]);
        this.run("DELETE FROM machines WHERE id = ?", [String(row.id)]);
      }

      for (const user of remote.users ?? []) {
        const username = normalizeUsername(user.username ?? "");
        if (!username) continue;
        const deletedAt = tombstones.get(username) ?? 0;
        if (deletedAt >= Number(user.updatedAt)) continue;
        const existing = this.one("SELECT * FROM users WHERE username = ?", [username]);
        const displayName = normalizeDisplayName(user.displayName || username);
        const role = normalizeRole(user.role);
        const status = normalizeStatus(user.status);
        if (existing) {
          if (Number(existing.updated_at) > Number(user.updatedAt)) continue;
          const passwordChanged = String(existing.password_hash) !== user.passwordHash;
          this.run(
            "UPDATE users SET display_name = ?, role = ?, status = ?, password_salt = ?, password_hash = ?, updated_at = ?, last_login_at = COALESCE(?, last_login_at) WHERE id = ?",
            [
              displayName,
              role,
              status,
              user.passwordSalt,
              user.passwordHash,
              Number(user.updatedAt),
              user.lastLoginAt ?? null,
              String(existing.id),
            ],
          );
          if (passwordChanged || status === "suspended") {
            this.run("DELETE FROM sessions WHERE user_id = ?", [String(existing.id)]);
            if (String(existing.id) === this.currentUserId) revokedCurrentSession = true;
          }
        } else {
          this.run(
            "INSERT INTO users (id, username, display_name, role, status, password_salt, password_hash, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              uid(),
              username,
              displayName,
              role,
              status,
              user.passwordSalt,
              user.passwordHash,
              Number(user.createdAt) || Date.now(),
              Number(user.updatedAt) || Date.now(),
              user.lastLoginAt ?? null,
            ],
          );
        }
      }

      for (const machine of remote.machines ?? []) {
        const kind = machine.kind === "pve" ? "pve" : "ssh";
        const key = String(machine.key || "").trim();
        if (!key) continue;
        const baseUrl = kind === "pve" ? String(machine.baseUrl ?? "").trim().replace(/\/+$/, "") : "";
        if (kind === "pve" && !baseUrl) continue;
        const deletedAt = machineTombstones.get(key.toLowerCase()) ?? 0;
        if (deletedAt >= Number(machine.updatedAt)) continue;
        const existing =
          kind === "pve"
            ? this.one("SELECT * FROM machines WHERE kind = 'pve' AND lower(base_url) = ?", [
                normalizePveBaseUrl(baseUrl),
              ])
            : this.one(
                "SELECT * FROM machines WHERE lower(host) = ? AND port = ? AND lower(username) = ? AND kind = 'ssh'",
                [machine.host.trim().toLowerCase(), Number(machine.port), machine.username.trim().toLowerCase()],
              );
        let machineId: string;
        if (!existing) {
          machineId = uid();
          const endpoint = kind === "pve" ? pveEndpoint(baseUrl) : { host: machine.host, port: Number(machine.port) || 22 };
          this.run(
            "INSERT INTO machines (id, label, host, port, username, color, updated_at, source, links_updated_at, kind, base_url) VALUES (?, ?, ?, ?, ?, ?, ?, 'remote', ?, ?, ?)",
            [
              machineId,
              machine.label || (kind === "pve" ? baseUrl : machine.host),
              endpoint.host,
              endpoint.port,
              kind === "pve" ? "" : machine.username,
              machine.color || "#38f2ff",
              Number(machine.updatedAt) || Date.now(),
              Number(machine.linksUpdatedAt) || 0,
              kind,
              kind === "pve" ? baseUrl : null,
            ],
          );
        } else {
          machineId = String(existing.id);
          if (Number(machine.updatedAt) > Number(existing.updated_at)) {
            this.run("UPDATE machines SET label = ?, color = ?, updated_at = ?, kind = ?, base_url = ? WHERE id = ?", [
              machine.label || String(existing.label),
              machine.color || String(existing.color),
              Number(machine.updatedAt),
              kind,
              kind === "pve" ? baseUrl : null,
              machineId,
            ]);
          }
        }
        if (Number(machine.linksUpdatedAt) > Number(existing?.links_updated_at ?? 0)) {
          this.run("DELETE FROM machine_links WHERE machine_id = ?", [machineId]);
          for (const username of [...new Set(machine.linkedUsernames ?? [])]) {
            const localUser = this.one("SELECT id FROM users WHERE username = ?", [normalizeUsername(username)]);
            if (!localUser) continue;
            this.run("INSERT OR IGNORE INTO machine_links (user_id, machine_id, created_at, created_by) VALUES (?, ?, ?, 'sync')", [
              String(localUser.id),
              machineId,
              Date.now(),
            ]);
          }
          this.run("UPDATE machines SET links_updated_at = ? WHERE id = ?", [Number(machine.linksUpdatedAt), machineId]);
        }
      }

      const boardListTombstones = new Map<string, number>();
      for (const tombstone of remote.boardListTombstones ?? []) {
        if (!tombstone?.id) continue;
        boardListTombstones.set(tombstone.id, Number(tombstone.deletedAt) || 0);
        this.run("INSERT OR REPLACE INTO board_list_tombstones (id, deleted_at) VALUES (?, ?)", [
          tombstone.id,
          Number(tombstone.deletedAt) || 0,
        ]);
      }
      for (const id of boardListTombstones.keys()) {
        this.run("DELETE FROM team_board_tasks WHERE list_id = ?", [id]);
        this.run("DELETE FROM team_board_lists WHERE id = ?", [id]);
      }

      const boardTaskTombstones = new Map<string, number>();
      for (const tombstone of remote.boardTaskTombstones ?? []) {
        if (!tombstone?.id) continue;
        boardTaskTombstones.set(tombstone.id, Number(tombstone.deletedAt) || 0);
        this.run("INSERT OR REPLACE INTO board_task_tombstones (id, deleted_at) VALUES (?, ?)", [
          tombstone.id,
          Number(tombstone.deletedAt) || 0,
        ]);
      }
      for (const id of boardTaskTombstones.keys()) {
        this.run("DELETE FROM team_board_tasks WHERE id = ?", [id]);
      }

      for (const list of remote.boardLists ?? []) {
        if (!list?.id || boardListTombstones.has(list.id)) continue;
        const existing = this.one("SELECT updated_at FROM team_board_lists WHERE id = ?", [list.id]);
        if (existing && Number(existing.updated_at) > Number(list.updatedAt)) continue;
        this.run(
          `INSERT INTO team_board_lists (id, title, position, created_by_username, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, position = excluded.position,
             created_by_username = excluded.created_by_username, updated_at = excluded.updated_at`,
          [
            list.id,
            normalizeBoardListTitle(list.title),
            Number(list.position) || 0,
            list.createdByUsername ?? null,
            Number(list.createdAt) || Date.now(),
            Number(list.updatedAt) || Date.now(),
          ],
        );
      }

      for (const task of remote.boardTasks ?? []) {
        if (!task?.id || boardTaskTombstones.has(task.id) || !task.listId) continue;
        if (!this.one("SELECT id FROM team_board_lists WHERE id = ?", [task.listId])) continue;
        const existing = this.one("SELECT updated_at FROM team_board_tasks WHERE id = ?", [task.id]);
        if (existing && Number(existing.updated_at) > Number(task.updatedAt)) continue;
        this.run(
          `INSERT INTO team_board_tasks
             (id, list_id, title, detail, pinned, author_username, author_name, author_role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET list_id = excluded.list_id, title = excluded.title,
             detail = excluded.detail, pinned = excluded.pinned, updated_at = excluded.updated_at`,
          [
            task.id,
            task.listId,
            normalizeBoardTaskTitle(task.title),
            normalizeBoardTaskDetail(task.detail) ?? null,
            task.pinned ? 1 : 0,
            task.authorUsername || "synced-member",
            task.authorName || task.authorUsername || "Synced member",
            normalizeRole(task.authorRole || "user"),
            Number(task.createdAt) || Date.now(),
            Number(task.updatedAt) || Date.now(),
          ],
        );
      }

      for (const message of remote.chat ?? []) {
        if (!message?.id) continue;
        this.run(
          "INSERT OR IGNORE INTO team_chat_messages (id, author_id, author_username, author_name, author_role, body, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)",
          [
            message.id,
            message.authorUsername || "synced-member",
            message.authorName || message.authorUsername || "Synced member",
            normalizeRole(message.authorRole || "user"),
            normalizeChatBody(message.body),
            Number(message.createdAt) || Date.now(),
          ],
        );
      }
      this.run(
        "DELETE FROM team_chat_messages WHERE id NOT IN (SELECT id FROM team_chat_messages ORDER BY created_at DESC LIMIT ?)",
        [CHAT_STORE_LIMIT],
      );

      for (const entry of remote.activity ?? []) {
        if (!entry?.id) continue;
        this.run(
          "INSERT OR IGNORE INTO activity (id, at, actor_id, actor_name, action, target_type, target_id, target_name, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            entry.id,
            Number(entry.at) || Date.now(),
            entry.actorId ?? null,
            entry.actorName || "Synced member",
            entry.action || "sync.event",
            entry.targetType || "workspace",
            entry.targetId ?? null,
            entry.targetName ?? null,
            entry.detail ?? null,
          ],
        );
      }

      if (revokedCurrentSession) this.clearSession();
    });
    // A snapshot from an older client cannot represent the super-admin role.
    // Repair the invariant locally instead of leaving the workspace unable to
    // appoint a super admin.
    this.ensureSuperAdminPresent();
    this.ensureDefaultBoardLists();
  }

  private listUsers(actor: TeamUser): TeamUser[] {
    const rows = this.all(
      "SELECT id FROM users ORDER BY CASE role WHEN 'superadmin' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, display_name COLLATE NOCASE",
    );
    const users = rows.map((row) => this.toTeamUser(String(row.id))).filter((user): user is TeamUser => Boolean(user));
    return actor.role === "user" ? users.filter((user) => user.id === actor.id) : users;
  }

  private listMachines(actor: TeamUser): TeamMachine[] {
    const machineRows = this.all("SELECT * FROM machines ORDER BY label COLLATE NOCASE");
    const linkRows = this.all(`
      SELECT ml.machine_id, u.id, u.username, u.display_name, u.role
      FROM machine_links ml
      JOIN users u ON u.id = ml.user_id
      ORDER BY u.display_name COLLATE NOCASE
    `);
    const links = new Map<string, TeamMachine["linkedUsers"]>();
    for (const row of linkRows) {
      const machineId = String(row.machine_id);
      const entry = links.get(machineId) ?? [];
      entry.push({
        id: String(row.id),
        username: String(row.username),
        displayName: String(row.display_name),
        role: normalizeRole(String(row.role)),
      });
      links.set(machineId, entry);
    }
    return machineRows
      .map((row) => {
        const id = String(row.id);
        const linkedUsers = links.get(id) ?? [];
        return {
          id,
          kind: String(row.kind ?? "ssh") === "pve" ? ("pve" as const) : ("ssh" as const),
          label: String(row.label),
          host: String(row.host),
          port: Number(row.port),
          username: String(row.username),
          baseUrl: row.base_url === null || row.base_url === undefined ? undefined : String(row.base_url),
          color: String(row.color),
          source: String(row.source) === "remote" ? ("remote" as const) : ("local" as const),
          linkedUserIds: linkedUsers.map((user) => user.id),
          linkedUsers,
          updatedAt: Number(row.updated_at),
        };
      })
      .filter((machine) => actor.role !== "user" || machine.linkedUserIds.includes(actor.id));
  }

  private listActivity(actor: TeamUser): TeamActivityEntry[] {
    const rows =
      actor.role === "user"
        ? this.all(
            "SELECT * FROM activity WHERE actor_id = ? OR (target_type = 'user' AND target_id = ?) ORDER BY at DESC LIMIT 80",
            [actor.id, actor.id],
          )
        : this.all("SELECT * FROM activity ORDER BY at DESC LIMIT 80");
    return rows.map((row) => this.activityFromRow(row));
  }

  private permissions(actor: TeamUser): TeamPermissions {
    const admin = actor.role === "admin" || actor.role === "superadmin";
    const manager = admin || actor.role === "moderator";
    return {
      manageUsers: manager,
      manageRoles: admin,
      deleteUsers: admin,
      manageLinks: manager,
      manageMachines: manager,
    };
  }

  private assertManager(actor: TeamUser): void {
    if (actor.role === "user") throw new Error("Admin or moderator access required.");
  }

  private verifyPassword(password: string, salt: string, expected: string): boolean {
    if (!password || !salt || !expected) return false;
    const actual = crypto.scryptSync(password, salt, 64);
    const stored = Buffer.from(expected, "hex");
    return actual.length === stored.length && crypto.timingSafeEqual(actual, stored);
  }

  private clearSession(): void {
    this.currentUserId = null;
    this.currentSessionId = null;
    this.lastTouchAt = 0;
  }

  private touchSession(): void {
    if (!this.currentSessionId || Date.now() - this.lastTouchAt < TOUCH_MS) return;
    this.lastTouchAt = Date.now();
    this.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", [this.lastTouchAt, this.currentSessionId]);
    this.persist();
  }

  private cleanupSessions(): void {
    this.run("DELETE FROM sessions WHERE expires_at <= ?", [Date.now()]);
    if (this.db.getRowsModified() > 0) this.persist();
  }

  private audit(
    actor: TeamUser,
    action: string,
    targetType: TeamActivityEntry["targetType"],
    targetId: string | undefined,
    targetName: string | undefined,
    detail?: string,
  ): void {
    this.run(
      "INSERT INTO activity (id, at, actor_id, actor_name, action, target_type, target_id, target_name, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [uid(), Date.now(), actor.id, actor.displayName, action, targetType, targetId ?? null, targetName ?? null, detail ?? null],
    );
  }
}
