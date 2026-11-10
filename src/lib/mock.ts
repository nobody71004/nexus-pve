import { DEFAULT_GPU_ALERTS } from "../../shared/gpu-alerts";
import type {
  AppSettings,
  BackupArchive,
  ClusterBackupJob,
  DdosConfig,
  DdosIncident,
  DdosLimits,
  DdosMode,
  DdosOverview,
  DdosStatus,
  FleetSnapshot,
  GpuTelemetry,
  HostInput,
  HostSummary,
  HostTestResult,
  NexusBridge,
  NexusEvent,
  NodeStats,
  PipelineDef,
  PipelineRun,
  PraetorInstallResult,
  PraetorOverview,
  PraetorProfile,
  PraetorRotateResult,
  RelayChain,
  RelayChainInput,
  RelayNodeStatus,
  RelayOverview,
  RelayPlan,
  RrdPoint,
  SshHostInput,
  SshHostSummary,
  SshSample,
  SshSnapshot,
  SecurityCheck,
  SecurityJournalEntry,
  SecurityLayer,
  SecurityPolicy,
  AuthorizedSshKey,
  ManagedSshKey,
  SshKeyDeployResult,
  SshKeyEnforceResult,
  SshKeyEvent,
  SshKeyHostReport,
  SshKeyOverview,
  SshKeyPolicy,
  SecurityScan,
  SecuritySeverity,
  SecurityStatus,
  SpeedTestResult,
  SshTestResult,
  TaskSummary,
  TeamActivityEntry,
  TeamAuditExportResult,
  TeamAuditFilter,
  TeamAuditResult,
  TeamAuthState,
  TeamBootstrapInput,
  TeamLoginInput,
  TeamMachine,
  TeamOverview,
  TeamRole,
  TeamSyncStatus,
  TeamUser,
  TeamUserInput,
  TeamUserPatch,
  VmDetail,
  VmSummary,
} from "../../shared/types";

function mockSpeed(host: { label: string }, hostId: string, index: number): SpeedTestResult {
  return {
    hostId,
    label: host.label,
    at: Date.now(),
    downMbps: index === 0 ? 8311.4 : 1874.2,
    upMbps: index === 0 ? 640.8 : 412.5,
    latencyMs: 2 + index * 9,
    bytes: index === 0 ? 419_430_400 : 314_572_800,
    linkMbps: index === 0 ? 10_000 : 2_500,
    device: index === 0 ? "ens3f0np0" : "ens18",
    endpoint: "cachefly",
    streams: 5,
    jitterMs: index === 0 ? 0.4 : 3.1,
    cutStreams: index === 0 ? 1 : 0,
    windowMs: index === 0 ? 1296 : 1544,
  };
}

const HOSTS: HostSummary[] = [
  {
    id: "host-lab",
    label: "demo-lab",
    baseUrl: "https://192.0.2.10:8006",
    authMode: "token",
    tokenId: "nexus@pve!console",
    tlsVerify: false,
    color: "#38f2ff",
    hasSecret: true,
    createdAt: Date.now() - 86_400_000 * 41,
    lastSeenAt: Date.now() - 4200,
  },
  {
    id: "host-vps",
    label: "hel1-vps",
    baseUrl: "https://hel1.example.net:8006",
    authMode: "token",
    tokenId: "automation@pve!agent",
    tlsVerify: true,
    color: "#7c5cff",
    hasSecret: true,
    createdAt: Date.now() - 86_400_000 * 12,
    lastSeenAt: Date.now() - 18_000,
  },
];

const NODE_FABRIC: Record<string, { nodes: string[]; cpu: number[]; mem: number[]; disks: number[] }> = {
  "host-lab": {
    nodes: ["pve-hyperion", "pve-helios"],
    cpu: [0.34, 0.58],
    mem: [0.61, 0.43],
    disks: [0.58, 0.31],
  },
  "host-vps": { nodes: ["hel1-node01"], cpu: [0.22], mem: [0.47], disks: [0.66] },
};

const VM_FABRIC: Array<Pick<VmSummary, "name" | "node" | "type" | "status" | "tags" | "cpus"> & { vmid: number }> = [
  { vmid: 101, name: "game-master", node: "pve-hyperion", type: "lxc", status: "running", tags: ["prod", "net"], cpus: 2 },
  { vmid: 102, name: "game-node-1", node: "pve-hyperion", type: "lxc", status: "running", tags: ["prod", "game"], cpus: 4 },
  { vmid: 103, name: "game-node-2", node: "pve-hyperion", type: "lxc", status: "running", tags: ["prod", "game"], cpus: 4 },
  { vmid: 110, name: "build-runner", node: "pve-hyperion", type: "qemu", status: "running", tags: ["ci"], cpus: 8 },
  { vmid: 120, name: "hud-lab", node: "pve-helios", type: "qemu", status: "paused", tags: ["lab"], cpus: 4 },
  { vmid: 121, name: "backup-vault", node: "pve-helios", type: "qemu", status: "running", tags: ["infra"], cpus: 2 },
  { vmid: 130, name: "edge-proxy", node: "pve-helios", type: "lxc", status: "stopped", tags: ["net"], cpus: 2 },
  { vmid: 140, name: "hel1-web", node: "hel1-node01", type: "qemu", status: "running", tags: ["prod"], cpus: 4 },
];

const listeners = new Set<(event: NexusEvent) => void>();
const runs = new Map<string, PipelineRun>();
let hosts = [...HOSTS];
let mockRelayChain: RelayChain | null = null;

function emit(event: NexusEvent) {
  for (const listener of listeners) listener(event);
}

function jitter(seed: number, spread = 0.06) {
  return Math.sin(Date.now() / (11_000 + seed * 700) + seed) * spread;
}

function makeRrd(seed: number, base: number): RrdPoint[] {
  return Array.from({ length: 58 }, (_, index) => {
    const wave = Math.sin(index / 7 + seed) * 0.1 + Math.sin(index / 3 + seed * 2) * 0.035;
    return {
      t: Date.now() - (58 - index) * 60_000,
      cpu: Math.max(0.04, Math.min(0.98, base + wave + jitter(seed, 0.02))),
      mem: (base + 0.12) * 8 * 1024 ** 3,
      netin: 1.4e6 + Math.abs(Math.sin(index / 5 + seed)) * 5e6,
      netout: 2.1e6 + Math.abs(Math.cos(index / 6 + seed)) * 6e6,
      load: 0.4 + Math.abs(Math.sin(index / 8 + seed)) * 1.8,
      iowait: Math.abs(Math.sin(index / 9)) * 0.04,
    };
  });
}

function mockGpuHistory(utilization: number, temperatureC: number, phase: number) {
  const util = Array.from({ length: 60 }, (_, index) => {
    const wave = Math.sin(index / 6 + phase) * 14 + Math.cos(index / 2.7 + phase) * 5;
    return Math.round(Math.min(100, Math.max(2, utilization + wave)) * 10) / 10;
  });
  const temp = Array.from({ length: 60 }, (_, index) => {
    const wave = Math.sin(index / 7 + phase) * 3.2 + Math.cos(index / 3.4 + phase) * 1.1;
    return Math.round((temperatureC + wave) * 10) / 10;
  });
  util[util.length - 1] = utilization;
  temp[temp.length - 1] = temperatureC;
  return { utilization: util, temperatureC: temp };
}

function mockGpuTelemetry(kind: "nvidia" | "amd"): GpuTelemetry {
  if (kind === "amd") {
    return {
      id: "0000:43:00.0",
      index: 0,
      name: "AMD Radeon PRO W7900",
      vendor: "amd",
      pci: "0000:43:00.0",
      utilization: 41.2,
      memoryUtilization: 36.8,
      temperatureC: 58.4,
      hotspotC: 71.2,
      memoryTemperatureC: 62.1,
      memoryUsed: 11.8 * 1024 ** 3,
      memoryTotal: 48 * 1024 ** 3,
      powerW: 188.3,
      powerLimitW: 295,
      fanPercent: 39,
      fanRpm: 1420,
      clockMhz: 2140,
      memoryClockMhz: 1120,
      driver: "amdgpu",
      history: mockGpuHistory(41.2, 58.4, 1.7),
      source: "amdgpu-sysfs",
    };
  }
  return {
    id: "GPU-6f0c7b8e-2d7f-4a31-a9f2-demo-a4000",
    index: 0,
    name: "NVIDIA RTX A4000",
    vendor: "nvidia",
    pci: "0000:41:00.0",
    utilization: 63.4,
    memoryUtilization: 49.2,
    temperatureC: 67.2,
    hotspotC: 78.1,
    memoryUsed: 7.9 * 1024 ** 3,
    memoryTotal: 16 * 1024 ** 3,
    powerW: 93.4,
    powerLimitW: 140,
    fanPercent: 52,
    fanRpm: 1680,
    clockMhz: 1680,
    memoryClockMhz: 7001,
    pstate: "P2",
    driver: "550.54.15",
    pcieGeneration: 4,
    pcieWidth: 16,
    processes: [
      { pid: 2411, name: "python3", memoryUsed: 5.4 * 1024 ** 3 },
      { pid: 1984, name: "ffmpeg", memoryUsed: 1.2 * 1024 ** 3 },
    ],
    history: mockGpuHistory(63.4, 67.2, 0.4),
    source: "nvidia-smi",
  };
}

function makeNode(hostId: string, name: string, index: number, diskUsed: number): NodeStats {
  const fabric = NODE_FABRIC[hostId];
  const baseCpu = fabric.cpu[index] ?? 0.3;
  const baseMem = fabric.mem[index] ?? 0.5;
  const memTotal = 68 * 1024 ** 3;
  const cpu = Math.min(0.99, baseCpu + jitter(index + 1, 0.07));
  const mem = memTotal * Math.min(0.97, baseMem + jitter(index + 8, 0.02));
  return {
    node: name,
    status: "online",
    uptime: 86_400 * (hostId === "host-lab" ? 74 + index * 3 : 41),
    cpu,
    cores: hostId === "host-lab" ? 16 : 8,
    threads: hostId === "host-lab" ? 32 : 16,
    sockets: 1,
    mhz: 2904,
    model: hostId === "host-lab" ? "AMD EPYC 7302P 16-Core Processor" : "AMD Ryzen 9 3900X 12-Core",
    kernel: "6.8.12-4-pve",
    pveVersion: "8.3.2",
    memory: { used: mem, total: memTotal, free: memTotal - mem },
    swap: { used: 512 * 1024 ** 2, total: 8 * 1024 ** 3, free: 7.5 * 1024 ** 3 },
    rootfs: { used: diskUsed * 900 * 1024 ** 3, total: 900 * 1024 ** 3, free: (1 - diskUsed) * 900 * 1024 ** 3 },
    loadavg: [1.84 + jitter(index), 2.1, 2.4].map((value) => Math.round(value * 100) / 100),
    ksm: { shared: 1.2 * 1024 ** 3, sharing: 340 },
    storages: [
      {
        storage: "local-zfs",
        type: "zfspool",
        content: ["images", "rootdir"],
        active: true,
        total: 1.8 * 1024 ** 4,
        used: 1.8 * 1024 ** 4 * diskUsed,
        avail: 1.8 * 1024 ** 4 * (1 - diskUsed),
        shared: false,
      },
      {
        storage: "backup-nfs",
        type: "nfs",
        content: ["backup"],
        active: true,
        total: 4 * 1024 ** 4,
        used: 2.6 * 1024 ** 4,
        avail: 1.4 * 1024 ** 4,
        shared: true,
      },
    ],
    gpus: hostId === "host-lab"
      ? [{ name: "NVIDIA RTX A4000", vendor: "NVIDIA Corporation", device: "GA104GL [RTX A4000]", pci: "0000:41:00.0", className: "VGA compatible controller", iommuGroup: 22 }]
      : [],
    gpuTelemetry: hostId === "host-lab" && index === 0 ? [mockGpuTelemetry("nvidia")] : [],
    ...(hostId === "host-lab" && index === 0 ? { gpuTelemetryHost: "pve-hyperion" } : {}),
    disks: [
      {
        dev: "/dev/nvme0n1",
        model: "Samsung PM9A3 1.92TB",
        serial: "S6B0NX0T812345",
        size: 1.92 * 1024 ** 4,
        health: "PASSED",
        type: "nvme",
        wearout: 4,
      },
      {
        dev: "/dev/nvme1n1",
        model: "Samsung PM9A3 1.92TB",
        serial: "S6B0NX0T812346",
        size: 1.92 * 1024 ** 4,
        health: "PASSED",
        type: "nvme",
        wearout: 7,
      },
    ],
    network: [
      { iface: "vmbr0", type: "bridge", active: true, address: "192.0.2.10", cidr: "192.0.2.10/24", gateway: "192.0.2.1" },
      { iface: "eno1", type: "eth", active: true, speed: "10000" },
    ],
    sensors: [
      { name: "CPU package", value: 54 + index * 3, unit: "°C" },
      { name: "NVMe composite", value: 41, unit: "°C" },
    ],
    rrd: makeRrd(index + 1, baseCpu),
    vmCount: 5 - index,
    runningCount: 4 - index,
    latencyMs: 11 + index * 3,
  };
}

function makeVms(hostId: string): VmSummary[] {
  return VM_FABRIC.filter((vm) => NODE_FABRIC[hostId].nodes.includes(vm.node)).map((vm, index) => {
    const seed = index + 3;
    const running = vm.status === "running";
    return {
      key: `${vm.node}/${vm.type}/${vm.vmid}`,
      vmid: vm.vmid,
      name: vm.name,
      type: vm.type,
      node: vm.node,
      status: vm.status,
      cpu: running ? Math.max(0.01, Math.min(0.95, 0.18 + index * 0.08 + jitter(seed, 0.05))) : 0,
      cpus: vm.cpus,
      mem: (running ? 2.4 + index * 0.9 : 0) * 1024 ** 3,
      maxmem: 8 * 1024 ** 3,
      disk: 12 * 1024 ** 3,
      maxdisk: 64 * 1024 ** 3,
      uptime: running ? 86_400 * (2 + index) : 0,
      netin: running ? 1.8e6 + index * 9e5 : 0,
      netout: running ? 2.4e6 + index * 8e5 : 0,
      diskread: running ? 4.2e5 : 0,
      diskwrite: running ? 7.1e5 : 0,
      tags: vm.tags,
      template: false,
      pool: "fleet",
      haState: undefined,
    };
  });
}

function makeTasks(hostId: string): TaskSummary[] {
  const node = NODE_FABRIC[hostId].nodes[0];
  return [
    {
      upid: `UPID:${node}:0001F2A0:00E1C3F0:6721A3B1:vzdump:121:root@pam:`,
      node,
      type: "vzdump",
      id: "121",
      user: "root@pam",
      state: "running",
      starttime: Date.now() - 96_000,
      progress: 0.62,
    },
    {
      upid: `UPID:${node}:0001F2A0:00E1C3F0:6721A000:qmstart:140:root@pam:`,
      node,
      type: "qmstart",
      id: "140",
      user: "root@pam",
      state: "ok",
      starttime: Date.now() - 1_800_000,
      endtime: Date.now() - 1_790_000,
      exitstatus: "OK",
    },
    {
      upid: `UPID:${node}:0001F2A0:00E1C3F0:67219D00:vzdump:103:root@pam:`,
      node,
      type: "vzdump",
      id: "103",
      user: "root@pam",
      state: "error",
      starttime: Date.now() - 5_400_000,
      endtime: Date.now() - 5_100_000,
      exitstatus: "job errors",
    },
    {
      upid: `UPID:${node}:0001F2A0:00E1C3F0:67219000:pvesm:101:root@pam:`,
      node,
      type: "pvesm",
      id: "101",
      user: "root@pam",
      state: "ok",
      starttime: Date.now() - 9_000_000,
      endtime: Date.now() - 8_999_000,
      exitstatus: "OK",
    },
  ];
}

function makeSchedules(): ClusterBackupJob[] {
  return [
    {
      id: "1",
      enabled: true,
      schedule: "02:30",
      storage: "backup-nfs",
      mode: "snapshot",
      compress: "zstd",
      all: true,
      comment: "Nightly fleet protection",
      nextRun: Date.now() + 1000 * 60 * 60 * 7,
    },
    {
      id: "2",
      enabled: false,
      schedule: "sat 03:00",
      storage: "backup-nfs",
      mode: "stop",
      compress: "gzip",
      vmid: "101,102",
      node: "pve-hyperion",
      comment: "Weekly cold copies",
      nextRun: undefined,
    },
  ];
}

function makeArchives(hostId: string): BackupArchive[] {
  const node = NODE_FABRIC[hostId].nodes[0];
  return [
    { vmid: 101, name: "game-master" },
    { vmid: 102, name: "game-node-1" },
    { vmid: 110, name: "build-runner" },
    { vmid: 121, name: "backup-vault" },
    { vmid: 140, name: "hel1-web" },
  ].map((entry, index) => ({
    volid: `backup-nfs:backup/vzdump-qemu-${entry.vmid}-2026_11_0${7 - index}_02_30_00.vma.zst`,
    storage: "backup-nfs",
    node,
    vmid: entry.vmid,
    ctime: Date.now() - (index + 1) * 86_400_000,
    size: (8 + index * 2.4) * 1024 ** 3,
    format: "zst",
    protected: false,
    notes: `Nexus PVE protected-fleet pipeline · ${entry.name}`,
  }));
}

function snapshot(hostId: string): FleetSnapshot {
  const host = hosts.find((entry) => entry.id === hostId) ?? hosts[0];
  const fabric = NODE_FABRIC[host.id];
  const nodes = fabric.nodes.map((node, index) => makeNode(host.id, node, index, fabric.disks[index] ?? 0.4));
  const vms = makeVms(host.id);
  for (const node of nodes) {
    node.vmCount = vms.filter((vm) => vm.node === node.node).length;
    node.runningCount = vms.filter((vm) => vm.node === node.node && vm.status === "running").length;
  }
  return {
    host,
    status: {
      id: host.id,
      health: "online",
      latencyMs: 11 + fabric.nodes.length * 2,
      version: "8.3.2 (3f5b1d0)",
      nodeCount: nodes.length,
      vmCount: vms.length,
      checkedAt: Date.now(),
      clusterName: host.id === "host-lab" ? "demo" : undefined,
    },
    version: "8.3.2",
    release: "3f5b1d0",
    clusterName: host.id === "host-lab" ? "demo" : undefined,
    nodes,
    vms,
    tasks: makeTasks(host.id),
    schedules: makeSchedules(),
    fetchedAt: Date.now(),
    errors: [],
  };
}

const PIPELINES: PipelineDef[] = [
  {
    id: "health-sweep",
    name: "Fleet health sweep",
    description: "Pull the live fleet overview, drill into every node's hardware, then surface recent failed tasks. Read-only.",
    category: "health",
    builtIn: true,
    steps: [
      { id: "overview", title: "Fleet overview", tool: "fleet.overview" },
      { id: "nodes", title: "Node hardware detail", tool: "node.detail", forEach: "steps.overview.output.nodes" },
      { id: "failures", title: "Recent failed tasks", tool: "tasks.list" },
    ],
  },
  {
    id: "backup-fleet",
    name: "Protect the fleet",
    description: "Snapshot every running guest to the selected storage, then list the archives that now exist.",
    category: "backup",
    builtIn: true,
    steps: [
      { id: "guests", title: "Enumerate running guests", tool: "vms.list" },
      { id: "backup", title: "Back up each guest", tool: "backup.run", approval: "always" },
      { id: "archives", title: "Verify archives exist", tool: "backup.list" },
    ],
  },
  {
    id: "rolling-reboot",
    name: "Rolling reboot",
    description: "Gracefully shut down each guest one at a time, pause, boot it again, and pause before the next.",
    category: "maintenance",
    builtIn: true,
    steps: [
      { id: "guests", title: "Enumerate guests", tool: "vms.list" },
      { id: "shutdown", title: "Graceful shutdown", tool: "vm.action", approval: "destructive" },
      { id: "settle", title: "Wait for shutdown", tool: "util.sleep" },
      { id: "start", title: "Start again", tool: "vm.action" },
    ],
  },
  {
    id: "incident-capture",
    name: "Incident capture",
    description: "Write a full evidence bundle (hardware, inventory, configs) and pull logs for every failed task.",
    category: "incident",
    builtIn: true,
    steps: [
      { id: "bundle", title: "Capture evidence bundle", tool: "incident.bundle" },
      { id: "failed", title: "Find failed tasks", tool: "tasks.list" },
      { id: "logs", title: "Read failure logs", tool: "task.log" },
    ],
  },
  {
    id: "dev-release",
    name: "Agent dev release gate",
    description: "Typecheck the app, build it, then run the end-to-end mock/MCP smoke suite.",
    category: "dev",
    builtIn: true,
    steps: [
      { id: "typecheck", title: "Typecheck", tool: "dev.typecheck" },
      { id: "build", title: "Production build", tool: "dev.build" },
      { id: "smoke", title: "E2E smoke suite", tool: "dev.smoke" },
    ],
  },
  {
    id: "console-sweep",
    name: "Console readiness sweep",
    description: "Enumerate every Linux host and Proxmox node, then probe each VNC console through its mapped SSH transport. Read-only.",
    category: "health",
    builtIn: true,
    steps: [
      { id: "machines", title: "Enumerate Linux and Proxmox machines", tool: "machines.list" },
      { id: "preflight", title: "Probe VNC console", tool: "machines.vnc.preflight" },
    ],
  },
  {
    id: "fleet-command",
    name: "Run a command across the fleet",
    description: "Run one command over SSH on every mapped Linux host and Proxmox node. The operator approves the command step before anything executes.",
    category: "maintenance",
    builtIn: true,
    steps: [
      { id: "machines", title: "Enumerate mapped machines", tool: "machines.list" },
      { id: "command", title: "Run command on each machine", tool: "machines.exec", approval: "always" },
    ],
  },
];

let runCounter = 0;

function simulateRun(pipeline: PipelineDef, hostId: string): PipelineRun {
  runCounter += 1;
  const run: PipelineRun = {
    id: `run-${Date.now()}-${runCounter}`,
    pipelineId: pipeline.id,
    name: pipeline.name,
    hostId,
    status: "running",
    startedAt: Date.now(),
    steps: pipeline.steps.map((step) => ({
      id: step.id,
      title: step.title,
      tool: step.tool,
      status: "pending",
      attempts: 0,
    })),
    context: { hostId },
    log: [{ at: Date.now(), level: "info", message: `Run started on ${hosts.find((h) => h.id === hostId)?.label ?? "host"}` }],
  };
  runs.set(run.id, run);

  const advance = () => {
    if (run.status !== "running") return;
    const next = run.steps.find((step) => step.status === "pending");
    if (!next) {
      run.status = "ok";
      run.endedAt = Date.now();
      run.log.push({ at: Date.now(), level: "ok", message: "Run completed" });
      emit({ type: "pipeline", run: structuredClone(run), hostId });
      return;
    }
    const def = pipeline.steps.find((step) => step.id === next.id);
    const previous = run.steps[run.steps.indexOf(next) - 1];
    if (previous && previous.status === "running") {
      previous.status = "ok";
      previous.endedAt = Date.now();
      run.log.push({ at: Date.now(), level: "ok", message: `${previous.title} finished`, stepId: previous.id });
    }
    if (def?.approval && def.approval !== "never") {
      next.status = "waiting-approval";
      run.status = "waiting-approval";
      run.approval = { stepId: next.id, title: next.title, tool: next.tool, args: {}, requestedAt: Date.now() };
      run.log.push({ at: Date.now(), level: "warn", message: `Approval required: ${next.title}`, stepId: next.id });
      emit({ type: "pipeline", run: structuredClone(run), hostId });
      return;
    }
    next.status = "running";
    next.startedAt = Date.now();
    run.log.push({ at: Date.now(), level: "info", message: `Running ${next.title}`, stepId: next.id });
    emit({ type: "pipeline", run: structuredClone(run), hostId });
    setTimeout(advance, 700);
  };
  setTimeout(advance, 450);
  emit({ type: "pipeline", run: structuredClone(run), hostId });
  return structuredClone(run);
}

function makeDetail(hostId: string, node: string, type: "qemu" | "lxc", vmid: number): VmDetail {
  const snapshotValue = snapshot(hostId);
  const vm = snapshotValue.vms.find((entry) => entry.vmid === vmid && entry.node === node && entry.type === type) ?? snapshotValue.vms[0];
  return {
    ...vm,
    config: {
      name: vm.name,
      cores: vm.cpus,
      sockets: 1,
      memory: 8192,
      ostype: "l26",
      onboot: 1,
      agent: 1,
      net0: "virtio=BC:24:11:9A:1C:04,bridge=vmbr0,firewall=1",
      scsi0: "local-zfs:base-120-disk-0,size=64G",
      boot: "order=scsi0",
    },
    agentNetworks:
      vm.type === "qemu"
        ? [
            {
              name: "lo",
              mac: "00:00:00:00:00:00",
              ips: [{ address: "127.0.0.1", family: "ipv4" }],
            },
            {
              name: "ens18",
              mac: "bc:24:11:9a:1c:04",
              ips: [{ address: `10.20.0.${(vmid % 200) + 10}`, family: "ipv4" }],
            },
          ]
        : [],
    agentAvailable: vm.type === "qemu",
    snapshots: [
      { name: "current", current: true },
      { name: "pre-upgrade-8.3", description: "Before PVE 8.3 upgrade", snaptime: Date.now() - 86_400_000 * 6, current: false },
      { name: "clean-boot", description: "Verified boot, no mods", snaptime: Date.now() - 86_400_000 * 13, current: false },
    ],
    tasks: makeTasks(hostId).filter((task) => task.id === String(vmid)),
  };
}

let archiveState: Record<string, BackupArchive[]> = {};

/** Helper readiness per host, so the one-click install is demo-able offline. */
const mockHelpers = new Map<string, "ready" | "missing">();

function mockHelperStatus(host: SshHostSummary) {
  const installed = mockHelpers.get(host.id) === "ready";
  const root = host.username === "root";
  return {
    hostId: host.id,
    state: installed ? ("ready" as const) : ("missing" as const),
    route: root ? ("root" as const) : host.authMode === "password" ? ("password" as const) : ("none" as const),
    user: host.username,
    uid: root ? 0 : 1000,
    helperPath: "/usr/local/sbin/nexus-priv",
    expectedSha: "6f99905e2f0e1b9d5d5d9b6f4b2ad8f0dbb7c1a1b2c3d4e5f60718293a4b5c6d",
    installedSha: installed ? "6f99905e2f0e1b9d5d5d9b6f4b2ad8f0dbb7c1a1b2c3d4e5f60718293a4b5c6d" : undefined,
    files: { helper: installed, sudoers: installed },
    passwordless: installed && !root,
    detail: installed
      ? "helper and sudoers drop-in installed, passwordless grant is live"
      : root
        ? "not installed — install with the root route"
        : host.authMode === "password"
          ? "not installed — install with the stored password route"
          : "no root route from this account: key auth only, no NOPASSWD grant — onboard once from a root shell",
    bootstrap:
      !installed && !root && host.authMode !== "password"
        ? [
            "# from the Nexus PVE project directory",
            `scp resources/nexus-priv.sh root@${host.host}:/tmp/nexus-priv`,
            `ssh root@${host.host} 'install -o root -g root -m 0755 /tmp/nexus-priv /usr/local/sbin/nexus-priv'`,
          ].join("\n")
        : undefined,
    checkedAt: Date.now(),
    latencyMs: 74,
  };
}

let sshHosts: SshHostSummary[] = [
  {
    id: "ssh-edge",
    label: "edge-relay",
    host: "203.0.113.10",
    port: 22,
    username: "root",
    authMode: "key",
    keyPath: "~/.ssh/edge-relay",
    hasSecret: false,
    color: "#3dffa8",
    createdAt: Date.now() - 86_400_000 * 9,
    lastSeenAt: Date.now() - 3200,
  },
  {
    id: "ssh-dedicated",
    label: "demo-dedicated",
    host: "203.0.113.20",
    port: 22,
    username: "user",
    authMode: "password",
    hasSecret: true,
    color: "#7c5cff",
    createdAt: Date.now() - 3_600_000,
    lastSeenAt: Date.now() - 12_000,
  },
];

let mockSshKeyPolicy: SshKeyPolicy = {
  enabled: true,
  intervalSec: 60,
  autoEnforce: false,
  updatedAt: Date.now() - 120_000,
};

let mockManagedSshKeys: ManagedSshKey[] = [
  {
    id: "key-ops-laptop",
    label: "ops-laptop",
    owner: "Morgan Lee",
    comment: "nexus/Morgan-Lee/ops-laptop",
    algorithm: "ssh-ed25519",
    fingerprint: "SHA256:8dG4wmLQd3z6XfP8rN2vKc1sYpB7tUaE5hJ0oR9qWxM",
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILlg7H2uPpeDzV8H2mmt/ag0j4fFE2lwfS3MQtkWPla5 nexus/Morgan-Lee/ops-laptop",
    createdAt: Date.now() - 86_400_000 * 4,
    status: "active",
    hosts: ["ssh-edge"],
    lastDeployedAt: Date.now() - 86_400_000 * 3,
  },
];

const mockSshEvents: SshKeyEvent[] = [
  { at: Date.now() - 58_000, kind: "scan", ok: true, message: "Scanned edge-relay: 1 managed, 1 trusted, 1 unmanaged", hostId: "ssh-edge", host: "edge-relay" },
  { at: Date.now() - 900_000, kind: "deploy", ok: true, message: "Deployed ops-laptop to edge-relay", hostId: "ssh-edge", host: "edge-relay" },
];

let mockSshKeyReports: Record<string, SshKeyHostReport> = {};

function mockSshKeyReport(host: SshHostSummary): SshKeyHostReport {
  const existing = mockSshKeyReports[host.id];
  if (existing) {
    existing.label = host.label;
    existing.host = host.host;
    existing.username = host.username;
    return existing;
  }
  const managed = mockManagedSshKeys.filter((key) => key.hosts.includes(host.id) && key.status === "active");
  const keys: AuthorizedSshKey[] = managed.map((key) => ({
    fingerprint: key.fingerprint,
    type: "ssh-ed25519",
    comment: key.comment,
    publicKey: key.publicKey,
    source: "managed" as const,
    keyId: key.id,
    owner: key.owner,
    firstSeenAt: key.createdAt,
  }));
  if (host.id === "ssh-edge") {
    keys.push({
      fingerprint: "SHA256:1Bq7b3vAq0m2hN8sLwErTyUiOpAsDfGhJkLzXcVbNm",
      type: "ssh-ed25519",
      comment: "riley@laptop",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBq7b3vAq0m2hN8sLwErTyUiOpAsDfGhJkLzXcVbNm riley@laptop",
      source: "trusted" as const,
      firstSeenAt: Date.now() - 86_400_000 * 12,
    });
    keys.push({
      fingerprint: "SHA256:9Zx8c7v6b5n4m3q2w1e0r9t8y7u6i5o4p3a2s1d0f",
      type: "ssh-ed25519",
      comment: "unknown@build-runner",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI9Zx8c7v6b5n4m3q2w1e0r9t8y7u6i5o4p3a2s1d0f unknown@build-runner",
      source: "unknown" as const,
      firstSeenAt: Date.now() - 3_600_000,
    });
  }
  const report: SshKeyHostReport = {
    hostId: host.id,
    label: host.label,
    host: host.host,
    username: host.username,
    path: "~/.ssh/authorized_keys",
    mode: "600",
    exists: host.id === "ssh-edge",
    scannedAt: host.id === "ssh-edge" ? Date.now() - 58_000 : 0,
    keys,
    managed: keys.filter((key) => key.source === "managed").length,
    trusted: keys.filter((key) => key.source === "trusted").length,
    unknown: keys.filter((key) => key.source === "unknown").length,
    loginFingerprint: managed[0]?.fingerprint,
  };
  mockSshKeyReports[host.id] = report;
  return report;
}

function mockSshKeyOverview(): SshKeyOverview {
  return {
    running: mockSshKeyPolicy.enabled,
    policy: mockSshKeyPolicy,
    keys: [...mockManagedSshKeys],
    hosts: sshHosts.map(mockSshKeyReport),
    events: [...mockSshEvents],
  };
}

const mockTeamNow = Date.now();
const mockAdmin: TeamUser = {
  id: "user-admin",
  username: "owner",
  displayName: "Morgan Lee",
  role: "admin",
  status: "active",
  createdAt: mockTeamNow - 86_400_000 * 90,
  updatedAt: mockTeamNow - 86_400_000 * 2,
  lastLoginAt: mockTeamNow - 120_000,
  linkedMachines: 2,
  online: true,
};
let mockUsers: TeamUser[] = [
  mockAdmin,
  {
    id: "user-mod",
    username: "riley",
    displayName: "Riley Chen",
    role: "moderator",
    status: "active",
    createdAt: mockTeamNow - 86_400_000 * 44,
    updatedAt: mockTeamNow - 3_600_000,
    lastLoginAt: mockTeamNow - 18 * 60_000,
    linkedMachines: 1,
    online: true,
  },
  {
    id: "user-ops",
    username: "sam",
    displayName: "Sam Okafor",
    role: "user",
    status: "active",
    createdAt: mockTeamNow - 86_400_000 * 12,
    updatedAt: mockTeamNow - 86_400_000,
    lastLoginAt: mockTeamNow - 86_400_000 * 2,
    linkedMachines: 1,
    online: false,
  },
];
let mockMachineLinks: Record<string, string[]> = {
  "ssh-edge": ["user-admin", "user-mod", "user-ops"],
  "ssh-dedicated": ["user-admin", "user-mod"],
};
let mockTeamActivity: TeamActivityEntry[] = [
  {
    id: "act-1",
    at: mockTeamNow - 7 * 60_000,
    actorId: "user-mod",
    actorName: "Riley Chen",
    action: "machine.links",
    targetType: "machine",
    targetId: "ssh-edge",
    targetName: "edge-relay",
    detail: "3 members linked",
  },
  {
    id: "act-2",
    at: mockTeamNow - 42 * 60_000,
    actorId: "user-admin",
    actorName: "Morgan Lee",
    action: "user.create",
    targetType: "user",
    targetId: "user-ops",
    targetName: "Sam Okafor",
    detail: "Created Member @sam",
  },
  {
    id: "act-3",
    at: mockTeamNow - 3 * 3_600_000,
    actorId: "user-admin",
    actorName: "Morgan Lee",
    action: "auth.login",
    targetType: "session",
    targetName: "Morgan Lee",
    detail: "Signed in",
  },
];

function mockTeamMachines(): TeamMachine[] {
  return sshHosts.map((host) => {
    const linkedUserIds = mockMachineLinks[host.id] ?? [];
    const linkedUsers = mockUsers
      .filter((user) => linkedUserIds.includes(user.id))
      .map(({ id, username, displayName, role }) => ({ id, username, displayName, role }));
    return {
      id: host.id,
      label: host.label,
      host: host.host,
      port: host.port,
      username: host.username,
      color: host.color,
      linkedUserIds,
      linkedUsers,
      source: "local",
      updatedAt: host.createdAt,
    };
  });
}

function mockTeamOverview(): TeamOverview {
  const machines = mockTeamMachines();
  const online = mockUsers.filter((user) => user.online || user.id === "user-admin").length;
  return {
    workspaceName: "Nexus Operations",
    database: "SQLite",
    users: mockUsers.map((user) => ({ ...user, online: user.online || user.id === "user-admin" })),
    machines,
    activity: mockTeamActivity,
    counts: {
      members: mockUsers.length,
      admins: mockUsers.filter((user) => user.role === "admin").length,
      moderators: mockUsers.filter((user) => user.role === "moderator").length,
      machines: machines.length,
      links: machines.reduce((sum, machine) => sum + machine.linkedUserIds.length, 0),
      online,
    },
    permissions: { manageUsers: true, manageRoles: true, deleteUsers: true, manageLinks: true, manageMachines: true },
  };
}

function mockRole(value: TeamRole | undefined): TeamRole {
  return value === "admin" || value === "moderator" ? value : "user";
}

function makeSshSnapshot(host: SshHostSummary): SshSnapshot {
  const seed = host.id.length % 7;
  const cpu = 18 + Math.abs(jitter(seed, 0.4)) * 60;
  const memTotal = 4 * 1024 ** 3;
  const memUsed = memTotal * (0.38 + Math.abs(jitter(seed + 1, 0.2)));
  const samples: SshSample[] = Array.from({ length: 46 }, (_, index) => ({
    t: Date.now() - (46 - index) * 8000,
    cpu: Math.max(2, cpu + Math.sin(index / 3 + seed) * 9),
    mem: (memUsed / memTotal) * 100,
    load1: 0.4 + Math.abs(Math.sin(index / 5)) * 1.6,
    netRx: 40_000 + Math.abs(Math.sin(index / 4)) * 900_000,
    netTx: 22_000 + Math.abs(Math.cos(index / 5)) * 400_000,
  }));
  return {
    host,
    status: { id: host.id, health: "online", latencyMs: 68, checkedAt: Date.now() },
    identity: {
      hostname: host.id === "ssh-edge" ? "edge.example.net" : "ubuntu24",
      os: "Ubuntu 24.04.5 LTS",
      kernel: "6.17.0-35-generic",
      arch: "x86_64",
      uptime: 812_400,
    },
    cpu: {
      model: host.id === "ssh-edge" ? "AMD EPYC-Genoa Processor" : "Intel Xeon E5-2699 v3",
      cores: host.id === "ssh-edge" ? 2 : 32,
      physicalCores: host.id === "ssh-edge" ? 2 : 16,
      sockets: host.id === "ssh-edge" ? 1 : 2,
      load: [0.62, 0.48, 0.4],
      usage: cpu,
      mhz: 2900,
      breakdown: { user: cpu * 0.62, system: cpu * 0.24, iowait: cpu * 0.08, steal: cpu * 0.02, idle: 100 - cpu },
    },
    pressure: {
      cpu: { some10: 1.2, some60: 0.9, some300: 0.4, full10: 0, full60: 0, full300: 0 },
      memory: { some10: 2.4, some60: 1.8, some300: 0.7, full10: 0.4, full60: 0.2, full300: 0.05 },
      io: { some10: 0.6, some60: 0.4, some300: 0.2, full10: 0.1, full60: 0.05, full300: 0 },
    },
    memory: { total: memTotal, available: memTotal - memUsed, used: memUsed, swapTotal: 2 * 1024 ** 3, swapUsed: 0 },
    disks: [
      { fs: "/dev/vda1", mount: "/", size: 78 * 1024 ** 3, used: 41 * 1024 ** 3, avail: 33 * 1024 ** 3 },
      { fs: "/dev/vda15", mount: "/boot/efi", size: 106 * 1024 ** 2, used: 6 * 1024 ** 2, avail: 100 * 1024 ** 2 },
    ],
    blockDevices: [
      { name: "vda", model: "QEMU HARDDISK", size: 80 * 1024 ** 3, rotational: false, type: "disk", serial: "QM00001" },
    ],
    nics: [
      { name: "ens18", rx: 8_412_882_112, tx: 2_112_882_112, speedMbps: 10_000, state: "up", mac: "52:54:00:8e:21:4c", mtu: 1500 },
      { name: "wg0", rx: 1_212_882_112, tx: 812_882_112, speedMbps: undefined, state: "up", mac: "00:00:00:00:00:00", mtu: 1420 },
    ],
    temps: [{ label: "x86_pkg_temp", celsius: 41.5 }],
    gpus: host.id === "ssh-edge" ? [mockGpuTelemetry("nvidia")] : host.id === "ssh-dedicated" ? [mockGpuTelemetry("amd")] : [],
    services: [
      { name: "ssh.service", state: "running" },
      { name: "nginx.service", state: "running" },
      { name: "wg-quick@wg0.service", state: "running" },
      { name: "certbot.timer", state: "running" },
      { name: "apt-daily.service", state: "failed" },
    ],
    containers: [],
    processes: [
      { command: "node", cpu: 12.4, mem: 3.1, rss: 128 * 1024 ** 2 },
      { command: "nginx", cpu: 2.1, mem: 0.6, rss: 42 * 1024 ** 2 },
      { command: "sshd", cpu: 0.4, mem: 0.2, rss: 12 * 1024 ** 2 },
    ],
    security: { failedLogins: 37, firewall: "Status: active", passwordAuth: "PasswordAuthentication no", permitRootLogin: "PermitRootLogin prohibit-password" },
    samples,
    fetchedAt: Date.now(),
  };
}


/* ------------------------------------------------------------------ security */

let mockGuardPolicy: SecurityPolicy = {
  enabled: true,
  mode: "defend",
  intervalSec: 300,
  autoRemediate: true,
  resident: false,
  allowlist: [],
  maxBansPerRun: 3,
  banThreshold: 20,
  updatedAt: Date.now() - 3_600_000,
};

function mockChecks(): SecurityCheck[] {
  const base: Array<[string, SecurityLayer, SecuritySeverity, SecurityStatus, string, string, string?]> = [
    ["ssh.root-login", "access", "high", "pass", "Root SSH login", "restricted (prohibit-password)"],
    ["ssh.password-auth", "access", "high", "pass", "SSH password authentication", "disabled (keys only)"],
    ["ssh.empty-passwords", "access", "critical", "pass", "Empty passwords", "no account has an empty password"],
    ["sudo.nopasswd-wide", "access", "critical", "pass", "Passwordless sudo breadth", "only the narrow guard helper is passwordless"],
    ["accounts.uid0", "access", "critical", "pass", "Extra root accounts", "root is the only uid 0 account"],
    ["auth.bruteforce", "access", "high", "fail", "SSH brute force", "612 failed logins in 24h — active attack"],
    ["auth.root-sessions", "access", "medium", "pass", "Root sessions", "no root logins in 24h"],
    ["net.firewall", "network", "high", "pass", "Host firewall", "ufw is active"],
    ["net.fail2ban", "network", "medium", "warn", "Intrusion prevention", "fail2ban is not active — repeated SSH guesses are not throttled", "fail2ban-baseline"],
    ["net.exposed-services", "network", "high", "pass", "Exposed admin services", "no database or container port is bound publicly"],
    ["patch.pending", "patch", "medium", "warn", "Pending updates", "34 package updates pending"],
    ["patch.unattended", "patch", "high", "pass", "Automatic security updates", "unattended-upgrades is enabled"],
    ["patch.reboot", "patch", "low", "pass", "Reboot required", "no pending reboot"],
    ["kernel.sysctl", "kernel", "medium", "warn", "Kernel hardening", "2 of 13 sysctl protections are off", "sysctl-hardening"],
    ["integrity.key-perms", "integrity", "high", "pass", "SSH key permissions", "1 authorized_keys file is 600"],
    ["integrity.world-writable", "integrity", "high", "pass", "World-writable config", "no world-writable files under /etc"],
    ["integrity.authorized-keys", "integrity", "critical", "pass", "Authorized keys changed", "authorized_keys matches the baseline"],
    ["persist.cron", "persistence", "high", "pass", "Scheduled job review", "no cron entry downloads or decodes anything"],
    ["persist.rc-local", "persistence", "medium", "pass", "Legacy boot hook", "no executable rc.local"],
    ["guard.helper", "access", "high", "pass", "Root helper", "narrow nexus-priv helper is installed and answering"],
    ["guard.resident", "persistence", "medium", "warn", "Resident enforcer", "session-only — protection pauses when the app closes"],
  ];
  return base.map(([id, layer, severity, status, title, detail, remediation]) => ({
    id,
    layer,
    severity,
    status,
    title,
    detail,
    remediation,
  }));
}

function mockScan(hostId: string, label: string): SecurityScan {
  const checks = mockChecks();
  const score = scoreOf(checks);
  return {
    hostId,
    label,
    at: Date.now(),
    durationMs: 1840,
    mode: mockGuardPolicy.mode,
    score,
    grade: score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F",
    checks,
    layers: layersOfChecks(checks),
    drift: [],
    actions: [],
    bans: [],
    errors: [],
    privileged: true,
  };
}

function scoreOf(checks: SecurityCheck[]): number {
  const weight: Record<SecuritySeverity, number> = { critical: 30, high: 18, medium: 8, low: 3, info: 0 };
  let penalty = 0;
  for (const check of checks) {
    if (check.status === "fail") penalty += weight[check.severity];
    else if (check.status === "warn") penalty += Math.ceil(weight[check.severity] / 2);
  }
  return Math.max(0, 100 - penalty);
}

function layersOfChecks(checks: SecurityCheck[]): SecurityScan["layers"] {
  return (["access", "network", "patch", "kernel", "integrity", "persistence"] as SecurityLayer[]).map((layer) => {
    const scoped = checks.filter((check) => check.layer === layer);
    const pass = scoped.filter((check) => check.status === "pass").length;
    const warn = scoped.filter((check) => check.status === "warn").length;
    const fail = scoped.filter((check) => check.status === "fail").length;
    const total = pass + warn + fail;
    return { layer, pass, warn, fail, score: total === 0 ? 100 : Math.round((pass / total) * 100) };
  });
}

function mockJournalEntries(): SecurityJournalEntry[] {
  const seeds: Array<{
    kind: SecurityJournalEntry["kind"];
    message: string;
    hostId?: string;
    label?: string;
    route?: SecurityJournalEntry["route"];
    trigger?: SecurityJournalEntry["trigger"];
  }> = [
    { kind: "boot", message: "security guardian online v1.0.0" },
    { kind: "scan", message: "C 71/100 · 1 fail · 4 warn · 0 fixed · 0 banned" },
    { kind: "action", message: "auto sysctl-hardening: ok — sysctl=applied" },
    { kind: "policy", message: "policy updated: mode=\"defend\"" },
    { kind: "contain", message: "banned 203.0.113.42 for 24h" },
    {
      kind: "install",
      message: "helper install (automatic, route root): outdated → ready, ok",
      hostId: "ssh-edge",
      label: "edge-relay",
      route: "root",
      trigger: "automatic",
    },
    {
      kind: "install",
      message: "helper install (manual, route password): missing → ready, ok",
      hostId: "ssh-dedicated",
      label: "demo-dedicated",
      route: "password",
      trigger: "manual",
    },
    {
      kind: "install",
      message: "helper install (automatic, route password): outdated → outdated, failed — sudo_password=rejected",
      hostId: "ssh-dedicated",
      label: "demo-dedicated",
      route: "password",
      trigger: "automatic",
    },
  ];
  return seeds.map((seed, index) => ({
    seq: index + 1,
    at: Date.now() - (seeds.length - index) * 240_000,
    hostId: seed.hostId ?? "ssh-ubuntu24",
    label: seed.label ?? "ubuntu24 · demo guest",
    ...seed,
    prev: index === 0 ? "genesis" : "0".repeat(64),
    hash: `${index + 1}`.padStart(64, "a"),
  }));
}

/* ------------------------------------------------------------------- ddos */

let mockDdosMode: DdosMode = "defend";
let mockDdosBlocked = ["203.0.113.42", "198.51.100.77"];
let mockDdosAllow = ["192.0.2.14"];
let mockDdosLimits: DdosLimits = {
  udpPps: 4000,
  tcpNewPerSec: 80,
  autoBanPps: 1200,
  blockSeconds: 3600,
  autoBanSamples: 3,
};
const mockDdosForwards: DdosConfig["forwards"] = [
  { id: "web-home", label: "Demo web (home origin)", proto: "tcp", ports: [{ from: 80, to: 80 }, { from: 443, to: 443 }], target: "192.0.2.20", enabled: true },
  { id: "demo-7777", label: "Demo Game 7777", proto: "udp", ports: [{ from: 7777, to: 7777 }], target: "192.0.2.20", enabled: true },
  { id: "demo-7781", label: "Demo Game 7781-7784", proto: "udp", ports: [{ from: 7781, to: 7784 }], target: "192.0.2.20", enabled: true },
  { id: "mirror-udp", label: "Screen mirror UDP", proto: "udp", ports: [{ from: 59100, to: 59103 }], target: "192.0.2.20", enabled: true },
  { id: "turn-udp", label: "TURN UDP 3478 + relay pool", proto: "udp", ports: [{ from: 3478, to: 3478 }, { from: 49152, to: 49251 }], target: "192.0.2.20", enabled: true },
  { id: "demo-game-udp", label: "Demo game fleet", proto: "udp", ports: [{ from: 11778, to: 11778 }, { from: 11830, to: 11830 }, { from: 11860, to: 11860 }], target: "192.0.2.20", enabled: true },
];

const mockDdosIncidents: DdosIncident[] = [
  { id: "ddos-1", at: Date.now() - 9 * 60_000, kind: "attack", message: "ingress spike from 203.0.113.42 (4,820 pps); limits tightened for 5 minutes" },
  { id: "ddos-2", at: Date.now() - 8 * 60_000, kind: "ban", message: "banned 203.0.113.42 on edge-relay for 3600s", detail: "auto: 4820 pps" },
  { id: "ddos-3", at: Date.now() - 42 * 60_000, kind: "mode", message: "mode set to defend on edge-relay" },
  { id: "ddos-4", at: Date.now() - 26 * 60 * 60_000, kind: "install", message: "Nexus Shield installed on edge-relay", detail: "9 forwards · edge tables adopted" },
];

function mockDdosStatus(): DdosStatus {
  return {
    hostId: "ssh-edge",
    installed: true,
    running: true,
    mode: mockDdosMode,
    tight: mockDdosMode !== "observe",
    since: Date.now() - 26 * 60 * 60_000,
    sampledAt: Date.now(),
    uptimeSec: 937_000,
    publicIp: "203.0.113.10",
    wan: "eth0",
    ingressBps: 17_400_000 + Math.abs(jitter(1, 0.2)) * 4_000_000,
    egressBps: 9_800_000,
    ingressPps: 18_400,
    egressPps: 11_200,
    conntrack: { count: 2_184, max: 1_048_576 },
    cpuPct: 6.4,
    memPct: 11.2,
    load1: 0.18,
    drops: { invalid: 412, blocked: 9_284, rate: 31_482, total: 41_178, malformed: 108, fragments: 14 },
    blocked: mockDdosBlocked,
    allowlist: mockDdosAllow,
    sources: [
      { ip: "203.0.113.42", pps: 4_820, bps: 2_112_000, connections: 184, blocked: mockDdosBlocked.includes("203.0.113.42"), allowlisted: false },
      { ip: "198.51.100.77", pps: 1_640, bps: 914_000, connections: 96, blocked: mockDdosBlocked.includes("198.51.100.77"), allowlisted: false },
      { ip: "192.0.2.19", pps: 480, bps: 212_000, connections: 41, blocked: false, allowlisted: false },
      { ip: "198.51.100.24", pps: 220, bps: 88_000, connections: 22, blocked: false, allowlisted: false },
    ],
    forwards: mockDdosForwards,
    limits: mockDdosLimits,
    autoBan: true,
    recent: mockDdosIncidents.map((entry) => ({ at: entry.at, kind: entry.kind, message: entry.message })),
    health: "online",
  };
}

function mockDdosConfig(): DdosConfig {
  return {
    mode: mockDdosMode,
    wan: "eth0",
    wireguardInterface: "wg0",
    wireguardPort: 51820,
    adminPort: 22,
    forwards: mockDdosForwards,
    limits: mockDdosLimits,
    allowlist: mockDdosAllow,
    autoBan: true,
    pollSeconds: 2,
    updatedAt: Date.now(),
  };
}

function mockDdosOverview(): DdosOverview {
  return {
    edgeHostId: "ssh-edge",
    edgeLabel: "edge-relay",
    candidates: sshHosts,
    config: mockDdosConfig(),
    status: mockDdosStatus(),
    incidents: mockDdosIncidents,
    checkedAt: Date.now(),
  };
}

function mockRelayPlan(chain: RelayChain): RelayPlan {
  return {
    chainId: chain.id,
    hops: chain.nodes.map((node, index) => {
      const role: "entry" | "relay" | "exit" = index === 0 ? "entry" : index === chain.nodes.length - 1 ? "exit" : "relay";
      return {
        index,
        hostId: node.hostId,
        label: node.label,
        role,
        publicHost: node.publicHost || node.label,
        wgAddress: `10.77.0.${index + 2}`,
        listen: role === "entry" ? `0.0.0.0:${chain.entryPort}` : `10.77.0.${index + 2}:${chain.relayPort}`,
        forwardTo: index === chain.nodes.length - 1 ? `${chain.originHost}:${chain.originPort}` : `10.77.0.${index + 3}:${chain.relayPort}`,
      };
    }),
    origin: `${chain.originHost}:${chain.originPort}`,
    transport: chain.transport,
    encryption: "WireGuard Noise IK · ChaCha20-Poly1305",
    obfuscation: chain.obfuscation === "tls" ? "Opt-in TLS camouflage on the public entry" : "None",
    warnings: [],
  };
}

let mockPraetorGeneration = 0;
const mockPraetorProfiles = new Map<string, PraetorProfile[]>();

function mockPraetorKey(): string {
  return String.fromCharCode(65 + (mockPraetorGeneration % 26)).repeat(1624);
}

function mockPraetorProfilesFor(host: SshHostSummary): PraetorProfile[] {
  const existing = mockPraetorProfiles.get(host.id);
  if (existing) return existing;
  const endpoint = `${host.host}:9443`;
  const now = new Date().toISOString();
  const profiles = ([
    ["PSEAL", "mint", true],
    ["FAST", "violet", false],
    ["BOLT", "amber", false],
    ["PMARINE", "ice", false],
  ] as const).map(([suite, color, autoConnect]) => ({
    id: `nexus-${host.id}-${suite.toLowerCase()}`,
    name: `Nexus ${host.label} ${suite}`,
    description: `Mock ${suite} PRAETOR/1 profile for ${host.label}.`,
    location: host.label,
    endpoint,
    protocol: "PRAETOR/1" as const,
    suite,
    transport: "tcp" as const,
    cellSize: 1024 as const,
    serverPublicKey: mockPraetorKey(),
    autoConnect,
    tags: ["pq", suite.toLowerCase(), "nexus"],
    color,
    createdAt: now,
    updatedAt: now,
  }));
  mockPraetorProfiles.set(host.id, profiles);
  return profiles;
}

function mockPraetorOverview(): PraetorOverview {
  return {
    hosts: sshHosts.map((host) => ({
      hostId: host.id,
      label: host.label,
      host: host.host,
      port: host.port,
      username: host.username,
      state: mockPraetorProfiles.has(host.id) ? "ready" : "missing",
      detail: mockPraetorProfiles.has(host.id) ? "Egress active and TCP 9443 reachable" : "Not installed",
      endpoint: `${host.host}:9443`,
      expectedSha: "mock-praetor-bundle",
      nodeVersion: mockPraetorProfiles.has(host.id) ? "v22.11.0" : undefined,
      publicKey: mockPraetorProfiles.get(host.id)?.[0]?.serverPublicKey,
      profilesOnHost: mockPraetorProfiles.has(host.id),
      profiles: mockPraetorProfiles.has(host.id) ? mockPraetorProfilesFor(host) : [],
      tcpReachable: mockPraetorProfiles.has(host.id),
      tcpLatencyMs: mockPraetorProfiles.has(host.id) ? 12 : undefined,
      portListening: mockPraetorProfiles.has(host.id),
      bindAddress: mockPraetorProfiles.has(host.id) ? "0.0.0.0:9443" : undefined,
      firewallBlocked: false,
      firewallActive: false,
      firewallAllow: null,
      firewallDetail: mockPraetorProfiles.has(host.id) ? "Proxmox firewall is not active" : "PRAETOR is not installed",
      checkedAt: Date.now(),
      history: mockPraetorProfiles.has(host.id)
        ? Array.from({ length: 8 }, (_, index) => ({
            checkedAt: Date.now() - (7 - index) * 60_000,
            state: "ready" as const,
            tcpReachable: true,
            tcpLatencyMs: 10 + index,
            portListening: true,
            bindAddress: "0.0.0.0:9443",
            firewallBlocked: false,
            firewallActive: false,
            firewallAllow: null,
            firewallDetail: "Proxmox firewall is not active",
          }))
        : [],
    })),
    expectedSha: "mock-praetor-bundle",
    profilesPath: "%APPDATA%\\NexusPVE\\praetor\\profiles.json",
    historyPath: "%APPDATA%\\NexusPVE\\praetor\\history.json",
    checkedAt: Date.now(),
  };
}

function mockPraetorHealth(target: string) {
  const overview = mockPraetorOverview();
  const host =
    overview.hosts.find((entry) => entry.hostId === target) ??
    overview.hosts.find((entry) => entry.label.toLowerCase() === target.toLowerCase()) ??
    overview.hosts[0];
  if (!host) return null;
  return {
    hostId: host.hostId,
    label: host.label,
    endpoint: host.endpoint,
    state: host.state,
    detail: host.detail,
    tcpReachable: host.tcpReachable,
    tcpLatencyMs: host.tcpLatencyMs,
    tcpError: host.tcpError,
    firewallBlocked: host.firewallBlocked,
    checkedAt: host.checkedAt,
    history: host.history,
  };
}

function mockRelayOverview(): RelayOverview {
  const statuses: RelayNodeStatus[] = (mockRelayChain?.nodes ?? []).map((node) => ({
    hostId: node.hostId,
    health: "online",
    latencyMs: 18,
    wgActive: true,
    relayActive: true,
    peers: Math.max(0, (mockRelayChain?.nodes.length ?? 1) - 1),
    listener: true,
    checkedAt: Date.now(),
  }));
  return {
    chain: mockRelayChain,
    hosts: sshHosts.map((host) => ({
      id: host.id,
      label: host.label,
      host: host.host,
      port: host.port,
      username: host.username,
      color: host.color,
    })),
    statuses,
    plan: mockRelayChain ? mockRelayPlan(mockRelayChain) : null,
    checkedAt: Date.now(),
  };
}

export function createMockBridge(): NexusBridge {
  let mockSettings: AppSettings = {
    pollMs: 8000,
    accent: "cyan",
    reduceMotion: false,
    confirmDestructive: true,
    gpuAlerts: { ...DEFAULT_GPU_ALERTS },
  };
  const mockSyncStatus = (): TeamSyncStatus => ({
    enabled: false,
    phase: "disabled",
    workspace: "default",
    deviceName: "Nexus desktop",
    tokenSet: false,
    revision: 0,
    counts: { users: mockUsers.length, machines: sshHosts.length, activity: mockTeamActivity.length },
  });
  let syncStatus = mockSyncStatus();
  const filterAudit = (filter?: TeamAuditFilter): TeamActivityEntry[] => {
    const query = (filter?.query ?? "").trim().toLowerCase();
    const entries = mockTeamActivity.filter((entry) => {
      if (filter?.actorId && entry.actorId !== filter.actorId) return false;
      if (filter?.action && entry.action !== filter.action) return false;
      if (filter?.targetType && filter.targetType !== "all" && entry.targetType !== filter.targetType) return false;
      if (filter?.from && entry.at < filter.from) return false;
      if (filter?.to && entry.at > filter.to) return false;
      if (query && !`${entry.actorName} ${entry.action} ${entry.targetName ?? ""} ${entry.detail ?? ""}`.toLowerCase().includes(query)) return false;
      return true;
    });
    return entries.slice(0, filter?.limit ?? 250);
  };
  return {
    app: {
      info: async () => ({
        version: "1.0.0",
        electron: "33.4.11",
        node: "20.18.1",
        chrome: "130.0.6723.152",
        platform: "win32 x64",
        userData: "%APPDATA%\\NexusPVE",
        configPath: "%APPDATA%\\NexusPVE\\config.json",
        mcpServerPath: "dist-electron/mcp-server.cjs",
      }),
      window: async () => undefined,
      openExternal: async () => undefined,
    },
    settings: {
      get: async () => mockSettings,
      save: async (patch) => {
        mockSettings = {
          ...mockSettings,
          ...patch,
          gpuAlerts: { ...mockSettings.gpuAlerts, ...(patch.gpuAlerts ?? {}) },
        };
        return mockSettings;
      },
    },
    auth: {
      status: async (): Promise<TeamAuthState> => ({ initialized: true, user: mockAdmin, expiresAt: Date.now() + 12 * 60 * 60 * 1000 }),
      bootstrap: async (input: TeamBootstrapInput): Promise<TeamUser> => ({
        ...mockAdmin,
        username: input.username || mockAdmin.username,
        displayName: input.displayName || mockAdmin.displayName,
      }),
      login: async (_input: TeamLoginInput) => mockAdmin,
      logout: async () => undefined,
      refreshSession: async (): Promise<TeamAuthState> => ({ initialized: true, user: mockAdmin, expiresAt: Date.now() + 12 * 60 * 60 * 1000 }),
      changePassword: async () => undefined,
    },
    team: {
      overview: async () => mockTeamOverview(),
      createUser: async (input: TeamUserInput) => {
        const user: TeamUser = {
          id: `user-${Date.now()}`,
          username: input.username.trim().toLowerCase(),
          displayName: input.displayName.trim(),
          role: mockRole(input.role),
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          linkedMachines: 0,
          online: false,
        };
        mockUsers = [...mockUsers, user];
        mockTeamActivity = [
          { id: `act-${Date.now()}`, at: Date.now(), actorId: mockAdmin.id, actorName: mockAdmin.displayName, action: "user.create", targetType: "user", targetId: user.id, targetName: user.displayName, detail: `Created ${user.role} @${user.username}` },
          ...mockTeamActivity,
        ];
        return mockTeamOverview();
      },
      updateUser: async (id: string, patch: TeamUserPatch) => {
        mockUsers = mockUsers.map((user) =>
          user.id === id
            ? {
                ...user,
                displayName: patch.displayName?.trim() || user.displayName,
                role: patch.role ? mockRole(patch.role) : user.role,
                status: patch.status ?? user.status,
                updatedAt: Date.now(),
              }
            : user,
        );
        const target = mockUsers.find((user) => user.id === id);
        mockTeamActivity = [
          { id: `act-${Date.now()}`, at: Date.now(), actorId: mockAdmin.id, actorName: mockAdmin.displayName, action: "user.update", targetType: "user", targetId: id, targetName: target?.displayName, detail: "Profile updated" },
          ...mockTeamActivity,
        ];
        return mockTeamOverview();
      },
      deleteUser: async (id: string) => {
        const target = mockUsers.find((user) => user.id === id);
        mockUsers = mockUsers.filter((user) => user.id !== id);
        mockMachineLinks = Object.fromEntries(Object.entries(mockMachineLinks).map(([machine, ids]) => [machine, ids.filter((entry) => entry !== id)]));
        if (target) {
          mockTeamActivity = [
            { id: `act-${Date.now()}`, at: Date.now(), actorId: mockAdmin.id, actorName: mockAdmin.displayName, action: "user.delete", targetType: "user", targetId: id, targetName: target.displayName, detail: `Removed @${target.username}` },
            ...mockTeamActivity,
          ];
        }
        return mockTeamOverview();
      },
      setMachineLinks: async (machineId: string, userIds: string[]) => {
        mockMachineLinks = { ...mockMachineLinks, [machineId]: [...new Set(userIds)] };
        const machine = mockTeamMachines().find((entry) => entry.id === machineId);
        mockTeamActivity = [
          { id: `act-${Date.now()}`, at: Date.now(), actorId: mockAdmin.id, actorName: mockAdmin.displayName, action: "machine.links", targetType: "machine", targetId: machineId, targetName: machine?.label, detail: `${userIds.length} member${userIds.length === 1 ? "" : "s"} linked` },
          ...mockTeamActivity,
        ];
        return mockTeamOverview();
      },
      audit: async (filter?: TeamAuditFilter): Promise<TeamAuditResult> => {
        const entries = filterAudit(filter);
        return { entries, total: filter?.query || filter?.action || filter?.actorId || (filter?.targetType && filter.targetType !== "all") ? entries.length : mockTeamActivity.length };
      },
      exportAudit: async (filter?: TeamAuditFilter): Promise<TeamAuditExportResult> => {
        const entries = filterAudit(filter);
        return { count: entries.length, filename: `nexus-team-audit-${new Date().toISOString().slice(0, 10)}.csv`, path: "/mock/nexus-team-audit.csv" };
      },
    },
    teamSync: {
      status: async () => syncStatus,
      configure: async (input) => {
        syncStatus = {
          ...mockSyncStatus(),
          enabled: true,
          phase: "online",
          endpoint: input.endpoint,
          workspace: input.workspace || "default",
          deviceName: input.deviceName || "Nexus desktop",
          tokenSet: true,
          revision: 1,
          lastSyncAt: Date.now(),
          lastAttemptAt: Date.now(),
        };
        return { status: syncStatus, pulled: 0, pushed: 1, changed: true };
      },
      now: async () => {
        syncStatus = { ...syncStatus, enabled: true, phase: "online", revision: syncStatus.revision + 1, lastSyncAt: Date.now(), lastAttemptAt: Date.now() };
        return { status: syncStatus, pulled: 0, pushed: 0, changed: false };
      },
      disable: async () => {
        syncStatus = mockSyncStatus();
        return syncStatus;
      },
    },
    hosts: {
      list: async () => hosts,
      save: async (input: HostInput) => {
        const existing = input.id ? hosts.find((host) => host.id === input.id) : undefined;
        const saved: HostSummary = {
          id: existing?.id ?? `host-${Date.now()}`,
          label: input.label || "new-host",
          baseUrl: input.baseUrl,
          authMode: input.authMode,
          tokenId: input.tokenId,
          username: input.username,
          tlsVerify: input.tlsVerify,
          color: "#38f2ff",
          hasSecret: Boolean(input.secret) || Boolean(existing?.hasSecret),
          createdAt: existing?.createdAt ?? Date.now(),
        };
        hosts = existing ? hosts.map((host) => (host.id === saved.id ? saved : host)) : [...hosts, saved];
        return saved;
      },
      remove: async (id: string) => {
        hosts = hosts.filter((host) => host.id !== id);
      },
      test: async (input: HostInput): Promise<HostTestResult> => {
        await new Promise((resolve) => setTimeout(resolve, 620));
        if (!input.secret) return { ok: false, latencyMs: 412, error: "Enter a token secret or password first." };
        return {
          ok: true,
          latencyMs: 84,
          version: "8.3.2",
          release: "3f5b1d0",
          clusterName: "demo",
          nodes: ["pve-hyperion", "pve-helios"],
          tlsFingerprint: "B4:2E:19:AA:0C:71:8D:33:5F:2C:91:DE:44:18:7A:C0",
        };
      },
    },
    pve: {
      snapshot: async (hostId: string) => snapshot(hostId),
      vmDetail: async (hostId, node, type, vmid) => makeDetail(hostId, node, type, vmid),
      vmAction: async () => ({ upid: "UPID:mock" }),
      snapshotCreate: async () => ({ upid: "UPID:mock:snapshot" }),
      snapshotRollback: async () => ({ upid: "UPID:mock:rollback" }),
      snapshotDelete: async () => undefined,
      taskLog: async (_hostId, _node, upid) => [
        `starting task ${upid}`,
        "INFO: create storage snapshot",
        "INFO: using zstd compression",
        "INFO: 46% done",
        "INFO: 71% done",
        "INFO: transferred 8.4 GiB in 92s (93.2 MiB/s)",
        "INFO: archive file size: 6.2GB",
        "INFO: Finished Backup of VM 121 (00:01:34)",
        "TASK OK",
      ],
      nodeRrd: async (hostId, node, timeframe) => {
        const host = hosts.find((entry) => entry.id === hostId);
        const index = NODE_FABRIC[host?.id ?? hosts[0].id].nodes.indexOf(node);
        const series = makeRrd(index + 1, NODE_FABRIC[host?.id ?? hosts[0].id].cpu[index] ?? 0.3);
        return timeframe === "hour" ? series : series.filter((_, i) => i % 2 === 0);
      },
    },
    backups: {
      archives: async (hostId) => archiveState[hostId] ?? makeArchives(hostId),
      run: async (hostId, req) => {
        const list = archiveState[hostId] ?? makeArchives(hostId);
        const archive: BackupArchive = {
          volid: `backup-nfs:backup/vzdump-qemu-${req.vmid ?? 999}-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "_")}.vma.zst`,
          storage: req.storage ?? "backup-nfs",
          node: req.node,
          vmid: req.vmid,
          ctime: Date.now(),
          size: 7.4 * 1024 ** 3,
          format: "zst",
          protected: false,
          notes: req.notes,
        };
        archiveState = { ...archiveState, [hostId]: [archive, ...list] };
        return { upid: "UPID:mock:backup", node: req.node };
      },
      restore: async () => ({ upid: "UPID:mock:restore" }),
      removeArchive: async (hostId, _node, _storage, volid) => {
        archiveState = { ...archiveState, [hostId]: (archiveState[hostId] ?? makeArchives(hostId)).filter((entry) => entry.volid !== volid) };
      },
      saveSchedule: async (_hostId, input) => ({ id: input.id ?? String(Date.now()) }),
      deleteSchedule: async () => undefined,
    },
    pipelines: {
      list: async () => PIPELINES,
      runs: async () => [...runs.values()].sort((a, b) => b.startedAt - a.startedAt),
      run: async (pipelineId, hostId) => {
        const pipeline = PIPELINES.find((entry) => entry.id === pipelineId)!;
        return simulateRun(pipeline, hostId);
      },
      approve: async (runId) => {
        const run = runs.get(runId);
        if (!run) throw new Error("unknown run");
        run.status = "running";
        run.approval = undefined;
        const waiting = run.steps.find((step) => step.status === "waiting-approval");
        if (waiting) {
          waiting.status = "ok";
          waiting.endedAt = Date.now();
        }
        run.log.push({ at: Date.now(), level: "ok", message: "Operator approved the step" });
        emit({ type: "pipeline", run: structuredClone(run), hostId: run.hostId });
        setTimeout(() => {
          const current = runs.get(runId);
          if (!current) return;
          const next = current.steps.find((step) => step.status === "pending");
          if (!next) {
            current.status = "ok";
            current.endedAt = Date.now();
          } else {
            next.status = "running";
            next.startedAt = Date.now();
            current.log.push({ at: Date.now(), level: "info", message: `Running ${next.title}`, stepId: next.id });
            setTimeout(() => {
              next.status = "ok";
              next.endedAt = Date.now();
              current.status = "ok";
              current.endedAt = Date.now();
              current.log.push({ at: Date.now(), level: "ok", message: "Run completed" });
              emit({ type: "pipeline", run: structuredClone(current), hostId: current.hostId });
            }, 1200);
          }
          emit({ type: "pipeline", run: structuredClone(current), hostId: current.hostId });
        }, 500);
        return structuredClone(run);
      },
      cancel: async (runId) => {
        const run = runs.get(runId);
        if (!run) throw new Error("unknown run");
        run.status = "cancelled";
        run.endedAt = Date.now();
        run.approval = undefined;
        emit({ type: "pipeline", run: structuredClone(run), hostId: run.hostId });
        return structuredClone(run);
      },
      onRun: (handler) => {
        const listener = (event: NexusEvent) => {
          if (event.type === "pipeline" && event.run) handler(event.run);
        };
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    ssh: {
      hosts: async () => sshHosts,
      save: async (input: SshHostInput) => {
        const existing = input.id ? sshHosts.find((host) => host.id === input.id) : undefined;
        const saved: SshHostSummary = {
          id: existing?.id ?? `ssh-${Date.now()}`,
          label: input.label || input.host,
          host: input.host,
          port: input.port ?? 22,
          username: input.username,
          authMode: input.authMode === "password" ? "password" : "key",
          keyPath: input.keyPath,
          hasSecret: Boolean(input.password) || Boolean(existing?.hasSecret),
          color: existing?.color ?? "#3dffa8",
          createdAt: existing?.createdAt ?? Date.now(),
          lastSeenAt: existing?.lastSeenAt,
        };
        sshHosts = existing ? sshHosts.map((host) => (host.id === saved.id ? saved : host)) : [...sshHosts, saved];
        return saved;
      },
      remove: async (id: string) => {
        sshHosts = sshHosts.filter((host) => host.id !== id);
      },
      test: async (input: SshHostInput): Promise<SshTestResult> => {
        await new Promise((resolve) => setTimeout(resolve, 480));
        if (!input.host || !input.username) return { ok: false, latencyMs: 0, error: "Host and username are required" };
        if (input.authMode === "password" && !input.password && !input.id) {
          return { ok: false, latencyMs: 0, error: "Password is required for password authentication" };
        }
        return { ok: true, latencyMs: 68, hostname: input.label || input.host, os: "Ubuntu 24.04.5 LTS", kernel: "6.17.0-35-generic", cores: 2 };
      },
      health: async () =>
        sshHosts.map((host) => ({ id: host.id, health: "online" as const, latencyMs: 60 + host.label.length })),
      exec: async (hostId: string, command: string) => {
        await new Promise((resolve) => setTimeout(resolve, 260));
        const host = sshHosts.find((entry) => entry.id === hostId) ?? sshHosts[0];
        return { host: host.label, ok: true, code: 0, latencyMs: 260, stdout: `$ ${command}\n(mock output from ${host.label})`, stderr: "" };
      },
      speedtest: async (hostId: string) => {
        const index = Math.max(0, sshHosts.findIndex((host) => host.id === hostId));
        return mockSpeed(sshHosts[index] ?? sshHosts[0], hostId, index);
      },
      speedtestAll: async () => sshHosts.map((host, index) => mockSpeed(host, host.id, index)),
      action: async (hostId: string, action) => ({
        host: sshHosts.find((host) => host.id === hostId)?.label ?? "host",
        action,
        ok: true,
        output: `${action} requested (mock)`,
      }),
      snapshot: async (hostId: string) => {
        const host = sshHosts.find((entry) => entry.id === hostId) ?? sshHosts[0];
        return makeSshSnapshot(host);
      },
      helper: async (hostId: string) => {
        const host = sshHosts.find((entry) => entry.id === hostId) ?? sshHosts[0];
        return mockHelperStatus(host);
      },
      installHelper: async (hostId: string) => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        const host = sshHosts.find((entry) => entry.id === hostId) ?? sshHosts[0];
        mockHelpers.set(host.id, "ready");
        const status = mockHelperStatus(host);
        return {
          hostId: host.id,
          ok: true,
          route: status.route,
          output: `helper=installed\nsudoers=installed\nvisudo: parsed OK\n@@done`,
          status,
        };
      },
    },
    sshkeys: {
      overview: async () => mockSshKeyOverview(),
      generate: async (input) => {
        const now = Date.now();
        const id = `key-${now}`;
        const key: ManagedSshKey = {
          id,
          label: input.label,
          owner: input.owner || "operator",
          comment: `nexus/${(input.owner || "operator").replace(/\s+/g, "-")}/${input.label.replace(/\s+/g, "-")}`,
          algorithm: "ssh-ed25519",
          fingerprint: `SHA256:mock-${id}`,
          publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILlg7H2uPpeDzV8H2mmt/ag0j4fFE2lwfS3MQtkWPla5 ${id}`,
          createdAt: now,
          status: "active",
          hosts: [],
        };
        mockManagedSshKeys = [key, ...mockManagedSshKeys];
        mockSshEvents.unshift({ at: now, kind: "generate", ok: true, message: `Generated ${key.label} for ${key.owner}` });
        const overview = mockSshKeyOverview();
        emit({ type: "sshkeys", sshKeys: overview });
        return overview;
      },
      deploy: async (hostId, keyId): Promise<SshKeyDeployResult> => {
        const key = mockManagedSshKeys.find((entry) => entry.id === keyId);
        const host = sshHosts.find((entry) => entry.id === hostId);
        if (!key || !host) throw new Error("Unknown SSH key or host");
        key.hosts = [...new Set([...key.hosts, hostId])];
        key.lastDeployedAt = Date.now();
        key.status = "active";
        const report = mockSshKeyReport(host);
        if (!report.keys.some((entry) => entry.fingerprint === key.fingerprint)) {
          report.keys.push({
            fingerprint: key.fingerprint,
            type: key.algorithm,
            comment: key.comment,
            publicKey: key.publicKey,
            source: "managed",
            keyId: key.id,
            owner: key.owner,
            firstSeenAt: Date.now(),
          });
          report.exists = true;
          report.mode = "600";
          report.managed += 1;
        }
        report.scannedAt = Date.now();
        mockSshEvents.unshift({ at: Date.now(), kind: "deploy", ok: true, message: `Deployed ${key.label} to ${host.label}`, hostId, host: host.label });
        const overview = mockSshKeyOverview();
        emit({ type: "sshkeys", sshKeys: overview });
        return {
          hostId,
          host: host.label,
          keyId,
          fingerprint: key.fingerprint,
          path: report.path,
          mode: "600",
          added: true,
          output: `state=added\npath=${report.path}\nmode=600`,
        };
      },
      scan: async (hostId) => {
        const host = sshHosts.find((entry) => entry.id === hostId);
        if (!host) throw new Error("Unknown SSH host");
        const report = mockSshKeyReport(host);
        report.scannedAt = Date.now();
        report.exists = true;
        report.mode = report.mode ?? "600";
        mockSshEvents.unshift({ at: Date.now(), kind: "scan", ok: true, message: `Scanned ${host.label}: ${report.managed} managed, ${report.trusted} trusted, ${report.unknown} unmanaged`, hostId, host: host.label });
        emit({ type: "sshkeys", sshKeys: mockSshKeyOverview() });
        return report;
      },
      trust: async (hostId) => {
        const host = sshHosts.find((entry) => entry.id === hostId);
        if (!host) throw new Error("Unknown SSH host");
        const report = mockSshKeyReport(host);
        report.keys = report.keys.map((key) => (key.source === "unknown" ? { ...key, source: "trusted" as const } : key));
        report.unknown = 0;
        report.trusted = report.keys.filter((key) => key.source === "trusted").length;
        report.scannedAt = Date.now();
        mockSshEvents.unshift({ at: Date.now(), kind: "trust", ok: true, message: `Trusted unmanaged keys on ${host.label}`, hostId, host: host.label });
        emit({ type: "sshkeys", sshKeys: mockSshKeyOverview() });
        return report;
      },
      enforce: async (hostId): Promise<SshKeyEnforceResult> => {
        const host = sshHosts.find((entry) => entry.id === hostId);
        if (!host) throw new Error("Unknown SSH host");
        const report = mockSshKeyReport(host);
        const removed = report.keys.filter((key) => key.source === "unknown").map((key) => key.fingerprint);
        report.keys = report.keys.filter((key) => key.source !== "unknown");
        report.unknown = 0;
        report.scannedAt = Date.now();
        mockSshEvents.unshift({ at: Date.now(), kind: "enforce", ok: true, message: `Removed ${removed.length} unmanaged key(s) from ${host.label}`, hostId, host: host.label });
        emit({ type: "sshkeys", sshKeys: mockSshKeyOverview() });
        return { hostId, host: host.label, removed, kept: report.keys.length, backup: `${report.path}.nexus-mock.bak`, output: `removed=${removed.length}\nkept=${report.keys.length}` };
      },
      policy: async (patch) => {
        mockSshKeyPolicy = { ...mockSshKeyPolicy, ...patch, updatedAt: Date.now() };
        mockSshEvents.unshift({ at: Date.now(), kind: "policy", ok: true, message: `Policy updated: auto-enforce ${mockSshKeyPolicy.autoEnforce ? "on" : "off"}` });
        emit({ type: "sshkeys", sshKeys: mockSshKeyOverview() });
        return mockSshKeyPolicy;
      },
      revoke: async (keyId) => {
        const key = mockManagedSshKeys.find((entry) => entry.id === keyId);
        if (!key) throw new Error("Unknown SSH key");
        key.status = "retired";
        key.hosts = [];
        for (const report of Object.values(mockSshKeyReports)) {
          report.keys = report.keys.filter((entry) => entry.keyId !== key.id);
          report.managed = report.keys.filter((entry) => entry.source === "managed").length;
        }
        mockSshEvents.unshift({ at: Date.now(), kind: "revoke", ok: true, message: `Revoked ${key.label}` });
        const overview = mockSshKeyOverview();
        emit({ type: "sshkeys", sshKeys: overview });
        return overview;
      },
      onChanged: (handler) => {
        const listener = (event: NexusEvent) => {
          if (event.type === "sshkeys" && event.sshKeys) handler(event.sshKeys);
        };
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    security: {
      overview: async () => ({
        running: true,
        policy: mockGuardPolicy,
        hosts: sshHosts.map((host) => ({
          hostId: host.id,
          label: host.label,
          scan: mockScan(host.id, host.label),
          nextRunAt: Date.now() + 118_000,
          running: false,
        })),
        chain: { ok: true, length: 9 },
        journal: mockJournalEntries(),
      }),
      scan: async (hostId: string) => mockScan(hostId, sshHosts.find((host) => host.id === hostId)?.label ?? "host"),
      enforce: async (hostId: string) => mockScan(hostId, sshHosts.find((host) => host.id === hostId)?.label ?? "host"),
      policy: async (patch?: Partial<SecurityPolicy>) => {
        mockGuardPolicy = { ...mockGuardPolicy, ...patch, updatedAt: Date.now() };
        return mockGuardPolicy;
      },
      journal: async () => mockJournalEntries(),
      acceptBaseline: async () => ({
        running: true,
        policy: mockGuardPolicy,
        hosts: sshHosts.map((host) => ({ hostId: host.id, label: host.label, scan: mockScan(host.id, host.label), running: false })),
        chain: { ok: true, length: 9 },
        journal: mockJournalEntries(),
      }),
      verify: async () => ({ ok: true, length: 9, detail: "9 records verified end to end" }),
      resident: async () => ({ installed: true, active: true, enforce: ["sysctl-hardening", "key-permissions"], output: "timer=active" }),
      ban: async (_hostId: string, ip: string) => ({ ok: true, output: `banned=${ip} set=banned ttl=24h` }),
      bans: async () => ["203.0.113.42"],
      onScan: () => () => {},
    },
    ddos: {
      overview: async () => mockDdosOverview(),
      status: async () => mockDdosStatus(),
      install: async (hostId: string) => ({
        hostId,
        ok: true,
        output: "NEXUS_SHIELD_OK",
        status: mockDdosStatus(),
      }),
      setMode: async (_hostId: string, mode: DdosMode) => {
        mockDdosMode = mode;
        mockDdosIncidents.unshift({ id: `ddos-${Date.now()}`, at: Date.now(), kind: "mode", message: `mode set to ${mode} on edge-relay` });
        return mockDdosStatus();
      },
      ban: async (_hostId: string, ip: string) => {
        mockDdosBlocked = [...new Set([...mockDdosBlocked, ip])];
        mockDdosIncidents.unshift({ id: `ddos-${Date.now()}`, at: Date.now(), kind: "ban", message: `banned ${ip} on edge-relay for 3600s` });
        return mockDdosStatus();
      },
      unban: async (_hostId: string, ip: string) => {
        mockDdosBlocked = mockDdosBlocked.filter((entry) => entry !== ip);
        return mockDdosStatus();
      },
      allow: async (_hostId: string, ip: string, add: boolean) => {
        mockDdosAllow = add ? [...new Set([...mockDdosAllow, ip])] : mockDdosAllow.filter((entry) => entry !== ip);
        return mockDdosStatus();
      },
      apply: async (_hostId: string, patch: Partial<DdosConfig>) => {
        if (patch.mode) mockDdosMode = patch.mode;
        if (patch.limits) mockDdosLimits = { ...mockDdosLimits, ...patch.limits };
        return mockDdosStatus();
      },
      journal: async () => mockDdosIncidents,
    },
    relay: {
      overview: async () => mockRelayOverview(),
      save: async (input: RelayChainInput) => {
        const now = Date.now();
        const nodes = input.nodes.map((node) => {
          const host = sshHosts.find((entry) => entry.id === node.hostId);
          if (!host) throw new Error(`Unknown host ${node.hostId}`);
          return {
            ...node,
            label: node.label || host.label,
            publicHost: node.publicHost || host.host,
          };
        });
        mockRelayChain = {
          id: input.id ?? mockRelayChain?.id ?? `relay-${now}`,
          name: input.name || "Mock relay",
          nodes,
          originHost: input.originHost || "127.0.0.1",
          originPort: input.originPort || 25565,
          entryPort: input.entryPort || 7443,
          relayPort: input.relayPort || 7444,
          mtu: input.mtu || 1420,
          transport: "wireguard",
          obfuscation: input.obfuscation === "tls" ? "tls" : "none",
          createdAt: mockRelayChain?.createdAt ?? now,
          updatedAt: now,
        };
        return mockRelayChain;
      },
      probe: async () => mockRelayOverview(),
      deploy: async () => {
        if (!mockRelayChain) throw new Error("No relay chain saved");
        return {
          ok: true,
          chain: mockRelayChain,
          outputs: mockRelayChain.nodes.map((node) => ({
            hostId: node.hostId,
            label: node.label,
            ok: true,
            output: "NEXUS_RELAY_OK (mock)",
          })),
        };
      },
      remove: async () => ({
        ok: true,
        outputs: (mockRelayChain?.nodes ?? []).map((node) => ({
          hostId: node.hostId,
          label: node.label,
          ok: true,
          output: "NEXUS_RELAY_REMOVED (mock)",
        })),
      }),
    },
    praetor: {
      overview: async () => mockPraetorOverview(),
      health: async (target: string) => mockPraetorHealth(target),
      install: async (hostId: string): Promise<PraetorInstallResult> => {
        const host = sshHosts.find((entry) => entry.id === hostId) ?? sshHosts[0];
        if (!host) throw new Error("No SSH host configured");
        const profiles = mockPraetorProfilesFor(host);
        return {
          hostId: host.id,
          label: host.label,
          ok: true,
          state: "ready",
          route: "nopasswd",
          endpoint: `${host.host}:9443`,
          publicKey: mockPraetorKey(),
          profiles,
          output: "@@node=/usr/bin/node\n@@endpoint=" + host.host + ":9443\n@@profiles=4\n@@done",
          latencyMs: 820,
        };
      },
      rotate: async (hostId: string): Promise<PraetorRotateResult> => {
        const host = sshHosts.find((entry) => entry.id === hostId) ?? sshHosts[0];
        if (!host) throw new Error("No SSH host configured");
        const oldPublicKey = mockPraetorProfiles.get(host.id)?.[0]?.serverPublicKey;
        mockPraetorGeneration += 1;
        mockPraetorProfiles.delete(host.id);
        const profiles = mockPraetorProfilesFor(host);
        return {
          hostId: host.id,
          label: host.label,
          ok: true,
          state: "ready",
          route: "nopasswd",
          endpoint: `${host.host}:9443`,
          publicKey: mockPraetorKey(),
          oldPublicKey,
          profiles,
          output: `@@oldpubkey=${oldPublicKey ?? ""}\n@@pubkey=${mockPraetorKey()}\n@@profiles=4\n@@done`,
          latencyMs: 1140,
        };
      },
    },
    vnc: {
      preflight: async (hostId: string) => ({
        hostId,
        host: sshHosts.find((entry) => entry.id === hostId)?.host ?? "127.0.0.1",
        hostname: "mock-host",
        checkedAt: Date.now(),
        latencyMs: 12,
        ports: [5900],
        loopbackPorts: [5900],
        exposedPorts: [],
        suggestedPort: 5900,
        daemon: "wayvnc",
        elevation: "nopasswd",
        needsSudoPassword: false,
        ok: true,
        detail: "127.0.0.1:5900 (wayvnc) reachable through the SSH tunnel.",
      }),
      setup: async (hostId: string) => ({
        hostId,
        ok: true,
        state: "ready" as const,
        route: "password" as const,
        port: 5900,
        mode: "wayland" as const,
        service: "nexus-vnc-console.service",
        packages: [],
        output: "VNC console already ready (mock).",
        latencyMs: 18,
      }),
      open: async (hostId: string) => ({
        id: `vnc-${Date.now()}`,
        hostId,
        wsUrl: "ws://127.0.0.1:5999/mock",
        expiresAt: Date.now() + 60_000,
      }),
      close: async () => undefined,
    },
    mcp: {
      status: async () => ({
        serverPath: "dist-electron/mcp-server.cjs",
        command: "node",
        args: ["dist-electron/mcp-server.cjs"],
        toolCount: 26,
        configPath: "%APPDATA%\\Claude\\claude_desktop_config.json",
        hostCount: hosts.length,
      }),
      writeConfig: async (target) => ({ path: target === "cursor" ? "~/.cursor/mcp.json" : "%APPDATA%\\Claude\\claude_desktop_config.json" }),
    },
    onEvent: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}
