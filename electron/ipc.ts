import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { IPC } from "../shared/ipc";
import type {
  BackupRunRequest,
  HostInput,
  McpStatus,
  RestoreRequest,
  ScheduleInput,
  SshAction,
  SshHostInput,
  TeamBootstrapInput,
  TeamAuditFilter,
  TeamLoginInput,
  TeamSyncConfigInput,
  TeamUserInput,
  TeamUserPatch,
  VmAction,
  VmType,
} from "../shared/types";
import type { TeamService } from "./team/store";
import type { TeamSyncService } from "./team/sync";
import { normalizeBaseUrl } from "./config";
import { nexusHome } from "./paths";
import { createSnapshot, deleteSnapshot, rollbackSnapshot } from "./pve/api";
import { mcpServerPath, type Runtime } from "./agent/runtime";
import {
  collectSshSnapshot,
  execOnHost,
  listSshHosts,
  probeSshHealth,
  removeSshHost,
  saveSshHost,
  testSshHost,
} from "./ssh/collect";
import { actOnSshHost, runSpeedTest, runSpeedTestAll } from "./ssh/actions";
import { checkHelper, installHelper } from "./ssh/helper";
import { guardian } from "./security/guardian";
import { ddos } from "./ddos/service";
import type { DdosConfig, DdosMode } from "../shared/ddos-types";
import { relay } from "./relay/service";
import { vnc } from "./vnc/service";
import * as praetor from "./praetor/service";
import type { RelayChainInput } from "../shared/fabric-types";
import {
  actOnVm,
  collectSnapshot,
  dropClient,
  getVmDetail,
  hostClient,
  invalidate,
  listArchives,
  nodeRrd,
  persistSchedule,
  removeArchive,
  removeSchedule,
  restore,
  startBackup,
  taskLog,
  testHost,
} from "./pve/collect";

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function num(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function vmType(value: unknown): VmType {
  if (value === "qemu" || value === "lxc") return value;
  throw new Error("VM type must be qemu or lxc");
}

export function registerIpc(runtime: Runtime, team: TeamService, teamSync: TeamSyncService): void {
  const { store, registry, pipelines } = runtime;
  const requireOperator = () => {
    const user = team.currentUser();
    if (user.role === "user") throw new Error("Admin or moderator access required.");
    return user;
  };
  const guardSshHost = (hostId: string) => {
    const user = team.currentUser();
    if (user.role === "user" && !team.canAccessMachine(user.id, hostId)) {
      throw new Error("This machine is not linked to your account. Ask an admin for access.");
    }
    return user;
  };

  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: `${process.platform} ${process.arch}`,
    userData: app.getPath("userData"),
    configPath: store.file,
    mcpServerPath: mcpServerPath(app.getAppPath(), app.isPackaged),
  }));

  ipcMain.handle(IPC.appWindow, (event, action: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === "minimize") win.minimize();
    else if (action === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === "close") win.close();
  });

  ipcMain.handle(IPC.openExternal, async (_event, url: unknown) => {
    const target = str(url, "url");
    const parsed = new URL(target);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Only http(s) links can be opened");
    await shell.openExternal(target);
  });

  ipcMain.handle(IPC.authStatus, () => team.status());
  ipcMain.handle(IPC.authBootstrap, (_event, input: TeamBootstrapInput) =>
    team.bootstrap(input ?? ({} as TeamBootstrapInput)),
  );
  ipcMain.handle(IPC.authLogin, (_event, input: TeamLoginInput) => team.login(input ?? ({} as TeamLoginInput)));
  ipcMain.handle(IPC.authLogout, () => team.logout());
  ipcMain.handle(IPC.authRefreshSession, () => team.refreshSession());
  ipcMain.handle(IPC.authChangePassword, (_event, currentPassword: unknown, nextPassword: unknown) =>
    team.changePassword(str(currentPassword, "current password"), str(nextPassword, "new password")),
  );

  ipcMain.handle(IPC.teamOverview, () => {
    team.syncMachines(listSshHosts(store));
    return team.overview();
  });
  ipcMain.handle(IPC.teamCreateUser, (_event, input: TeamUserInput) =>
    team.createUser(input ?? ({} as TeamUserInput)),
  );
  ipcMain.handle(IPC.teamUpdateUser, (_event, id: unknown, patch: TeamUserPatch) =>
    team.updateUser(str(id, "member id"), patch ?? ({} as TeamUserPatch)),
  );
  ipcMain.handle(IPC.teamDeleteUser, (_event, id: unknown) => team.deleteUser(str(id, "member id")));
  ipcMain.handle(IPC.teamSetMachineLinks, (_event, machineId: unknown, userIds: unknown) => {
    team.syncMachines(listSshHosts(store));
    const ids = Array.isArray(userIds) ? userIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    return team.setMachineLinks(str(machineId, "machine id"), ids);
  });
  ipcMain.handle(IPC.teamAudit, (_event, filter: TeamAuditFilter | undefined) =>
    team.auditLog(filter ?? {}),
  );
  ipcMain.handle(IPC.teamAuditExport, async (event, filter: TeamAuditFilter | undefined) => {
    const audit = team.auditCsv(filter ?? {});
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `nexus-team-audit-${stamp}.csv`;
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: "Export team audit log",
      defaultPath: path.join(app.getPath("documents"), filename),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    };
    const choice = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (choice.canceled || !choice.filePath) return { count: 0, filename: "", path: "" };
    fs.writeFileSync(choice.filePath, audit.csv, { mode: 0o600 });
    team.recordAuditExport(audit.count);
    return { count: audit.count, filename: path.basename(choice.filePath), path: choice.filePath };
  });

  const allowSyncManagement = () => {
    const state = team.status();
    if (state.initialized && state.user?.role !== "admin") {
      throw new Error("Only an active admin can change cross-device sync.");
    }
    return state;
  };
  ipcMain.handle(IPC.teamSyncStatus, () => teamSync.status());
  ipcMain.handle(IPC.teamSyncConfigure, (_event, input: TeamSyncConfigInput) => {
    allowSyncManagement();
    return teamSync.configure(input ?? ({} as TeamSyncConfigInput));
  });
  ipcMain.handle(IPC.teamSyncNow, () => {
    allowSyncManagement();
    return teamSync.syncNow();
  });
  ipcMain.handle(IPC.teamSyncDisable, () => {
    allowSyncManagement();
    return teamSync.disable();
  });

  ipcMain.handle(IPC.hostsList, () => {
    if (team.currentUser().role === "user") return [];
    return store.hosts().map(({ secretEnc: _secret, ...rest }) => rest);
  });

  ipcMain.handle(IPC.hostsSave, (_event, input: HostInput) => {
    requireOperator();
    const saved = store.saveHost({ ...input, baseUrl: normalizeBaseUrl(input.baseUrl) });
    dropClient(saved.id);
    invalidate(saved.id);
    return saved;
  });

  ipcMain.handle(IPC.hostsRemove, (_event, id: unknown) => {
    requireOperator();
    const hostId = str(id, "host id");
    store.removeHost(hostId);
    dropClient(hostId);
    invalidate(hostId);
  });

  ipcMain.handle(IPC.hostsTest, (_event, input: HostInput) => {
    requireOperator();
    return testHost({ ...input, baseUrl: normalizeBaseUrl(input.baseUrl) });
  });

  ipcMain.handle(IPC.sshHostsList, () => {
    const user = team.currentUser();
    const all = listSshHosts(store);
    team.syncMachines(all);
    return user.role === "user" ? all.filter((host) => team.canAccessMachine(user.id, host.id)) : all;
  });
  ipcMain.handle(IPC.sshHostsSave, (_event, input: SshHostInput) => {
    const user = requireOperator();
    const saved = saveSshHost(store, input);
    team.syncMachines(listSshHosts(store));
    void user;
    return saved;
  });
  ipcMain.handle(IPC.sshHostsRemove, (_event, id: unknown) => {
    const user = requireOperator();
    const hostId = str(id, "host id");
    removeSshHost(store, hostId);
    team.removeMachine(hostId, user);
  });
  ipcMain.handle(IPC.sshHostsTest, (_event, input: SshHostInput) => {
    requireOperator();
    return testSshHost(input);
  });
  ipcMain.handle(IPC.sshSnapshot, (_event, hostId: unknown) => {
    const id = str(hostId, "host id");
    guardSshHost(id);
    return collectSshSnapshot(store, id);
  });
  ipcMain.handle(IPC.sshHealth, async () => {
    const user = team.currentUser();
    const results = await probeSshHealth(store);
    return user.role === "user" ? results.filter((entry) => team.canAccessMachine(user.id, entry.id)) : results;
  });
  ipcMain.handle(IPC.sshExec, (_event, hostId, command, options) => {
    const id = str(hostId, "host id");
    guardSshHost(id);
    return execOnHost(store, id, str(command, "command"), {
      allowShell: Boolean(options && typeof options === "object" && (options as { shell?: boolean }).shell),
      timeoutMs: typeof options === "object" && options && Number((options as { timeoutMs?: number }).timeoutMs) > 0
        ? Number((options as { timeoutMs?: number }).timeoutMs)
        : undefined,
    });
  });
  ipcMain.handle(IPC.sshSpeedtest, (_event, hostId: unknown) => {
    const id = str(hostId, "host id");
    guardSshHost(id);
    return runSpeedTest(store, id);
  });
  ipcMain.handle(IPC.sshSpeedtestAll, () => {
    const user = team.currentUser();
    const allowed = user.role === "user"
      ? listSshHosts(store).filter((host) => team.canAccessMachine(user.id, host.id)).map((host) => host.id)
      : undefined;
    return runSpeedTestAll(store, allowed);
  });
  ipcMain.handle(IPC.sshAction, (_event, hostId, action, target) => {
    const id = str(hostId, "host id");
    guardSshHost(id);
    return actOnSshHost(store, id, str(action, "action") as SshAction, typeof target === "string" ? target : undefined);
  });
  ipcMain.handle(IPC.sshHelper, (_event, hostId: unknown) => {
    const id = str(hostId, "host id");
    guardSshHost(id);
    return checkHelper(store, app.getAppPath(), id);
  });
  ipcMain.handle(IPC.sshHelperInstall, (_event, hostId: unknown, sudoPassword: unknown) => {
    const id = str(hostId, "host id");
    guardSshHost(id);
    return installHelper(store, app.getAppPath(), id, typeof sudoPassword === "string" ? sudoPassword : undefined, {
      trigger: "manual",
    });
  });

  ipcMain.handle(IPC.securityOverview, () => {
    requireOperator();
    return guardian.overview();
  });
  ipcMain.handle(IPC.securityScan, (_event, hostId: unknown) => {
    requireOperator();
    return guardian.scan(str(hostId, "host id"));
  });
  ipcMain.handle(IPC.securityEnforce, (_event, hostId: unknown, action: unknown, options: unknown) => {
    requireOperator();
    return guardian.enforce(str(hostId, "host id"), str(action, "action"), {
      confirm: Boolean((options as { confirm?: boolean } | undefined)?.confirm),
    });
  });
  ipcMain.handle(IPC.securityPolicy, (_event, patch: unknown) => {
    requireOperator();
    return guardian.setPolicy((patch ?? {}) as Record<string, unknown>);
  });
  ipcMain.handle(IPC.securityJournal, (_event, limit: unknown) => {
    requireOperator();
    return guardian.journal.list(typeof limit === "number" ? limit : 200);
  });
  ipcMain.handle(IPC.securityAcceptBaseline, (_event, hostId: unknown) => {
    requireOperator();
    return guardian.acceptBaseline(str(hostId, "host id"));
  });
  ipcMain.handle(IPC.securityVerify, () => {
    requireOperator();
    return guardian.journal.verify();
  });
  ipcMain.handle(IPC.securityResident, (_event, hostId: unknown, enable: unknown) => {
    requireOperator();
    return guardian.resident(str(hostId, "host id"), enable === true);
  });
  ipcMain.handle(IPC.securityBan, (_event, hostId: unknown, address: unknown) => {
    requireOperator();
    return guardian.ban(str(hostId, "host id"), str(address, "address"));
  });
  ipcMain.handle(IPC.securityBans, (_event, hostId: unknown) => {
    requireOperator();
    return guardian.bans(str(hostId, "host id"));
  });

  ipcMain.handle(IPC.pveSnapshot, (_event, hostId: unknown) => {
    requireOperator();
    return collectSnapshot(store, str(hostId, "host id"));
  });

  ipcMain.handle(IPC.pveVmDetail, (_event, hostId, node, type, vmid) => {
    requireOperator();
    return getVmDetail(store, str(hostId, "host id"), str(node, "node"), vmType(type), num(vmid, "vmid"));
  });

  ipcMain.handle(IPC.pveVmAction, (_event, hostId, node, type, vmid, action) => {
    requireOperator();
    return actOnVm(store, str(hostId, "host id"), str(node, "node"), vmType(type), num(vmid, "vmid"), str(action, "action") as VmAction);
  });

  ipcMain.handle(IPC.pveSnapshotCreate, async (_event, hostId, node, type, vmid, name, description) => {
    requireOperator();
    const host = str(hostId, "host id");
    const upid = await createSnapshot(
      hostClient(store, host),
      str(node, "node"),
      vmType(type),
      num(vmid, "vmid"),
      str(name, "snapshot name"),
      typeof description === "string" ? description : undefined,
    );
    invalidate(host);
    return { upid };
  });

  ipcMain.handle(IPC.pveSnapshotRollback, async (_event, hostId, node, type, vmid, name) => {
    requireOperator();
    const host = str(hostId, "host id");
    const upid = await rollbackSnapshot(hostClient(store, host), str(node, "node"), vmType(type), num(vmid, "vmid"), str(name, "snapshot name"));
    invalidate(host);
    return { upid };
  });

  ipcMain.handle(IPC.pveSnapshotDelete, async (_event, hostId, node, type, vmid, name) => {
    requireOperator();
    const host = str(hostId, "host id");
    await deleteSnapshot(hostClient(store, host), str(node, "node"), vmType(type), num(vmid, "vmid"), str(name, "snapshot name"));
    invalidate(host);
  });

  ipcMain.handle(IPC.pveTaskLog, (_event, hostId, node, upid) => {
    requireOperator();
    return taskLog(store, str(hostId, "host id"), str(node, "node"), str(upid, "upid"));
  });

  ipcMain.handle(IPC.pveNodeRrd, (_event, hostId, node, timeframe) => {
    requireOperator();
    const frame = timeframe === "day" || timeframe === "week" ? timeframe : "hour";
    return nodeRrd(store, str(hostId, "host id"), str(node, "node"), frame);
  });

  ipcMain.handle(IPC.backupArchives, (_event, hostId) => {
    requireOperator();
    return listArchives(store, str(hostId, "host id"));
  });

  ipcMain.handle(IPC.backupRun, (_event, hostId, req: BackupRunRequest) => {
    requireOperator();
    return startBackup(store, str(hostId, "host id"), { ...req, node: str(req?.node, "node") });
  });

  ipcMain.handle(IPC.backupRestore, (_event, hostId, req: RestoreRequest) => {
    requireOperator();
    return restore(store, str(hostId, "host id"), {
      ...req,
      node: str(req?.node, "node"),
      vmid: num(req?.vmid, "vmid"),
      archive: str(req?.archive, "archive"),
      type: req?.type === "lxc" ? "lxc" : "qemu",
    });
  });

  ipcMain.handle(IPC.backupRemove, (_event, hostId, node, storage, volid) => {
    requireOperator();
    return removeArchive(store, str(hostId, "host id"), str(node, "node"), str(storage, "storage"), str(volid, "volid"));
  });

  ipcMain.handle(IPC.backupScheduleSave, (_event, hostId, input: ScheduleInput) => {
    requireOperator();
    return persistSchedule(store, str(hostId, "host id"), {
      ...input,
      node: str(input?.node, "node"),
      storage: str(input?.storage, "storage"),
      schedule: str(input?.schedule, "schedule"),
      mode: input?.mode ?? "snapshot",
      compress: input?.compress ?? "zstd",
      enabled: input?.enabled !== false,
    });
  });

  ipcMain.handle(IPC.backupScheduleDelete, (_event, hostId, id) => {
    requireOperator();
    return removeSchedule(store, str(hostId, "host id"), str(id, "schedule id"));
  });

  ipcMain.handle(IPC.pipelineList, () => pipelines.definitions());
  ipcMain.handle(IPC.pipelineRuns, () => pipelines.history());
  ipcMain.handle(IPC.pipelineRun, (_event, pipelineId, hostId, vars) => {
    requireOperator();
    return pipelines.start(str(pipelineId, "pipeline"), str(hostId, "host"), vars && typeof vars === "object" ? vars : {});
  });
  ipcMain.handle(IPC.pipelineApprove, (_event, runId, approved) => {
    requireOperator();
    return pipelines.approve(str(runId, "run id"), approved === true);
  });
  ipcMain.handle(IPC.pipelineCancel, (_event, runId) => {
    requireOperator();
    return pipelines.cancel(str(runId, "run id"));
  });

  ipcMain.handle(IPC.ddosOverview, () => {
    requireOperator();
    return ddos.overview();
  });
  ipcMain.handle(IPC.ddosStatus, (_event, hostId: unknown) => {
    requireOperator();
    return ddos.status(str(hostId, "host id"), true);
  });
  ipcMain.handle(IPC.ddosInstall, (_event, hostId: unknown) => {
    requireOperator();
    return ddos.install(str(hostId, "host id"));
  });
  ipcMain.handle(IPC.ddosMode, (_event, hostId: unknown, mode: unknown) => {
    requireOperator();
    return ddos.setMode(str(hostId, "host id"), str(mode, "mode") as DdosMode);
  });
  ipcMain.handle(IPC.ddosBan, (_event, hostId: unknown, ip: unknown, seconds: unknown, reason: unknown) => {
    requireOperator();
    return ddos.ban(
      str(hostId, "host id"),
      str(ip, "ip"),
      typeof seconds === "number" && Number.isFinite(seconds) ? seconds : undefined,
      typeof reason === "string" ? reason : undefined,
    );
  });
  ipcMain.handle(IPC.ddosUnban, (_event, hostId: unknown, ip: unknown) => {
    requireOperator();
    return ddos.unban(str(hostId, "host id"), str(ip, "ip"));
  });
  ipcMain.handle(IPC.ddosAllow, (_event, hostId: unknown, ip: unknown, add: unknown) => {
    requireOperator();
    return ddos.allow(str(hostId, "host id"), str(ip, "ip"), add !== false);
  });
  ipcMain.handle(IPC.ddosApply, (_event, hostId: unknown, patch: unknown) => {
    requireOperator();
    return ddos.apply(str(hostId, "host id"), (patch ?? {}) as Partial<DdosConfig>);
  });
  ipcMain.handle(IPC.ddosJournal, (_event, limit: unknown) => {
    requireOperator();
    return ddos.journal(typeof limit === "number" ? limit : 100);
  });

  ipcMain.handle(IPC.relayOverview, () => {
    requireOperator();
    return relay.overview();
  });
  ipcMain.handle(IPC.relaySave, (_event, input: RelayChainInput) => {
    requireOperator();
    return relay.save(input);
  });
  ipcMain.handle(IPC.relayProbe, () => {
    requireOperator();
    return relay.probe();
  });
  ipcMain.handle(IPC.relayDeploy, () => {
    requireOperator();
    return relay.deploy();
  });
  ipcMain.handle(IPC.relayRemove, () => {
    requireOperator();
    return relay.remove();
  });
  ipcMain.handle(IPC.vncPreflight, (_event, hostId: unknown) => {
    const id = str(hostId, "host id");
    guardSshHost(id);
    return vnc.preflight(id);
  });
  ipcMain.handle(IPC.vncSetup, (_event, hostId: unknown, sudoPassword: unknown) => {
    const id = str(hostId, "host id");
    guardSshHost(id);
    requireOperator();
    return vnc.setup(id, typeof sudoPassword === "string" ? sudoPassword : undefined);
  });
  ipcMain.handle(IPC.vncOpen, (_event, hostId: unknown, port: unknown) => {
    const id = str(hostId, "host id");
    guardSshHost(id);
    return vnc.open(id, typeof port === "number" ? port : undefined);
  });
  ipcMain.handle(IPC.vncClose, (_event, sessionId: unknown) => vnc.close(str(sessionId, "session id")));

  ipcMain.handle(IPC.praetorOverview, () => {
    requireOperator();
    return praetor.overview(store);
  });
  ipcMain.handle(IPC.praetorHealth, (_event, target: unknown) => {
    const key = str(target, "host");
    const host = store.sshHosts().find((entry) => entry.id === key || entry.label.toLowerCase() === key.toLowerCase());
    if (!host) return null;
    guardSshHost(host.id);
    return praetor.hostHealth(store, host.id);
  });
  ipcMain.handle(IPC.praetorInstall, (_event, hostId: unknown) => {
    requireOperator();
    const id = str(hostId, "host id");
    guardSshHost(id);
    return praetor.install(store, id);
  });
  ipcMain.handle(IPC.praetorRotate, (_event, hostId: unknown) => {
    requireOperator();
    const id = str(hostId, "host id");
    guardSshHost(id);
    return praetor.rotate(store, id);
  });

  ipcMain.handle(IPC.mcpStatus, (): McpStatus => {
    const server = mcpServerPath(app.getAppPath(), app.isPackaged);
    return {
      serverPath: server,
      command: "node",
      args: [server],
      toolCount: registry.list().length,
      configPath: mcpTarget("claude").file,
      hostCount: store.hosts().length,
    };
  });

  ipcMain.handle(IPC.mcpWriteConfig, (_event, target: unknown) => {
    requireOperator();
    return writeMcpConfig(target);
  });
}

interface McpTarget {
  file: string;
  key: "mcpServers" | "servers";
  style: "claude" | "vscode";
}

export function mcpTarget(target: "claude" | "cursor" | "vscode"): McpTarget {
  const home = os.homedir();
  if (target === "cursor") {
    return { file: path.join(home, ".cursor", "mcp.json"), key: "mcpServers", style: "claude" };
  }
  if (target === "vscode") {
    return { file: path.join(mcpServerRoot(), ".vscode", "mcp.json"), key: "servers", style: "vscode" };
  }
  const appData = process.env.APPDATA;
  const base =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Claude")
      : appData
        ? path.join(appData, "Claude")
        : path.join(home, ".config", "Claude");
  return { file: path.join(base, "claude_desktop_config.json"), key: "mcpServers", style: "claude" };
}

function mcpServerRoot(): string {
  // VS Code reads a workspace config, which only exists in a source checkout.
  return process.cwd();
}

/**
 * A copy of the MCP bundle and its resource directory in the app's own data
 * directory. The portable build extracts itself to a temp folder that
 * disappears on exit, so pointing an MCP client at the bundle inside the
 * install would break the next day. The resources must travel with the bundle:
 * the MCP server resolves PRAETOR, DDoS and helper payloads relative to its own
 * parent directory.
 */
function stableMcpServer(): string {
  const source = mcpServerPath(app.getAppPath(), app.isPackaged);
  const root = nexusHome();
  const target = path.join(root, "mcp", "mcp-server.cjs");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target);

  const bundled = path.join(app.getAppPath(), "resources");
  const unpacked = bundled.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  const resourceSource = app.isPackaged && fs.existsSync(unpacked) ? unpacked : bundled;
  if (!fs.existsSync(resourceSource)) throw new Error(`Bundled MCP resources are missing: ${resourceSource}`);
  const resourceTarget = path.join(root, "resources");
  if (path.resolve(resourceSource) !== path.resolve(resourceTarget)) {
    fs.rmSync(resourceTarget, { recursive: true, force: true });
    fs.cpSync(resourceSource, resourceTarget, { recursive: true });
  }
  return target;
}

function writeMcpConfig(target: unknown): { path: string } {
  if (target !== "claude" && target !== "cursor" && target !== "vscode") {
    throw new Error("Unknown MCP target");
  }
  if (target === "vscode" && app.isPackaged) {
    throw new Error("VS Code MCP config is workspace-scoped; run Nexus PVE from a source checkout for that target.");
  }
  const config = mcpTarget(target);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(config.file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Refusing to overwrite unreadable ${config.file}`);
    }
  }
  const servers = (existing[config.key] as Record<string, unknown> | undefined) ?? {};
  // ELECTRON_RUN_AS_NODE means the app itself is the MCP runtime, so no system
  // Node install is required. PORTABLE_EXECUTABLE_FILE survives the portable
  // build's temp extraction; process.execPath is that temp copy.
  servers["nexus-pve"] = {
    command: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
    args: [stableMcpServer()],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    ...(config.style === "vscode" ? { type: "stdio" } : {}),
  };
  existing[config.key] = servers;
  fs.mkdirSync(path.dirname(config.file), { recursive: true });
  const tmp = `${config.file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), "utf8");
  fs.renameSync(tmp, config.file);
  return { path: config.file };
}
