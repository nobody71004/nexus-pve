// Shared contract for every Nexus PVE process: Electron main, preload, renderer and the MCP server.

import type { DdosConfig, DdosIncident, DdosInstallResult, DdosMode, DdosOverview, DdosStatus } from "./ddos-types";
import type {
  RelayChain,
  RelayChainInput,
  RelayDeployResult,
  RelayOverview,
  RelayRemoveResult,
  VncPreflight,
  VncSession,
} from "./fabric-types";
import type {
  TeamAuthState,
  TeamBootstrapInput,
  TeamLoginInput,
  TeamOverview,
  TeamUser,
  TeamUserInput,
  TeamUserPatch,
} from "./team-types";
import type {
  TeamAuditExportResult,
  TeamAuditFilter,
  TeamAuditResult,
  TeamSyncConfigInput,
  TeamSyncRunResult,
  TeamSyncStatus,
} from "./team-sync";

export type {
  RelayChain,
  RelayChainInput,
  RelayDeployOutput,
  RelayDeployResult,
  RelayHealth,
  RelayHost,
  RelayNodeConfig,
  RelayNodeStatus,
  RelayOverview,
  RelayPlan,
  RelayPlanHop,
  RelayRemoveResult,
  RelayRole,
  RelayTransport,
  VncPreflight,
  VncSession,
} from "./fabric-types";

export type {
  DdosConfig,
  DdosDropStats,
  DdosEvent,
  DdosForward,
  DdosIncident,
  DdosInstallResult,
  DdosLimits,
  DdosMode,
  DdosOverview,
  DdosPortRange,
  DdosProtocol,
  DdosSource,
  DdosStatus,
} from "./ddos-types";

export type {
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
} from "./team-types";

export type {
  TeamAuditExportResult,
  TeamAuditFilter,
  TeamAuditResult,
  TeamAuditTarget,
  TeamSyncConfigInput,
  TeamSyncMachine,
  TeamSyncPhase,
  TeamSyncRemoteState,
  TeamSyncRunResult,
  TeamSyncSnapshot,
  TeamSyncStatus,
  TeamSyncUser,
  TeamSyncUserTombstone,
} from "./team-sync";

export type VmType = "qemu" | "lxc";
export type HostHealth = "online" | "degraded" | "offline" | "connecting";
export type AuthMode = "token" | "password";
export type TaskState = "running" | "ok" | "error" | "unknown";

export interface HostInput {
  id?: string;
  label: string;
  /** https://host:8006 — the API base is appended by the client. */
  baseUrl: string;
  authMode: AuthMode;
  /** user@realm!tokenname for token auth. */
  tokenId?: string;
  /** user@realm for password auth. */
  username?: string;
  tlsVerify: boolean;
  /** Token secret or password. Never returned to the renderer. */
  secret?: string;
  color?: string;
}

export interface HostSummary {
  id: string;
  label: string;
  baseUrl: string;
  authMode: AuthMode;
  tokenId?: string;
  username?: string;
  tlsVerify: boolean;
  color: string;
  hasSecret: boolean;
  createdAt: number;
  lastSeenAt?: number;
}

export interface HostRuntimeStatus {
  id: string;
  health: HostHealth;
  latencyMs?: number;
  version?: string;
  clusterName?: string;
  nodeCount?: number;
  vmCount?: number;
  error?: string;
  checkedAt?: number;
}

export interface HostTestResult {
  ok: boolean;
  latencyMs: number;
  version?: string;
  clusterName?: string;
  release?: string;
  nodes?: string[];
  error?: string;
  tlsFingerprint?: string;
}

export interface RrdPoint {
  t: number;
  cpu: number;
  mem: number;
  netin: number;
  netout: number;
  load: number;
  iowait: number;
}

export interface DiskInfo {
  dev: string;
  model: string;
  serial: string;
  size: number;
  health: string;
  type: string;
  used?: string;
  wearout?: number;
}

export interface StorageInfo {
  storage: string;
  type: string;
  content: string[];
  active: boolean;
  total: number;
  used: number;
  avail: number;
  shared: boolean;
}

export interface NicInfo {
  iface: string;
  type: string;
  active: boolean;
  address?: string;
  cidr?: string;
  gateway?: string;
  speed?: string;
}

export interface SensorReading {
  name: string;
  value: number;
  unit: string;
}

export interface NodeStats {
  node: string;
  status: string;
  uptime: number;
  cpu: number;
  cores: number;
  sockets: number;
  mhz: number;
  model: string;
  kernel: string;
  pveVersion: string;
  memory: { used: number; total: number; free: number };
  swap: { used: number; total: number; free: number };
  rootfs: { used: number; total: number; free: number };
  loadavg: number[];
  ksm: { shared: number; sharing: number };
  storages: StorageInfo[];
  disks: DiskInfo[];
  network: NicInfo[];
  sensors: SensorReading[];
  rrd: RrdPoint[];
  vmCount: number;
  runningCount: number;
  latencyMs: number;
}

export interface VmSummary {
  key: string;
  vmid: number;
  name: string;
  type: VmType;
  node: string;
  status: "running" | "stopped" | "paused" | "unknown";
  cpu: number;
  cpus: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  netin: number;
  netout: number;
  diskread: number;
  diskwrite: number;
  tags: string[];
  template: boolean;
  lock?: string;
  pool?: string;
  haState?: string;
}

export interface AgentIp {
  address: string;
  family: "ipv4" | "ipv6";
}

export interface AgentNic {
  name: string;
  mac: string;
  ips: AgentIp[];
}

export interface Snapshot {
  name: string;
  description?: string;
  snaptime?: number;
  parent?: string;
  current: boolean;
}

export interface TaskSummary {
  upid: string;
  node: string;
  type: string;
  id: string;
  user: string;
  state: TaskState;
  starttime: number;
  endtime?: number;
  exitstatus?: string;
  progress?: number;
}

export interface VmDetail extends VmSummary {
  config: Record<string, string | number>;
  agentNetworks: AgentNic[];
  agentAvailable: boolean;
  snapshots: Snapshot[];
  tasks: TaskSummary[];
}

export interface ClusterBackupJob {
  id: string;
  enabled: boolean;
  schedule: string;
  storage: string;
  mode: string;
  compress: string;
  node?: string;
  vmid?: string;
  all?: boolean;
  comment?: string;
  nextRun?: number;
}

export interface BackupArchive {
  volid: string;
  storage: string;
  node?: string;
  vmid?: number;
  ctime?: number;
  size?: number;
  format?: string;
  protected: boolean;
  notes?: string;
}

export interface FleetSnapshot {
  host: HostSummary;
  status: HostRuntimeStatus;
  version?: string;
  release?: string;
  clusterName?: string;
  nodes: NodeStats[];
  vms: VmSummary[];
  tasks: TaskSummary[];
  schedules: ClusterBackupJob[];
  fetchedAt: number;
  errors: string[];
}

export interface BackupRunRequest {
  node: string;
  vmid?: number;
  storage?: string;
  mode?: "snapshot" | "suspend" | "stop";
  compress?: "0" | "zstd" | "gzip" | "lzo";
  notes?: string;
  remove?: boolean;
}

export interface BackupRunResult {
  upid: string;
  node: string;
}

export interface RestoreRequest {
  node: string;
  vmid: number;
  archive: string;
  type: VmType;
  storage?: string;
  overwrite?: boolean;
  unique?: boolean;
  start?: boolean;
}

export interface ScheduleInput {
  id?: string;
  node: string;
  vmid?: number;
  all?: boolean;
  storage: string;
  schedule: string;
  mode: "snapshot" | "suspend" | "stop";
  compress: "0" | "zstd" | "gzip" | "lzo";
  enabled: boolean;
  comment?: string;
}

export type VmAction =
  | "start"
  | "shutdown"
  | "stop"
  | "reboot"
  | "reset"
  | "suspend"
  | "resume";

/* ------------------------------------------------------------- ssh hosts */

/**
 * Plain Linux hosts are reached over the system OpenSSH client with key auth.
 * They are not Proxmox nodes — no API exists — so the console samples them with
 * a read-only shell probe instead of inventing telemetry.
 */
export type SshAuthMode = "key" | "password";

export interface SshHostInput {
  id?: string;
  label: string;
  host: string;
  port?: number;
  username: string;
  authMode?: SshAuthMode;
  /** Private key path. Empty means: let ssh use its agent and default keys. */
  keyPath?: string;
  /** Only for authMode "password"; encrypted at rest, never returned. */
  password?: string;
  color?: string;
}

export interface SshHostSummary {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authMode: SshAuthMode;
  keyPath?: string;
  hasSecret: boolean;
  color: string;
  createdAt: number;
  lastSeenAt?: number;
}

/** Fleet liveness for one host: an authenticated command, not a full probe. */
export interface SshHealth {
  id: string;
  health: HostHealth;
  latencyMs: number;
  error?: string;
}

export interface SshRuntimeStatus {
  id: string;
  health: HostHealth;
  latencyMs?: number;
  error?: string;
  checkedAt?: number;
}

export interface SshTestResult {
  ok: boolean;
  latencyMs: number;
  hostname?: string;
  os?: string;
  kernel?: string;
  cores?: number;
  error?: string;
}

export interface SshSample {
  t: number;
  cpu: number;
  mem: number;
  load1: number;
  netRx: number;
  netTx: number;
  swap?: number;
  user?: number;
  system?: number;
  iowait?: number;
  steal?: number;
  memPressure?: number;
  ioPressure?: number;
}

export interface SshPressure {
  some10: number;
  some60: number;
  some300: number;
  full10: number;
  full60: number;
  full300: number;
}

export interface SpeedTestResult {
  hostId: string;
  label: string;
  at: number;
  downMbps: number;
  upMbps: number;
  latencyMs: number;
  bytes: number;
  error?: string;
  /** Physical link rate reported by the NIC (ethtool), in Mbps. */
  linkMbps?: number;
  /** Interface the probe egressed through. */
  device?: string;
  /** Measurement endpoint, so a slow provider can be told apart from a slow host. */
  endpoint?: string;
  /** Concurrent download streams used for the aggregate. */
  streams?: number;
  /** Connect-time spread across the latency samples. */
  jitterMs?: number;
  /** Streams that aborted or returned nothing; a non-zero value means the number is a floor. */
  cutStreams?: number;
  /** Duration of the longest download stream. */
  windowMs?: number;
}

export interface SshDisk {
  fs: string;
  mount: string;
  size: number;
  used: number;
  avail: number;
}

export interface SshNic {
  name: string;
  rx: number;
  tx: number;
}

export interface SshBlockDevice {
  name: string;
  model: string;
  size: number;
  rotational: boolean;
}

export interface SshService {
  name: string;
  state: "running" | "failed";
}

export interface SshContainer {
  name: string;
  image: string;
  status: string;
}

export interface SshProcess {
  command: string;
  cpu: number;
  mem: number;
  rss: number;
}

export interface SshSecurity {
  /** Failed SSH password attempts seen in the last 24h, when readable. */
  failedLogins?: number;
  firewall?: string;
  passwordAuth?: string;
  permitRootLogin?: string;
}

export interface SshExecResult {
  host: string;
  ok: boolean;
  code: number | null;
  latencyMs: number;
  stdout: string;
  stderr: string;
}

export type SshAction = "reboot" | "shutdown" | "restart-service" | "stop-service" | "start-service" | "backup";

export interface SshActionResult {
  host: string;
  action: SshAction;
  target?: string;
  ok: boolean;
  output: string;
}

/**
 * Readiness of the privileged helper (/usr/local/sbin/nexus-priv) on one host.
 * ready    — helper and sudoers drop-in match this build and sudo runs it
 * missing  — nothing installed, but a route exists to install it from the app
 * partial  — only one half landed, or sudo no longer runs what is installed
 * outdated — the installed helper is a different build than this app ships
 * blocked  — no root route (key auth, no NOPASSWD grant): onboard by hand once
 */
export type HelperState = "ready" | "missing" | "partial" | "outdated" | "blocked";

/** How the app can become root on a host. */
export type HelperRoute = "root" | "nopasswd" | "password" | "none";

export interface HelperStatus {
  hostId: string;
  state: HelperState;
  route: HelperRoute;
  /** Login account the helper is granted to, as reported by the host. */
  user: string;
  uid?: number;
  helperPath: string;
  /** SHA-256 of the helper bundled with this build. */
  expectedSha: string;
  /** SHA-256 of the helper installed on the host, when readable. */
  installedSha?: string;
  files: { helper: boolean; sudoers: boolean };
  /** `sudo -n` reaches the helper, i.e. the NOPASSWD grant is live. */
  passwordless: boolean;
  detail: string;
  /** Copy-paste commands for a host the app cannot elevate on. */
  bootstrap?: string;
  checkedAt: number;
  latencyMs?: number;
  error?: string;
}

export interface HelperInstallResult {
  hostId: string;
  ok: boolean;
  route: HelperRoute;
  output: string;
  status?: HelperStatus;
  error?: string;
}

export interface SshSnapshot {
  host: SshHostSummary;
  status: SshRuntimeStatus;
  identity: { hostname: string; os: string; kernel: string; arch: string; uptime: number };
  cpu: {
    model: string;
    cores: number;
    load: number[];
    usage: number;
    mhz?: number;
    breakdown: { user: number; system: number; iowait: number; steal: number; idle: number };
  };
  pressure: { cpu: SshPressure; memory: SshPressure; io: SshPressure };
  memory: { total: number; available: number; used: number; swapTotal: number; swapUsed: number };
  disks: SshDisk[];
  blockDevices: SshBlockDevice[];
  nics: SshNic[];
  temps: Array<{ label: string; celsius: number }>;
  services: SshService[];
  containers: SshContainer[];
  processes: SshProcess[];
  security: SshSecurity;
  samples: SshSample[];
  fetchedAt: number;
}

export type StepApproval = "never" | "destructive" | "always";
export type StepStatus =
  | "pending"
  | "running"
  | "waiting-approval"
  | "ok"
  | "error"
  | "skipped";

export interface PipelineStepDef {
  id: string;
  title: string;
  tool: string;
  args?: Record<string, unknown>;
  approval?: StepApproval;
  /** Name of a previous step whose array result is iterated. */
  forEach?: string;
  retries?: number;
  when?: string;
  continueOnError?: boolean;
}

export interface PipelineDef {
  id: string;
  name: string;
  description: string;
  category: "health" | "backup" | "maintenance" | "incident" | "dev";
  steps: PipelineStepDef[];
  builtIn: boolean;
}

export interface PipelineStepState {
  id: string;
  title: string;
  tool: string;
  status: StepStatus;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  output?: unknown;
  error?: string;
}

export interface PipelineLogEntry {
  at: number;
  level: "info" | "warn" | "error" | "ok";
  message: string;
  stepId?: string;
}

export interface PipelineApproval {
  stepId: string;
  title: string;
  tool: string;
  args: Record<string, unknown>;
  requestedAt: number;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  name: string;
  hostId: string;
  status: "running" | "waiting-approval" | "ok" | "error" | "cancelled";
  startedAt: number;
  endedAt?: number;
  steps: PipelineStepState[];
  approval?: PipelineApproval;
  context: Record<string, unknown>;
  log: PipelineLogEntry[];
  error?: string;
}

export interface McpStatus {
  serverPath: string;
  command: string;
  args: string[];
  toolCount: number;
  configPath: string;
  hostCount: number;
}

export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  userData: string;
  configPath: string;
  mcpServerPath: string;
}

export interface NexusEvent {
  type: "snapshot" | "pipeline" | "task-log" | "toast" | "host-status" | "security" | "team-sync";
  hostId?: string;
  run?: PipelineRun;
  node?: string;
  upid?: string;
  lines?: string[];
  level?: "info" | "warn" | "error" | "ok";
  message?: string;
  status?: HostRuntimeStatus;
  scan?: SecurityScan;
  policy?: SecurityPolicy;
  journal?: SecurityJournalEntry;
  teamSync?: TeamSyncStatus;
}

export interface NexusBridge {
  app: {
    info(): Promise<AppInfo>;
    window(action: "minimize" | "maximize" | "close"): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  auth: {
    status(): Promise<TeamAuthState>;
    bootstrap(input: TeamBootstrapInput): Promise<TeamUser>;
    login(input: TeamLoginInput): Promise<TeamUser>;
    logout(): Promise<void>;
    refreshSession(): Promise<TeamAuthState>;
    changePassword(currentPassword: string, nextPassword: string): Promise<void>;
  };
  team: {
    overview(): Promise<TeamOverview>;
    createUser(input: TeamUserInput): Promise<TeamOverview>;
    updateUser(id: string, patch: TeamUserPatch): Promise<TeamOverview>;
    deleteUser(id: string): Promise<TeamOverview>;
    setMachineLinks(machineId: string, userIds: string[]): Promise<TeamOverview>;
    audit(filter?: TeamAuditFilter): Promise<TeamAuditResult>;
    exportAudit(filter?: TeamAuditFilter): Promise<TeamAuditExportResult>;
  };
  teamSync: {
    status(): Promise<TeamSyncStatus>;
    configure(input: TeamSyncConfigInput): Promise<TeamSyncRunResult>;
    now(): Promise<TeamSyncRunResult>;
    disable(): Promise<TeamSyncStatus>;
  };
  hosts: {
    list(): Promise<HostSummary[]>;
    save(input: HostInput): Promise<HostSummary>;
    remove(id: string): Promise<void>;
    test(input: HostInput): Promise<HostTestResult>;
  };
  pve: {
    snapshot(hostId: string): Promise<FleetSnapshot>;
    vmDetail(hostId: string, node: string, type: VmType, vmid: number): Promise<VmDetail>;
    vmAction(hostId: string, node: string, type: VmType, vmid: number, action: VmAction): Promise<{ upid?: string }>;
    snapshotCreate(
      hostId: string,
      node: string,
      type: VmType,
      vmid: number,
      name: string,
      description?: string,
    ): Promise<{ upid?: string }>;
    snapshotRollback(hostId: string, node: string, type: VmType, vmid: number, name: string): Promise<{ upid?: string }>;
    snapshotDelete(hostId: string, node: string, type: VmType, vmid: number, name: string): Promise<void>;
    taskLog(hostId: string, node: string, upid: string): Promise<string[]>;
    nodeRrd(hostId: string, node: string, timeframe: "hour" | "day" | "week"): Promise<RrdPoint[]>;
  };
  backups: {
    archives(hostId: string): Promise<BackupArchive[]>;
    run(hostId: string, req: BackupRunRequest): Promise<BackupRunResult>;
    restore(hostId: string, req: RestoreRequest): Promise<{ upid?: string }>;
    removeArchive(hostId: string, node: string, storage: string, volid: string): Promise<void>;
    saveSchedule(hostId: string, input: ScheduleInput): Promise<{ id: string }>;
    deleteSchedule(hostId: string, id: string): Promise<void>;
  };
  pipelines: {
    list(): Promise<PipelineDef[]>;
    runs(): Promise<PipelineRun[]>;
    run(pipelineId: string, hostId: string, vars?: Record<string, unknown>): Promise<PipelineRun>;
    approve(runId: string, approved: boolean): Promise<PipelineRun>;
    cancel(runId: string): Promise<PipelineRun>;
    onRun(handler: (run: PipelineRun) => void): () => void;
  };
  ssh: {
    hosts(): Promise<SshHostSummary[]>;
    save(input: SshHostInput): Promise<SshHostSummary>;
    remove(id: string): Promise<void>;
    test(input: SshHostInput): Promise<SshTestResult>;
    snapshot(hostId: string): Promise<SshSnapshot>;
    health(): Promise<SshHealth[]>;
    exec(hostId: string, command: string, options?: { shell?: boolean; timeoutMs?: number }): Promise<SshExecResult>;
    speedtest(hostId: string): Promise<SpeedTestResult>;
    speedtestAll(): Promise<SpeedTestResult[]>;
    action(hostId: string, action: SshAction, target?: string): Promise<SshActionResult>;
    helper(hostId: string): Promise<HelperStatus>;
    /** sudoPassword is used once for `sudo -S` and never persisted. */
    installHelper(hostId: string, sudoPassword?: string): Promise<HelperInstallResult>;
  };
  security: {
    overview(): Promise<SecurityOverview>;
    scan(hostId: string): Promise<SecurityScan>;
    enforce(hostId: string, action: string, options?: { confirm?: boolean }): Promise<SecurityScan>;
    policy(patch?: Partial<SecurityPolicy>): Promise<SecurityPolicy>;
    journal(limit?: number): Promise<SecurityJournalEntry[]>;
    acceptBaseline(hostId: string): Promise<SecurityOverview>;
    verify(): Promise<SecurityVerify>;
    resident(hostId: string, enable: boolean): Promise<SecurityResidentState>;
    ban(hostId: string, ip: string): Promise<{ ok: boolean; output: string }>;
    bans(hostId: string): Promise<string[]>;
    onScan(handler: (scan: SecurityScan) => void): () => void;
  };
  ddos: {
    overview(): Promise<DdosOverview>;
    status(hostId: string): Promise<DdosStatus>;
    install(hostId: string): Promise<DdosInstallResult>;
    setMode(hostId: string, mode: DdosMode): Promise<DdosStatus>;
    ban(hostId: string, ip: string, seconds?: number, reason?: string): Promise<DdosStatus>;
    unban(hostId: string, ip: string): Promise<DdosStatus>;
    allow(hostId: string, ip: string, add: boolean): Promise<DdosStatus>;
    apply(hostId: string, patch: Partial<DdosConfig>): Promise<DdosStatus>;
    journal(limit?: number): Promise<DdosIncident[]>;
  };
  relay: {
    overview(): Promise<RelayOverview>;
    save(input: RelayChainInput): Promise<RelayChain>;
    probe(): Promise<RelayOverview>;
    deploy(): Promise<RelayDeployResult>;
    remove(): Promise<RelayRemoveResult>;
  };
  vnc: {
    preflight(hostId: string): Promise<VncPreflight>;
    open(hostId: string, port?: number): Promise<VncSession>;
    close(sessionId: string): Promise<void>;
  };
  mcp: {
    status(): Promise<McpStatus>;
    writeConfig(target: "claude" | "cursor" | "vscode"): Promise<{ path: string }>;
  };
  onEvent(handler: (event: NexusEvent) => void): () => void;
}

declare global {
  interface Window {
    nexus?: NexusBridge;
  }
}

/* ------------------------------------------------------------------ security */

export type SecurityLayer = "access" | "network" | "patch" | "kernel" | "integrity" | "persistence";
export type SecuritySeverity = "critical" | "high" | "medium" | "low" | "info";
export type SecurityStatus = "pass" | "warn" | "fail" | "unknown";
/** observe = report only, defend = fix safe classes, lockdown = fix + contain. */
export type GuardMode = "observe" | "defend" | "lockdown";

export interface SecurityPolicy {
  enabled: boolean;
  mode: GuardMode;
  /** Seconds between autonomous scans; the scheduler never overlaps a host. */
  intervalSec: number;
  /** Apply safe remediations without asking. */
  autoRemediate: boolean;
  /** Keep a root-owned systemd timer enforcing the same fixes on the guest. */
  resident: boolean;
  /** Addresses that are never banned. The live SSH peer is always added. */
  allowlist: string[];
  /** Hard cap on new bans per scan, so one noisy hour cannot blackhole a subnet. */
  maxBansPerRun: number;
  /** Failed logins in 24h before an address is a containment candidate. */
  banThreshold: number;
  updatedAt: number;
}

export interface SecurityCheck {
  id: string;
  title: string;
  layer: SecurityLayer;
  severity: SecuritySeverity;
  status: SecurityStatus;
  detail: string;
  evidence?: string;
  /** Fixed remediation id implemented by the root helper, when one exists. */
  remediation?: string;
  /** Guarded fixes are only applied in lockdown mode or by an explicit click. */
  guarded?: boolean;
}

export interface SecurityDrift {
  key: string;
  before: string;
  after: string;
  at: number;
}

export interface SecurityAction {
  id: string;
  label: string;
  ok: boolean;
  at: number;
  output: string;
  auto: boolean;
}

export interface SecurityScan {
  hostId: string;
  label: string;
  at: number;
  durationMs: number;
  mode: GuardMode;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  checks: SecurityCheck[];
  layers: Array<{ layer: SecurityLayer; pass: number; warn: number; fail: number; score: number }>;
  drift: SecurityDrift[];
  actions: SecurityAction[];
  bans: string[];
  errors: string[];
  /** True when the guest root helper answered; without it only reads are possible. */
  privileged: boolean;
}

export interface SecurityJournalEntry {
  seq: number;
  at: number;
  hostId: string;
  label: string;
  kind: "scan" | "action" | "policy" | "contain" | "install" | "boot" | "error" | "tamper";
  message: string;
  /** Root route used by a helper install. Only set on kind "install". */
  route?: HelperRoute;
  /** Who started a helper install. Only set on kind "install". */
  trigger?: "manual" | "automatic";
  prev: string;
  hash: string;
}

export interface SecurityHostState {
  hostId: string;
  label: string;
  scan?: SecurityScan;
  nextRunAt?: number;
  running: boolean;
  lastError?: string;
}

export interface SecurityOverview {
  running: boolean;
  policy: SecurityPolicy;
  hosts: SecurityHostState[];
  chain: { ok: boolean; length: number; brokenAt?: number };
  journal: SecurityJournalEntry[];
}

export interface SecurityVerify {
  ok: boolean;
  length: number;
  brokenAt?: number;
  detail: string;
}

export interface SecurityResidentState {
  installed: boolean;
  active: boolean;
  mode?: string;
  enforce: string[];
  output: string;
}
