import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { normalizeUiScale } from "../../shared/ui-scale";
import type { HostInput, SshHostInput } from "../../shared/types";
import type { StoredHost } from "../config";
import type { TeamRole, TeamStatus, TeamUserInput, TeamUserPatch } from "../../shared/team-types";
import { nexusHome } from "../paths";
import { TeamService } from "../team/store";
import { confirmDestructive, optionalNumber, requireString, type ToolRegistry } from "./registry";

/**
 * Application and team surface for the agent.
 *
 * These tools exist so a headless MCP client can manage the same inventory the
 * desktop UI manages: Proxmox endpoints, Linux SSH hosts, app settings, and the
 * team directory. Secrets are write-only — nothing here returns a token,
 * password, or private key.
 */

function appVersion(appRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function desktopAppRunning(): boolean {
  try {
    return fs.existsSync(path.join(nexusHome(), "lockfile"));
  } catch {
    return false;
  }
}

function publicHost(host: StoredHost) {
  return {
    id: host.id,
    label: host.label,
    baseUrl: host.baseUrl,
    authMode: host.authMode,
    tokenId: host.tokenId,
    username: host.username,
    tlsVerify: host.tlsVerify,
    hasSecret: host.hasSecret,
    lastSeenAt: host.lastSeenAt,
  };
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === "boolean" ? (args[key] as boolean) : undefined;
}

function findHost(store: { hosts(): StoredHost[]; host(id: string): StoredHost | undefined }, needle: string): StoredHost {
  const direct = store.host(needle);
  if (direct) return direct;
  const lowered = needle.trim().toLowerCase();
  const match = store.hosts().find((host) => host.label.toLowerCase() === lowered || host.baseUrl.toLowerCase().includes(lowered));
  if (!match) throw new Error(`No Proxmox host matches "${needle}". Use hosts.list.`);
  return match;
}

function findSshHost(store: { sshHosts(): { id: string; label: string; host: string }[]; sshHost(id: string): { id: string } | undefined }, needle: string) {
  const direct = store.sshHost(needle);
  if (direct) return direct;
  const lowered = needle.trim().toLowerCase();
  const match = store.sshHosts().find(
    (host) => host.label.toLowerCase() === lowered || host.host.toLowerCase() === lowered,
  );
  if (!match) throw new Error(`No SSH host matches "${needle}". Use ssh.hosts.`);
  return match;
}

/* ----------------------------------------------------------- team helpers */

async function wasmBinary(appRoot: string): Promise<ArrayBuffer> {
  const wasm = [
    path.join(appRoot, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(__dirname, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
  ].find((candidate) => fs.existsSync(candidate));
  if (!wasm) throw new Error("sql.js WASM runtime is missing.");
  const bytes = fs.readFileSync(wasm);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Read the team database without opening a session or writing to it. */
async function readTeamDirectory(appRoot: string) {
  const file = path.join(nexusHome(), "team.sqlite");
  if (!fs.existsSync(file)) {
    return { database: file, exists: false, users: [], machines: [], grants: [] as { user: string; machine: string }[] };
  }
  const SQL = await initSqlJs({ wasmBinary: await wasmBinary(appRoot) });
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    const read = (sql: string, params: string[] = []) => {
      try {
        return db.exec(sql, params)[0];
      } catch {
        return undefined;
      }
    };
    const userRows = read(
      "SELECT username, display_name, role, status, created_at, last_login_at FROM users ORDER BY created_at",
    );
    const machineRows = read("SELECT id, label, kind, host, port, username FROM machines ORDER BY label");
    const linkRows = read("SELECT user_id, machine_id FROM machine_links");
    const userName = new Map<string, string>();
    const users = (userRows?.values ?? []).map((row) => {
      const [username, displayName, role, status, createdAt, lastLogin] = row;
      userName.set(String(username), String(username));
      return {
        username: String(username),
        displayName: String(displayName),
        role: String(role),
        status: String(status),
        createdAt: Number(createdAt),
        lastLoginAt: Number(lastLogin) || undefined,
      };
    });
    const machines = (machineRows?.values ?? []).map((row) => {
      const [id, label, kind, host, port, username] = row;
      return { id: String(id), label: String(label), kind: String(kind ?? "ssh"), host: String(host ?? ""), port: Number(port) || undefined, username: username ? String(username) : undefined };
    });
    const labelOf = new Map(machines.map((machine) => [machine.id, machine.label]));
    const idOfUser = new Map<string, string>();
    for (const user of users) idOfUser.set(user.username, user.username);
    const grants = (linkRows?.values ?? []).map(([userId, machineId]) => ({
      user: userName.get(String(userId)) ?? String(userId),
      machine: labelOf.get(String(machineId)) ?? String(machineId),
    }));
    return { database: file, exists: true, users, machines, grants };
  } finally {
    db.close();
  }
}

function assertDesktopClosed(action: string): void {
  if (desktopAppRunning()) {
    throw new Error(
      `The Nexus desktop app is running and holds team.sqlite in memory, so ${action} would be overwritten when it quits. Close the app first.`,
    );
  }
}

async function withTeam<T>(appRoot: string, action: string, work: (team: TeamService) => T | Promise<T>): Promise<T> {
  assertDesktopClosed(action);
  const team = await TeamService.open(appRoot);
  try {
    team.openAgentSession();
    return await work(team);
  } finally {
    team.close();
  }
}

function resolveUser(team: TeamService, needle: string) {
  const overview = team.overview();
  const lowered = needle.trim().toLowerCase();
  const user = overview.users.find((entry) => entry.username.toLowerCase() === lowered || entry.id === needle);
  if (!user) throw new Error(`No team account matches "${needle}". Use team.directory.`);
  return { user, overview };
}

function resolveMachines(team: TeamService, needles: string[]): string[] {
  const overview = team.overview();
  return needles.map((needle) => {
    const lowered = needle.trim().toLowerCase();
    const machine = overview.machines.find(
      (entry) => entry.id === needle || entry.label.toLowerCase() === lowered || entry.host.toLowerCase() === lowered,
    );
    if (!machine) throw new Error(`No team machine matches "${needle}". Use team.directory.`);
    return machine.id;
  });
}

/* ------------------------------------------------------------------ tools */

export function registerAppTools(registry: ToolRegistry): void {
  registry.register({
    name: "app.overview",
    title: "App overview",
    description:
      "Version, runtime, data paths, whether the desktop window is running, inventory counts, and current settings.",
    category: "read",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, ctx) => ({
      version: appVersion(ctx.appRoot),
      appRoot: ctx.appRoot,
      dataHome: nexusHome(),
      desktopAppRunning: desktopAppRunning(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      counts: {
        proxmoxHosts: ctx.store.hosts().length,
        sshHosts: ctx.store.sshHosts().length,
      },
      settings: ctx.store.settings(),
    }),
  });

  registry.register({
    name: "app.settings",
    title: "Read app settings",
    description: "Current interface and polling settings (uiScale, pollMs, accent, confirmations, GPU alert thresholds).",
    category: "read",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, ctx) => ctx.store.settings(),
  });

  registry.register({
    name: "app.settings.save",
    title: "Update app settings",
    description:
      "Patch settings: pollMs (1000-60000), uiScale (75-150), accent, confirmDestructive, reduceMotion, gpuAlerts.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        pollMs: { type: "number", description: "Polling interval in milliseconds (1000-60000)" },
        uiScale: { type: "number", description: "Interface zoom percentage (75-150)" },
        accent: { type: "string" },
        confirmDestructive: { type: "boolean" },
        reduceMotion: { type: "boolean" },
        gpuAlerts: {
          type: "object",
          description: "GPU alert thresholds: temperatureC, temperatureSamples, powerPct, vramPct",
        },
      },
    },
    run: async (args, ctx) => {
      const patch: Record<string, unknown> = {};
      const pollMs = optionalNumber(args, "pollMs");
      if (pollMs !== undefined) {
        if (pollMs < 1000 || pollMs > 60_000) throw new Error("\"pollMs\" must be between 1000 and 60000");
        patch.pollMs = Math.round(pollMs);
      }
      if (args.uiScale !== undefined) patch.uiScale = normalizeUiScale(args.uiScale);
      if (typeof args.accent === "string" && args.accent.trim()) patch.accent = args.accent.trim();
      const confirmDestructive = optionalBoolean(args, "confirmDestructive");
      if (confirmDestructive !== undefined) patch.confirmDestructive = confirmDestructive;
      const reduceMotion = optionalBoolean(args, "reduceMotion");
      if (reduceMotion !== undefined) patch.reduceMotion = reduceMotion;
      if (args.gpuAlerts && typeof args.gpuAlerts === "object") patch.gpuAlerts = args.gpuAlerts;
      if (Object.keys(patch).length === 0) throw new Error("Nothing to change: pass at least one setting.");
      return ctx.store.setSettings(patch);
    },
  });

  registry.register({
    name: "fleet.inventory",
    title: "Fleet inventory",
    description: "Every configured Proxmox endpoint and Linux SSH host, sanitized: no secrets or private key material.",
    category: "read",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, ctx) => ({
      proxmox: ctx.store.hosts().map(publicHost),
      linux: ctx.store.sshHosts().map((host) => ctx.store.publicSshHost(host)),
    }),
  });

  registry.register({
    name: "hosts.save",
    title: "Add or update a Proxmox host",
    description:
      "Create a Proxmox endpoint or update an existing one. Omit \"id\" to create. The secret is stored encrypted and never returned.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing host id to update" },
        label: { type: "string" },
        baseUrl: { type: "string", description: "https://host:8006" },
        authMode: { type: "string", enum: ["token", "password"] },
        tokenId: { type: "string", description: "user@realm!tokenname for token auth" },
        username: { type: "string", description: "user@realm for password auth" },
        tlsVerify: { type: "boolean", description: "Defaults to true" },
        secret: { type: "string", description: "Token secret or password; omit to keep the stored one" },
        color: { type: "string" },
      },
      required: ["label", "baseUrl", "authMode"],
    },
    run: async (args, ctx) => {
      const authMode = requireString(args, "authMode");
      if (authMode !== "token" && authMode !== "password") throw new Error("\"authMode\" must be token or password");
      const input: HostInput = {
        id: optionalString(args, "id"),
        label: requireString(args, "label"),
        baseUrl: requireString(args, "baseUrl"),
        authMode,
        tokenId: optionalString(args, "tokenId"),
        username: optionalString(args, "username"),
        tlsVerify: optionalBoolean(args, "tlsVerify") ?? true,
        secret: optionalString(args, "secret"),
        color: optionalString(args, "color"),
      };
      return ctx.store.saveHost(input);
    },
  });

  registry.register({
    name: "hosts.remove",
    title: "Remove a Proxmox host",
    description: "Delete a configured Proxmox endpoint. Requires \"confirm\": true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string", description: "Host id or label" }, confirm: { type: "boolean" } },
      required: ["host"],
    },
    run: async (args, ctx) => {
      const host = findHost(ctx.store, requireString(args, "host"));
      await confirmDestructive(ctx, args, { title: `Remove Proxmox host ${host.label}`, tool: "hosts.remove", args });
      ctx.store.removeHost(host.id);
      return { removed: host.label, id: host.id, remaining: ctx.store.hosts().length };
    },
  });

  registry.register({
    name: "ssh.hosts.save",
    title: "Add or update a Linux SSH host",
    description:
      "Create or update an SSH inventory entry. Password auth stores the password encrypted; key auth takes a key path or falls back to the agent.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        label: { type: "string" },
        host: { type: "string", description: "Hostname or IP" },
        port: { type: "number", description: "Defaults to 22" },
        username: { type: "string" },
        authMode: { type: "string", enum: ["key", "password"] },
        keyPath: { type: "string" },
        password: { type: "string" },
        color: { type: "string" },
        vncPort: { type: "number" },
      },
      required: ["label", "host", "username"],
    },
    run: async (args, ctx) => {
      const input: SshHostInput = {
        id: optionalString(args, "id"),
        label: requireString(args, "label"),
        host: requireString(args, "host"),
        port: optionalNumber(args, "port") ?? 22,
        username: requireString(args, "username"),
        authMode: args.authMode === "password" ? "password" : "key",
        keyPath: optionalString(args, "keyPath"),
        password: optionalString(args, "password"),
        color: optionalString(args, "color"),
        vncPort: optionalNumber(args, "vncPort"),
      };
      return ctx.store.saveSshHost(input);
    },
  });

  registry.register({
    name: "ssh.hosts.remove",
    title: "Remove a Linux SSH host",
    description: "Delete an SSH inventory entry. Requires \"confirm\": true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string", description: "Host id, label or hostname" }, confirm: { type: "boolean" } },
      required: ["host"],
    },
    run: async (args, ctx) => {
      const host = findSshHost(ctx.store, requireString(args, "host")) as { id: string; label: string };
      await confirmDestructive(ctx, args, { title: `Remove SSH host ${host.label}`, tool: "ssh.hosts.remove", args });
      ctx.store.removeSshHost(host.id);
      return { removed: host.label, remaining: ctx.store.sshHosts().length };
    },
  });

  registry.register({
    name: "team.directory",
    title: "Team directory",
    description:
      "Accounts, roles, statuses, machines and machine grants from team.sqlite. Read-only and password-free; safe while the app is open.",
    category: "read",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, ctx) => readTeamDirectory(ctx.appRoot),
  });

  registry.register({
    name: "team.user.create",
    title: "Create a team account",
    description:
      "Create an account with a role and optional machine grants. Acts as the workspace super admin. Requires the desktop app to be closed.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        displayName: { type: "string" },
        password: { type: "string", description: "At least 8 characters" },
        role: { type: "string", enum: ["superadmin", "admin", "moderator", "user"] },
        grantAllMachines: { type: "boolean" },
        machines: { type: "array", description: "Machine labels or ids to grant" },
      },
      required: ["username", "displayName", "password"],
    },
    run: async (args, ctx) => {
      const input: TeamUserInput = {
        username: requireString(args, "username"),
        displayName: requireString(args, "displayName"),
        password: requireString(args, "password"),
        role: (optionalString(args, "role") as TeamRole) ?? "user",
      };
      if (!["superadmin", "admin", "moderator", "user"].includes(input.role)) throw new Error("Invalid role.");
      if (optionalBoolean(args, "grantAllMachines")) input.grantAllMachines = true;
      else if (Array.isArray(args.machines) && args.machines.length > 0) {
        input.machineIds = await withTeam(ctx.appRoot, "resolving machines", (team) =>
          resolveMachines(team, args.machines as string[]),
        );
      }
      const overview = await withTeam(ctx.appRoot, "creating a team account", (team) => team.createUser(input));
      return {
        created: input.username,
        role: input.role,
        users: overview.users.map((user) => ({ username: user.username, role: user.role, status: user.status })),
      };
    },
  });

  registry.register({
    name: "team.user.update",
    title: "Update a team account",
    description: "Change a member's display name, role, status or password. Requires the desktop app to be closed.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        displayName: { type: "string" },
        role: { type: "string", enum: ["superadmin", "admin", "moderator", "user"] },
        status: { type: "string", enum: ["active", "suspended"] },
        password: { type: "string" },
      },
      required: ["username"],
    },
    run: async (args, ctx) => {
      const patch: TeamUserPatch = {};
      const displayName = optionalString(args, "displayName");
      if (displayName) patch.displayName = displayName;
      const role = optionalString(args, "role") as TeamRole | undefined;
      if (role) {
        if (!["superadmin", "admin", "moderator", "user"].includes(role)) throw new Error("Invalid role.");
        patch.role = role;
      }
      const status = optionalString(args, "status") as TeamStatus | undefined;
      if (status) {
        if (status !== "active" && status !== "suspended") throw new Error("Invalid status.");
        patch.status = status;
      }
      const password = optionalString(args, "password");
      if (password) patch.password = password;
      if (Object.keys(patch).length === 0) throw new Error("Nothing to change.");
      const username = requireString(args, "username");
      const overview = await withTeam(ctx.appRoot, "updating a team account", (team) => {
        const { user } = resolveUser(team, username);
        return team.updateUser(user.id, patch);
      });
      return {
        updated: username,
        changed: Object.keys(patch),
        users: overview.users.map((user) => ({ username: user.username, role: user.role, status: user.status })),
      };
    },
  });

  registry.register({
    name: "team.user.delete",
    title: "Delete a team account",
    description: "Remove an account and its grants. Requires \"confirm\": true and the desktop app to be closed.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string" }, confirm: { type: "boolean" } },
      required: ["username"],
    },
    run: async (args, ctx) => {
      const username = requireString(args, "username");
      await confirmDestructive(ctx, args, { title: `Delete team account ${username}`, tool: "team.user.delete", args });
      const overview = await withTeam(ctx.appRoot, "deleting a team account", (team) => {
        const { user } = resolveUser(team, username);
        return team.deleteUser(user.id);
      });
      return { deleted: username, users: overview.users.map((user) => user.username) };
    },
  });

  registry.register({
    name: "team.user.grant",
    title: "Set machine grants for an account",
    description:
      "Replace a member's machine grants. Pass \"all\": true to grant every machine, or a list of labels/ids. Requires the desktop app to be closed.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        all: { type: "boolean" },
        machines: { type: "array", description: "Machine labels or ids" },
      },
      required: ["username"],
    },
    run: async (args, ctx) => {
      const username = requireString(args, "username");
      const all = optionalBoolean(args, "all") ?? false;
      const requested = Array.isArray(args.machines) ? (args.machines as string[]) : [];
      const overview = await withTeam(ctx.appRoot, "changing machine grants", (team) => {
        const resolved = resolveUser(team, username);
        const machineIds = all ? resolved.overview.machines.map((machine) => machine.id) : resolveMachines(team, requested);
        return team.setUserMachineLinks(resolved.user.id, machineIds);
      });
      const member = overview.users.find((user) => user.username.toLowerCase() === username.toLowerCase());
      return { username: member?.username ?? username, machines: member?.linkedMachines ?? 0 };
    },
  });
}

