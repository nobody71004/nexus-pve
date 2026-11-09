import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import type { Database, SqlValue } from "sql.js";
import type { SshHostSummary } from "../../shared/types";
import type {
  TeamActivityEntry,
  TeamAuthState,
  TeamBootstrapInput,
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
  if (value === "admin" || value === "moderator" || value === "user") return value;
  throw new Error("Unknown team role.");
}

function normalizeStatus(value: string): TeamStatus {
  if (value === "active" || value === "suspended") return value;
  throw new Error("Unknown account status.");
}

function roleLabel(role: TeamRole): string {
  return role === "admin" ? "Admin" : role === "moderator" ? "Moderator" : "Member";
}

function machineKey(host: string, port: number, username: string): string {
  return `${host.trim().toLowerCase()}:${port}:${username.trim().toLowerCase()}`;
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
        role TEXT NOT NULL CHECK (role IN ('admin', 'moderator', 'user')),
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
    this.ensureColumn("machines", "source", "TEXT NOT NULL DEFAULT 'local'");
    this.ensureColumn("machines", "links_updated_at", "INTEGER NOT NULL DEFAULT 0");
    this.db.run("CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS links_machine ON machine_links(machine_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS activity_at ON activity(at)");
    this.db.run("CREATE INDEX IF NOT EXISTS activity_actor ON activity(actor_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS login_throttle_lock ON login_throttle(locked_until)");
    this.db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('workspace_name', 'Nexus Operations')");
    this.db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('workspace_updated_at', ?)", [Date.now()]);
    this.db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('schema_version', '1')");
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
      role: "admin" as const,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
      linkedMachines: 0,
      online: false,
    };

    this.transaction(() => {
      this.run(
        "INSERT INTO users (id, username, display_name, role, status, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, 'admin', 'active', ?, ?, ?, ?)",
        [id, username, displayName, salt, passwordHash, now, now],
      );
      this.audit(
        { ...user, id, username, displayName, role: "admin", status: "active" },
        "workspace.bootstrap",
        "workspace",
        "workspace",
        "Nexus Operations",
        "Created the workspace owner account",
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
    const admins = users.filter((user) => user.role === "admin").length;
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
    if (actor.role !== "admin" && role !== "user") {
      throw new Error("Only admins can create admins or moderators.");
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

    if (actor.role !== "admin" && (targetRole !== "user" || nextRole !== "user")) {
      throw new Error("Moderators can only manage standard member accounts.");
    }
    if (id === actor.id && nextRole !== targetRole) throw new Error("You cannot change your own role.");
    if (id === actor.id && nextStatus !== "active") throw new Error("You cannot suspend your own account.");
    const activeAdmins = this.count("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'");
    const wasActiveAdmin = targetRole === "admin" && targetStatus === "active";
    const remainsActiveAdmin = nextRole === "admin" && nextStatus === "active";
    if (wasActiveAdmin && !remainsActiveAdmin && activeAdmins <= 1) {
      throw new Error("The workspace needs at least one active admin.");
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
    if (actor.role !== "admin") throw new Error("Only admins can delete accounts.");
    if (id === actor.id) throw new Error("You cannot delete the account you are signed in with.");
    const target = this.userRow(id);
    if (!target) throw new Error("Member not found.");
    const activeAdmins = this.count("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'");
    if (String(target.role) === "admin" && String(target.status) === "active" && activeAdmins <= 1) {
      throw new Error("The workspace needs at least one active admin.");
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
      if (actor.role !== "admin" && String(target.role) !== "user" && !existing.has(userId)) {
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

  removeMachine(machineId: string, actor: TeamUser): void {
    if (actor.role === "user") throw new Error("Admin or moderator access required.");
    const machine = this.one("SELECT label, host, port, username FROM machines WHERE id = ?", [machineId]);
    if (!machine) return;
    const now = Date.now();
    this.transaction(() => {
      this.run("INSERT OR REPLACE INTO sync_machine_tombstones (key, deleted_at) VALUES (?, ?)", [
        machineKey(String(machine.host), Number(machine.port), String(machine.username)),
        now,
      ]);
      this.run("DELETE FROM machine_links WHERE machine_id = ?", [machineId]);
      this.run("DELETE FROM machines WHERE id = ?", [machineId]);
      this.audit(actor, "machine.remove", "machine", machineId, String(machine.label), "Removed from the SSH inventory");
    });
  }

  syncMachines(hosts: SshHostSummary[]): void {
    const now = Date.now();
    let changed = false;
    const hostIds = new Set(hosts.map((host) => host.id));
    for (const row of this.all("SELECT id, source, host, port, username FROM machines")) {
      const id = String(row.id);
      if (hostIds.has(id)) continue;
      if (String(row.source) === "remote") continue;
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
          "SELECT * FROM machines WHERE lower(host) = ? AND port = ? AND lower(username) = ? AND source = 'remote'",
          [host.host.toLowerCase(), host.port, host.username.toLowerCase()],
        );
        if (remote) {
          const remoteId = String(remote.id);
          this.run("UPDATE machine_links SET machine_id = ? WHERE machine_id = ?", [host.id, remoteId]);
          this.run("DELETE FROM machines WHERE id = ?", [remoteId]);
          existing = this.one("SELECT * FROM machines WHERE id = ?", [host.id]);
        }
      }
      if (!existing) {
        this.run(
          "INSERT INTO machines (id, label, host, port, username, color, updated_at, source, links_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'local', ?)",
          [host.id, host.label, host.host, host.port, host.username, host.color, now, now],
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

  canAccessMachine(userId: string, machineId: string): boolean {
    const user = this.userRow(userId);
    if (!user || String(user.status) !== "active") return false;
    if (String(user.role) !== "user") return true;
    return this.count("SELECT COUNT(*) AS count FROM machine_links WHERE user_id = ? AND machine_id = ?", [userId, machineId]) > 0;
  }

  /* ------------------------------------------------------------- internals */

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
      key: machineKey(String(row.host), Number(row.port), String(row.username)),
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
      for (const row of this.all("SELECT id, host, port, username, updated_at FROM machines")) {
        const key = machineKey(String(row.host), Number(row.port), String(row.username));
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
        const key = String(machine.key || "").trim();
        if (!key) continue;
        const deletedAt = machineTombstones.get(key.toLowerCase()) ?? 0;
        if (deletedAt >= Number(machine.updatedAt)) continue;
        const existing = this.one(
          "SELECT * FROM machines WHERE lower(host) = ? AND port = ? AND lower(username) = ?",
          [machine.host.trim().toLowerCase(), Number(machine.port), machine.username.trim().toLowerCase()],
        );
        let machineId: string;
        if (!existing) {
          machineId = uid();
          this.run(
            "INSERT INTO machines (id, label, host, port, username, color, updated_at, source, links_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'remote', ?)",
            [
              machineId,
              machine.label || machine.host,
              machine.host,
              Number(machine.port) || 22,
              machine.username,
              machine.color || "#38f2ff",
              Number(machine.updatedAt) || Date.now(),
              Number(machine.linksUpdatedAt) || 0,
            ],
          );
        } else {
          machineId = String(existing.id);
          if (Number(machine.updatedAt) > Number(existing.updated_at)) {
            this.run("UPDATE machines SET label = ?, color = ?, updated_at = ? WHERE id = ?", [
              machine.label || String(existing.label),
              machine.color || String(existing.color),
              Number(machine.updatedAt),
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
  }

  private listUsers(actor: TeamUser): TeamUser[] {
    const rows = this.all("SELECT id FROM users ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, display_name COLLATE NOCASE");
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
          label: String(row.label),
          host: String(row.host),
          port: Number(row.port),
          username: String(row.username),
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
    const admin = actor.role === "admin";
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
