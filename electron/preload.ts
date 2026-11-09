import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc";
import type {
  BackupRunRequest,
  DdosConfig,
  DdosMode,
  HostInput,
  NexusBridge,
  NexusEvent,
  RestoreRequest,
  ScheduleInput,
  SshAction,
  SshHostInput,
  TeamBootstrapInput,
  TeamLoginInput,
  TeamUserInput,
  TeamUserPatch,
  VmAction,
  VmType,
  TeamAuditFilter,
  TeamSyncConfigInput,
} from "../shared/types";

const bridge: NexusBridge = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    window: (action) => ipcRenderer.invoke(IPC.appWindow, action),
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  },
  auth: {
    status: () => ipcRenderer.invoke(IPC.authStatus),
    bootstrap: (input: TeamBootstrapInput) => ipcRenderer.invoke(IPC.authBootstrap, input),
    login: (input: TeamLoginInput) => ipcRenderer.invoke(IPC.authLogin, input),
    logout: () => ipcRenderer.invoke(IPC.authLogout),
    refreshSession: () => ipcRenderer.invoke(IPC.authRefreshSession),
    changePassword: (currentPassword: string, nextPassword: string) =>
      ipcRenderer.invoke(IPC.authChangePassword, currentPassword, nextPassword),
  },
  team: {
    overview: () => ipcRenderer.invoke(IPC.teamOverview),
    createUser: (input: TeamUserInput) => ipcRenderer.invoke(IPC.teamCreateUser, input),
    updateUser: (id: string, patch: TeamUserPatch) => ipcRenderer.invoke(IPC.teamUpdateUser, id, patch),
    deleteUser: (id: string) => ipcRenderer.invoke(IPC.teamDeleteUser, id),
    setMachineLinks: (machineId: string, userIds: string[]) =>
      ipcRenderer.invoke(IPC.teamSetMachineLinks, machineId, userIds),
    audit: (filter?: TeamAuditFilter) => ipcRenderer.invoke(IPC.teamAudit, filter),
    exportAudit: (filter?: TeamAuditFilter) => ipcRenderer.invoke(IPC.teamAuditExport, filter),
  },
  teamSync: {
    status: () => ipcRenderer.invoke(IPC.teamSyncStatus),
    configure: (input: TeamSyncConfigInput) => ipcRenderer.invoke(IPC.teamSyncConfigure, input),
    now: () => ipcRenderer.invoke(IPC.teamSyncNow),
    disable: () => ipcRenderer.invoke(IPC.teamSyncDisable),
  },
  hosts: {
    list: () => ipcRenderer.invoke(IPC.hostsList),
    save: (input: HostInput) => ipcRenderer.invoke(IPC.hostsSave, input),
    remove: (id: string) => ipcRenderer.invoke(IPC.hostsRemove, id),
    test: (input: HostInput) => ipcRenderer.invoke(IPC.hostsTest, input),
  },
  pve: {
    snapshot: (hostId: string) => ipcRenderer.invoke(IPC.pveSnapshot, hostId),
    vmDetail: (hostId: string, node: string, type: VmType, vmid: number) =>
      ipcRenderer.invoke(IPC.pveVmDetail, hostId, node, type, vmid),
    vmAction: (hostId: string, node: string, type: VmType, vmid: number, action: VmAction) =>
      ipcRenderer.invoke(IPC.pveVmAction, hostId, node, type, vmid, action),
    snapshotCreate: (hostId: string, node: string, type: VmType, vmid: number, name: string, description?: string) =>
      ipcRenderer.invoke(IPC.pveSnapshotCreate, hostId, node, type, vmid, name, description),
    snapshotRollback: (hostId: string, node: string, type: VmType, vmid: number, name: string) =>
      ipcRenderer.invoke(IPC.pveSnapshotRollback, hostId, node, type, vmid, name),
    snapshotDelete: (hostId: string, node: string, type: VmType, vmid: number, name: string) =>
      ipcRenderer.invoke(IPC.pveSnapshotDelete, hostId, node, type, vmid, name),
    taskLog: (hostId: string, node: string, upid: string) => ipcRenderer.invoke(IPC.pveTaskLog, hostId, node, upid),
    nodeRrd: (hostId: string, node: string, timeframe: "hour" | "day" | "week") =>
      ipcRenderer.invoke(IPC.pveNodeRrd, hostId, node, timeframe),
  },
  backups: {
    archives: (hostId: string) => ipcRenderer.invoke(IPC.backupArchives, hostId),
    run: (hostId: string, req: BackupRunRequest) => ipcRenderer.invoke(IPC.backupRun, hostId, req),
    restore: (hostId: string, req: RestoreRequest) => ipcRenderer.invoke(IPC.backupRestore, hostId, req),
    removeArchive: (hostId: string, node: string, storage: string, volid: string) =>
      ipcRenderer.invoke(IPC.backupRemove, hostId, node, storage, volid),
    saveSchedule: (hostId: string, input: ScheduleInput) => ipcRenderer.invoke(IPC.backupScheduleSave, hostId, input),
    deleteSchedule: (hostId: string, id: string) => ipcRenderer.invoke(IPC.backupScheduleDelete, hostId, id),
  },
  pipelines: {
    list: () => ipcRenderer.invoke(IPC.pipelineList),
    runs: () => ipcRenderer.invoke(IPC.pipelineRuns),
    run: (pipelineId: string, hostId: string, vars?: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.pipelineRun, pipelineId, hostId, vars),
    approve: (runId: string, approved: boolean) => ipcRenderer.invoke(IPC.pipelineApprove, runId, approved),
    cancel: (runId: string) => ipcRenderer.invoke(IPC.pipelineCancel, runId),
    onRun: (handler) => {
      const listener = (_event: unknown, payload: NexusEvent) => {
        if (payload.type === "pipeline" && payload.run) handler(payload.run);
      };
      ipcRenderer.on(IPC.event, listener);
      return () => ipcRenderer.removeListener(IPC.event, listener);
    },
  },
  ssh: {
    hosts: () => ipcRenderer.invoke(IPC.sshHostsList),
    save: (input: SshHostInput) => ipcRenderer.invoke(IPC.sshHostsSave, input),
    remove: (id: string) => ipcRenderer.invoke(IPC.sshHostsRemove, id),
    test: (input: SshHostInput) => ipcRenderer.invoke(IPC.sshHostsTest, input),
    snapshot: (hostId: string) => ipcRenderer.invoke(IPC.sshSnapshot, hostId),
    health: () => ipcRenderer.invoke(IPC.sshHealth),
    exec: (hostId: string, command: string, options?: { shell?: boolean; timeoutMs?: number }) =>
      ipcRenderer.invoke(IPC.sshExec, hostId, command, options),
    speedtest: (hostId: string) => ipcRenderer.invoke(IPC.sshSpeedtest, hostId),
    speedtestAll: () => ipcRenderer.invoke(IPC.sshSpeedtestAll),
    action: (hostId: string, action: SshAction, target?: string) => ipcRenderer.invoke(IPC.sshAction, hostId, action, target),
    helper: (hostId: string) => ipcRenderer.invoke(IPC.sshHelper, hostId),
    installHelper: (hostId: string, sudoPassword?: string) => ipcRenderer.invoke(IPC.sshHelperInstall, hostId, sudoPassword),
  },
  security: {
    overview: () => ipcRenderer.invoke(IPC.securityOverview),
    scan: (hostId: string) => ipcRenderer.invoke(IPC.securityScan, hostId),
    enforce: (hostId: string, action: string, options?: { confirm?: boolean }) =>
      ipcRenderer.invoke(IPC.securityEnforce, hostId, action, options),
    policy: (patch) => ipcRenderer.invoke(IPC.securityPolicy, patch),
    journal: (limit?: number) => ipcRenderer.invoke(IPC.securityJournal, limit),
    acceptBaseline: (hostId: string) => ipcRenderer.invoke(IPC.securityAcceptBaseline, hostId),
    verify: () => ipcRenderer.invoke(IPC.securityVerify),
    resident: (hostId: string, enable: boolean) => ipcRenderer.invoke(IPC.securityResident, hostId, enable),
    ban: (hostId: string, ip: string) => ipcRenderer.invoke(IPC.securityBan, hostId, ip),
    bans: (hostId: string) => ipcRenderer.invoke(IPC.securityBans, hostId),
    onScan: (handler) => {
      const listener = (_event: unknown, payload: NexusEvent) => {
        if (payload.type === "security" && payload.scan) handler(payload.scan);
      };
      ipcRenderer.on(IPC.event, listener);
      return () => ipcRenderer.removeListener(IPC.event, listener);
    },
  },
  ddos: {
    overview: () => ipcRenderer.invoke(IPC.ddosOverview),
    status: (hostId: string) => ipcRenderer.invoke(IPC.ddosStatus, hostId),
    install: (hostId: string) => ipcRenderer.invoke(IPC.ddosInstall, hostId),
    setMode: (hostId: string, mode: DdosMode) => ipcRenderer.invoke(IPC.ddosMode, hostId, mode),
    ban: (hostId: string, ip: string, seconds?: number, reason?: string) =>
      ipcRenderer.invoke(IPC.ddosBan, hostId, ip, seconds, reason),
    unban: (hostId: string, ip: string) => ipcRenderer.invoke(IPC.ddosUnban, hostId, ip),
    allow: (hostId: string, ip: string, add: boolean) => ipcRenderer.invoke(IPC.ddosAllow, hostId, ip, add),
    apply: (hostId: string, patch: Partial<DdosConfig>) => ipcRenderer.invoke(IPC.ddosApply, hostId, patch),
    journal: (limit?: number) => ipcRenderer.invoke(IPC.ddosJournal, limit),
  },
  relay: {
    overview: () => ipcRenderer.invoke(IPC.relayOverview),
    save: (input) => ipcRenderer.invoke(IPC.relaySave, input),
    probe: () => ipcRenderer.invoke(IPC.relayProbe),
    deploy: () => ipcRenderer.invoke(IPC.relayDeploy),
    remove: () => ipcRenderer.invoke(IPC.relayRemove),
  },
  vnc: {
    preflight: (hostId: string) => ipcRenderer.invoke(IPC.vncPreflight, hostId),
    setup: (hostId: string, sudoPassword?: string) => ipcRenderer.invoke(IPC.vncSetup, hostId, sudoPassword),
    open: (hostId: string, port?: number) => ipcRenderer.invoke(IPC.vncOpen, hostId, port),
    close: (sessionId: string) => ipcRenderer.invoke(IPC.vncClose, sessionId),
  },
  praetor: {
    overview: () => ipcRenderer.invoke(IPC.praetorOverview),
    install: (hostId: string) => ipcRenderer.invoke(IPC.praetorInstall, hostId),
  },
  mcp: {
    status: () => ipcRenderer.invoke(IPC.mcpStatus),
    writeConfig: (target) => ipcRenderer.invoke(IPC.mcpWriteConfig, target),
  },
  onEvent: (handler: (event: NexusEvent) => void) => {
    const listener = (_event: unknown, payload: NexusEvent) => handler(payload);
    ipcRenderer.on(IPC.event, listener);
    return () => ipcRenderer.removeListener(IPC.event, listener);
  },
};

contextBridge.exposeInMainWorld("nexus", bridge);
