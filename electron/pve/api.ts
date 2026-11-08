import { PveClient, enc } from "./client";
import type {
  AgentNic,
  BackupArchive,
  ClusterBackupJob,
  DiskInfo,
  NicInfo,
  NodeStats,
  RrdPoint,
  SensorReading,
  Snapshot,
  StorageInfo,
  TaskSummary,
  VmAction,
  VmDetail,
  VmSummary,
  VmType,
} from "../../shared/types";

export interface RawNode {
  node: string;
  status: string;
  uptime?: number;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
}

interface RawNodeStatus {
  uptime?: number;
  loadavg?: (string | number)[];
  ksm?: { shared?: number; sharing?: number };
  cpuinfo?: { cores?: number; cpus?: number; mhz?: string | number; model?: string; sockets?: number };
  memory?: { used?: number; free?: number; total?: number };
  swap?: { used?: number; free?: number; total?: number };
  rootfs?: { used?: number; free?: number; total?: number; avail?: number };
  pveversion?: string;
  "current-kernel"?: { version?: string; "machine-type"?: string };
}

interface RawResource {
  id?: string;
  type?: string;
  node?: string;
  vmid?: number;
  name?: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
  tags?: string;
  template?: number;
  pool?: string;
  hastate?: string;
  lock?: string;
}

interface RawTask {
  upid: string;
  node: string;
  type: string;
  id: string;
  user: string;
  status?: string;
  starttime?: number;
  endtime?: number;
  exitstatus?: string;
}

export interface ClusterInfo {
  name?: string;
  quorate?: boolean;
  nodes: { name: string; online: boolean; level?: string }[];
}

export async function fetchVersion(client: PveClient): Promise<{ version: string; release: string; repoid: string }> {
  return client.get("/version");
}

export async function fetchCluster(client: PveClient): Promise<ClusterInfo> {
  const raw = await client.get<{ type: string; name?: string; online?: number; quorate?: number; nodes?: number }[]>(
    "/cluster/status",
  );
  const nodes = raw
    .filter((entry) => entry.type === "node")
    .map((entry) => ({
      name: entry.name ?? "unknown",
      online: entry.online === 1,
      level: (entry as { level?: string }).level,
    }));
  return {
    name: raw.find((entry) => entry.type === "cluster")?.name,
    quorate: raw.find((entry) => entry.type === "cluster")?.quorate === 1,
    nodes,
  };
}

export async function fetchNodes(client: PveClient): Promise<RawNode[]> {
  return client.get<RawNode[]>("/nodes");
}

export async function fetchNodeStats(client: PveClient, node: string, summary?: RawNode): Promise<NodeStats> {
  const started = Date.now();
  const [status, rrd, storages, disks, network, sensors] = await Promise.allSettled([
    client.get<RawNodeStatus>(`/nodes/${enc(node)}/status`),
    client.get<Record<string, number | string | null>[]>(`/nodes/${enc(node)}/rrddata`, {
      timeframe: "hour",
      cf: "AVERAGE",
    }),
    client.get<Record<string, unknown>[]>(`/nodes/${enc(node)}/storage`),
    client.get<Record<string, unknown>[]>(`/nodes/${enc(node)}/disks/list`),
    client.get<Record<string, unknown>[]>(`/nodes/${enc(node)}/network`),
    client.get<Record<string, unknown[]>>(`/nodes/${enc(node)}/sensors`),
  ]);

  const value = <T,>(result: PromiseSettledResult<T>, fallback: T): T =>
    result.status === "fulfilled" ? result.value : fallback;

  const s = value(status, {} as RawNodeStatus);
  const points = value(rrd, [] as Record<string, number | string | null>[]);

  // A node can be online in /nodes while its status endpoint is denied; fall
  // back to the cluster view so the console still shows something truthful.
  const memoryTotal = s.memory?.total ?? summary?.maxmem ?? 0;
  const memoryUsed = s.memory?.used ?? summary?.mem ?? 0;

  return {
    node,
    status: summary?.status ?? "unknown",
    uptime: s.uptime ?? summary?.uptime ?? 0,
    cpu: summary?.cpu ?? 0,
    cores: s.cpuinfo?.cores ?? summary?.maxcpu ?? 1,
    sockets: s.cpuinfo?.sockets ?? 1,
    mhz: Number(s.cpuinfo?.mhz ?? 0),
    model: s.cpuinfo?.model ?? "CPU model unavailable",
    kernel: s["current-kernel"]?.version ?? "",
    pveVersion: s.pveversion ?? "",
    memory: { used: memoryUsed, total: memoryTotal, free: s.memory?.free ?? Math.max(0, memoryTotal - memoryUsed) },
    swap: { used: s.swap?.used ?? 0, total: s.swap?.total ?? 0, free: s.swap?.free ?? 0 },
    rootfs: {
      used: s.rootfs?.used ?? summary?.disk ?? 0,
      total: s.rootfs?.total ?? summary?.maxdisk ?? 0,
      free: s.rootfs?.free ?? 0,
    },
    loadavg: (s.loadavg ?? []).map((n) => Number(n) || 0),
    ksm: { shared: s.ksm?.shared ?? 0, sharing: s.ksm?.sharing ?? 0 },
    storages: value(storages, []).map(normalizeStorage),
    disks: value(disks, []).map(normalizeDisk),
    network: value(network, []).map(normalizeNic),
    sensors: flattenSensors(value(sensors, {})),
    rrd: points.map(normalizeRrdPoint).filter((p) => p.t > 0),
    vmCount: 0,
    runningCount: 0,
    latencyMs: Date.now() - started,
  };
}

function normalizeStorage(raw: Record<string, unknown>): StorageInfo {
  return {
    storage: String(raw.storage ?? "?"),
    type: String(raw.type ?? ""),
    content: String(raw.content ?? "")
      .split(",")
      .filter(Boolean),
    active: raw.active === 1 || raw.active === true,
    total: Number(raw.total ?? 0),
    used: Number(raw.used ?? 0),
    avail: Number(raw.avail ?? 0),
    shared: raw.shared === 1 || raw.shared === true,
  };
}

function normalizeDisk(raw: Record<string, unknown>): DiskInfo {
  return {
    dev: String(raw.devpath ?? raw.dev ?? "?"),
    model: String(raw.model ?? "—"),
    serial: String(raw.serial ?? ""),
    size: Number(raw.size ?? 0),
    health: String(raw.health ?? "UNKNOWN"),
    type: String(raw.type ?? ""),
    used: raw.used ? String(raw.used) : undefined,
    wearout: raw.wearout !== undefined ? Number(raw.wearout) : undefined,
  };
}

function normalizeNic(raw: Record<string, unknown>): NicInfo {
  return {
    iface: String(raw.iface ?? "?"),
    type: String(raw.type ?? ""),
    active: raw.active === 1 || raw.active === true,
    address: raw.address ? String(raw.address) : undefined,
    cidr: raw.cidr ? String(raw.cidr) : undefined,
    gateway: raw.gateway ? String(raw.gateway) : undefined,
    speed: raw.speed ? String(raw.speed) : undefined,
  };
}

function flattenSensors(raw: Record<string, unknown[]>): SensorReading[] {
  const readings: SensorReading[] = [];
  for (const group of Object.values(raw ?? {})) {
    if (!Array.isArray(group)) continue;
    for (const entry of group as Record<string, unknown>[]) {
      const value = Number(entry.value);
      if (!Number.isFinite(value)) continue;
      readings.push({
        name: String(entry.name ?? entry.label ?? "sensor"),
        value,
        unit: String(entry.unit ?? ""),
      });
    }
  }
  return readings.slice(0, 16);
}

function normalizeRrdPoint(raw: Record<string, number | string | null>): RrdPoint {
  return {
    t: Number(raw.time ?? 0) * 1000,
    cpu: Number(raw.cpu ?? 0),
    mem: Number(raw.memused ?? 0),
    netin: Number(raw.netin ?? 0),
    netout: Number(raw.netout ?? 0),
    load: Number(raw.loadavg ?? 0),
    iowait: Number(raw.iowait ?? 0),
  };
}

export async function fetchResources(client: PveClient): Promise<VmSummary[]> {
  const raw = await client.get<RawResource[]>("/cluster/resources", { type: "vm" });
  return raw
    .filter((entry) => entry.type === "qemu" || entry.type === "lxc")
    .map((entry) => ({
      key: `${entry.node}/${entry.type}/${entry.vmid}`,
      vmid: Number(entry.vmid ?? 0),
      name: entry.name || `${entry.type === "lxc" ? "CT" : "VM"} ${entry.vmid}`,
      type: entry.type as VmType,
      node: String(entry.node ?? ""),
      status: (entry.status as VmSummary["status"]) ?? "unknown",
      cpu: Number(entry.cpu ?? 0),
      cpus: Number(entry.maxcpu ?? 1),
      mem: Number(entry.mem ?? 0),
      maxmem: Number(entry.maxmem ?? 0),
      disk: Number(entry.disk ?? 0),
      maxdisk: Number(entry.maxdisk ?? 0),
      uptime: Number(entry.uptime ?? 0),
      netin: Number(entry.netin ?? 0),
      netout: Number(entry.netout ?? 0),
      diskread: Number(entry.diskread ?? 0),
      diskwrite: Number(entry.diskwrite ?? 0),
      tags: entry.tags ? String(entry.tags).split(/[;,]/).filter(Boolean) : [],
      template: entry.template === 1,
      lock: entry.lock ? String(entry.lock) : undefined,
      pool: entry.pool ? String(entry.pool) : undefined,
      haState: entry.hastate ? String(entry.hastate) : undefined,
    }))
    .sort((a, b) => a.vmid - b.vmid);
}

export async function fetchTasks(client: PveClient, node: string, limit = 24): Promise<TaskSummary[]> {
  const raw = await client.get<RawTask[]>(`/nodes/${enc(node)}/tasks`, { limit, start: 0 });
  return raw.map((task) => ({
    upid: task.upid,
    node: task.node,
    type: task.type,
    id: task.id,
    user: task.user,
    state: task.status === "running" ? "running" : task.exitstatus?.startsWith("OK") ? "ok" : task.exitstatus ? "error" : "unknown",
    starttime: Number(task.starttime ?? 0) * 1000,
    endtime: task.endtime ? Number(task.endtime) * 1000 : undefined,
    exitstatus: task.exitstatus,
  }));
}

export async function fetchTaskLog(client: PveClient, node: string, upid: string): Promise<string[]> {
  const raw = await client.get<{ t?: string }[]>(`/nodes/${enc(node)}/tasks/${enc(upid)}/log`, { limit: 400 });
  return raw.map((line) => line.t ?? "").filter(Boolean);
}

export async function fetchVmDetail(
  client: PveClient,
  node: string,
  type: VmType,
  vmid: number,
): Promise<Pick<VmDetail, "config" | "agentNetworks" | "agentAvailable" | "snapshots" | "tasks">> {
  const base = `/nodes/${enc(node)}/${type}/${vmid}`;
  const [config, snapshots, tasks] = await Promise.all([
    client.get<Record<string, string | number>>(`${base}/config`).catch(() => ({})),
    client.get<Record<string, string | number>[]>(`${base}/snapshot`).catch(() => []),
    fetchTasks(client, node, 12).catch(() => []),
  ]);

  let agentNetworks: AgentNic[] = [];
  let agentAvailable = false;
  if (type === "qemu") {
    try {
      const result = await client.get<{
        result?: {
          name?: string;
          "hardware-address"?: string;
          "ip-addresses"?: { "ip-address"?: string; "ip-address-type"?: string }[];
        }[];
      }>(`${base}/agent/network-get-interfaces`);
      agentNetworks = (result?.result ?? []).map((nic) => ({
        name: nic.name ?? "eth?",
        mac: nic["hardware-address"] ?? "",
        ips: (nic["ip-addresses"] ?? [])
          .filter((ip) => ip["ip-address"])
          .map((ip) => ({
            address: String(ip["ip-address"]),
            family: ip["ip-address-type"] === "ipv6" ? ("ipv6" as const) : ("ipv4" as const),
          })),
      }));
      agentAvailable = true;
    } catch {
      agentAvailable = false;
    }
  }

  return {
    config,
    agentNetworks,
    agentAvailable,
    snapshots: snapshots
      .filter((snap) => snap.name)
      .map((snap) => ({
        name: String(snap.name),
        description: snap.description ? String(snap.description) : undefined,
        snaptime: snap.snaptime ? Number(snap.snaptime) * 1000 : undefined,
        parent: snap.parent ? String(snap.parent) : undefined,
        current: snap.name === "current",
      })),
    tasks: tasks.filter((task) => String(task.id) === String(vmid) || task.type === "vzdump"),
  };
}

export async function fetchSnapshots(client: PveClient, node: string, type: VmType, vmid: number): Promise<Snapshot[]> {
  const detail = await fetchVmDetail(client, node, type, vmid);
  return detail.snapshots;
}

export async function createSnapshot(
  client: PveClient,
  node: string,
  type: VmType,
  vmid: number,
  snapname: string,
  description?: string,
): Promise<string | undefined> {
  const data = await client.post<string>(`/nodes/${enc(node)}/${type}/${vmid}/snapshot`, {
    snapname,
    description,
  });
  return typeof data === "string" ? data : undefined;
}

export async function rollbackSnapshot(
  client: PveClient,
  node: string,
  type: VmType,
  vmid: number,
  snapname: string,
): Promise<string | undefined> {
  const data = await client.post<string>(`/nodes/${enc(node)}/${type}/${vmid}/snapshot/${enc(snapname)}/rollback`);
  return typeof data === "string" ? data : undefined;
}

export async function deleteSnapshot(
  client: PveClient,
  node: string,
  type: VmType,
  vmid: number,
  snapname: string,
): Promise<void> {
  await client.del(`/nodes/${enc(node)}/${type}/${vmid}/snapshot/${enc(snapname)}`);
}

export async function vmAction(
  client: PveClient,
  node: string,
  type: VmType,
  vmid: number,
  action: VmAction,
): Promise<string | undefined> {
  const data = await client.post<string>(`/nodes/${enc(node)}/${type}/${vmid}/status/${action}`);
  return typeof data === "string" ? data : undefined;
}

export async function fetchSchedules(client: PveClient): Promise<ClusterBackupJob[]> {
  const raw = await client.get<Record<string, unknown>[]>("/cluster/backup");
  return (raw ?? []).map((job) => ({
    id: String(job.id ?? ""),
    enabled: job.enabled === 1 || job.enabled === true || job.enabled === undefined,
    schedule: String(job.schedule ?? "daily"),
    storage: String(job.storage ?? ""),
    mode: String(job.mode ?? "snapshot"),
    compress: String(job.compress ?? "zstd"),
    node: job.node ? String(job.node) : undefined,
    vmid: job.vmid ? String(job.vmid) : undefined,
    all: job.all === 1 || job.all === true,
    comment: job.comment ? String(job.comment) : undefined,
    nextRun: job["next-run"] ? Number(job["next-run"]) * 1000 : undefined,
  }));
}

export async function saveSchedule(
  client: PveClient,
  input: {
    id?: string;
    node: string;
    vmid?: number;
    all?: boolean;
    storage: string;
    schedule: string;
    mode: string;
    compress: string;
    enabled: boolean;
    comment?: string;
  },
): Promise<string> {
  const params = {
    schedule: input.schedule,
    storage: input.storage,
    mode: input.mode,
    compress: input.compress,
    enabled: input.enabled,
    comment: input.comment,
    node: input.vmid ? input.node : undefined,
    vmid: input.vmid,
    all: input.vmid ? undefined : true,
  };
  if (input.id) {
    await client.put(`/cluster/backup/${enc(input.id)}`, params);
    return input.id;
  }
  await client.post("/cluster/backup", params);
  const jobs = await fetchSchedules(client);
  const newest = jobs
    .filter((job) => job.schedule === input.schedule && job.storage === input.storage)
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
  return newest?.id ?? "";
}

export async function deleteSchedule(client: PveClient, id: string): Promise<void> {
  await client.del(`/cluster/backup/${enc(id)}`);
}

export async function fetchArchives(client: PveClient, schedules: ClusterBackupJob[]): Promise<BackupArchive[]> {
  const nodeList = await fetchNodes(client);
  const storages = new Set<string>();
  for (const job of schedules) if (job.storage) storages.add(job.storage);
  // Also scan any storage that advertises backup content, so archives written by
  // hand or by an old job still show up.
  for (const node of nodeList) {
    try {
      const list = await client.get<Record<string, unknown>[]>(`/nodes/${enc(node.node)}/storage`, {
        content: "backup",
      });
      for (const entry of list ?? []) if (entry.storage) storages.add(String(entry.storage));
    } catch {
      /* node may be offline */
    }
  }

  const results: BackupArchive[] = [];
  for (const node of nodeList) {
    for (const storage of storages) {
      try {
        const content = await client.get<Record<string, unknown>[]>(
          `/nodes/${enc(node.node)}/storage/${enc(storage)}/content`,
          { content: "backup" },
        );
        for (const entry of content ?? []) {
          const volid = String(entry.volid ?? "");
          if (!volid) continue;
          results.push({
            volid,
            storage,
            node: node.node,
            vmid: entry.vmid ? Number(entry.vmid) : guessVmid(volid),
            ctime: entry.ctime ? Number(entry.ctime) * 1000 : undefined,
            size: entry.size ? Number(entry.size) : undefined,
            format: entry.format ? String(entry.format) : undefined,
            protected: entry.protected === 1 || entry.protected === true,
            notes: entry.notes ? String(entry.notes) : undefined,
          });
        }
      } catch {
        /* storage may be inactive or not shared on that node */
      }
    }
  }
  return results.sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0));
}

function guessVmid(volid: string): number | undefined {
  const match = /vzdump-(?:qemu|lxc)-(\d+)-/.exec(volid);
  return match ? Number(match[1]) : undefined;
}

export async function runBackup(
  client: PveClient,
  req: { node: string; vmid?: number; storage?: string; mode?: string; compress?: string; notes?: string; remove?: boolean },
): Promise<string> {
  const data = await client.post<string>(`/nodes/${enc(req.node)}/vzdump`, {
    vmid: req.vmid,
    storage: req.storage,
    mode: req.mode ?? "snapshot",
    compress: req.compress ?? "zstd",
    "notes-template": req.notes,
    remove: req.remove,
    all: req.vmid ? undefined : true,
    quiet: true,
  });
  return typeof data === "string" ? data : "";
}

export async function restoreArchive(
  client: PveClient,
  req: { node: string; vmid: number; archive: string; type: VmType; storage?: string; overwrite?: boolean; unique?: boolean; start?: boolean },
): Promise<string | undefined> {
  if (req.type === "lxc") {
    const data = await client.post<string>(`/nodes/${enc(req.node)}/lxc`, {
      vmid: req.vmid,
      ostemplate: req.archive,
      restore: true,
      force: req.overwrite ? true : undefined,
      unique: req.unique ? true : undefined,
      storage: req.storage,
      start: req.start ? true : undefined,
    });
    return typeof data === "string" ? data : undefined;
  }
  const data = await client.post<string>(`/nodes/${enc(req.node)}/qemu`, {
    vmid: req.vmid,
    archive: req.archive,
    force: req.overwrite ? true : undefined,
    unique: req.unique ? true : undefined,
    storage: req.storage,
  });
  return typeof data === "string" ? data : undefined;
}

export async function deleteArchive(client: PveClient, node: string, storage: string, volid: string): Promise<void> {
  await client.del(`/nodes/${enc(node)}/storage/${enc(storage)}/content/${enc(volid)}`);
}

export type { NodeStats };
