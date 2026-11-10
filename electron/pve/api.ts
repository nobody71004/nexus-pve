import { PveClient, enc } from "./client";
import type {
  AgentNic,
  BackupArchive,
  ClusterBackupJob,
  DiskInfo,
  GpuInfo,
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
  /** PVE-mods injects `sensors -j` into the node status as a JSON string. */
  sensorsOutput?: unknown;
  thermalstate?: unknown;
  PveMod_JsonSensorInfo?: unknown;
  sensors?: unknown;
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
  const [status, rrd, storages, disks, network, legacySensors, cpuSensors, pci] = await Promise.allSettled([
    client.get<RawNodeStatus>(`/nodes/${enc(node)}/status`),
    client.get<Record<string, number | string | null>[]>(`/nodes/${enc(node)}/rrddata`, {
      timeframe: "hour",
      cf: "AVERAGE",
    }),
    client.get<Record<string, unknown>[]>(`/nodes/${enc(node)}/storage`),
    client.get<Record<string, unknown>[]>(`/nodes/${enc(node)}/disks/list`),
    client.get<Record<string, unknown>[]>(`/nodes/${enc(node)}/network`),
    // Some sensor forks expose a dedicated endpoint; stock PVE does not.
    client.get<unknown>(`/nodes/${enc(node)}/sensors`),
    // PVE 9 native hardware sensors (Sys.Audit).
    client.get<unknown>(`/nodes/${enc(node)}/hardware/sensors/temperature/cpu`),
    client.get<Record<string, unknown>[]>(`/nodes/${enc(node)}/hardware/pci`, { verbose: 1 }),
  ]);

  const value = <T,>(result: PromiseSettledResult<T>, fallback: T): T =>
    result.status === "fulfilled" ? result.value : fallback;

  const s = value(status, {} as RawNodeStatus);
  const points = value(rrd, [] as Record<string, number | string | null>[]);

  // A node can be online in /nodes while its status endpoint is denied; fall
  // back to the cluster view so the console still shows something truthful.
  const memoryTotal = s.memory?.total ?? summary?.maxmem ?? 0;
  const memoryUsed = s.memory?.used ?? summary?.mem ?? 0;
  const reportedCores = Number(s.cpuinfo?.cores ?? summary?.maxcpu ?? 1);
  const cores = Number.isFinite(reportedCores) && reportedCores > 0 ? Math.round(reportedCores) : 1;
  const reportedThreads = Number(s.cpuinfo?.cpus ?? summary?.maxcpu ?? cores);
  const threads = Number.isFinite(reportedThreads) && reportedThreads >= cores ? Math.round(reportedThreads) : cores;
  const reportedSockets = Number(s.cpuinfo?.sockets ?? 1);
  const sockets = Number.isFinite(reportedSockets) && reportedSockets > 0 ? Math.round(reportedSockets) : 1;
  const gpus = pci.status === "fulfilled" ? value(pci, []).map(normalizeGpu).filter((gpu) => gpu !== null) : [];
  const gpuError =
    pci.status === "rejected"
      ? `PCI inventory unavailable: ${pci.reason instanceof Error ? pci.reason.message : String(pci.reason)}`
      : undefined;

  return {
    node,
    status: summary?.status ?? "unknown",
    uptime: s.uptime ?? summary?.uptime ?? 0,
    cpu: summary?.cpu ?? 0,
    cores,
    threads,
    sockets,
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
    gpus,
    ...(gpuError ? { gpuError } : {}),
    gpuTelemetry: [],
    network: value(network, []).map(normalizeNic),
    sensors: mergeSensors([
      ...flattenSensors(value(legacySensors, null)),
      ...flattenSensors(value(cpuSensors, null)),
      // PVE-mods writes lm-sensors JSON into the node status instead of a
      // dedicated endpoint, under one of these field names depending on fork.
      ...flattenSensors(s.sensorsOutput),
      ...flattenSensors(s.thermalstate),
      ...flattenSensors(s.PveMod_JsonSensorInfo),
      ...flattenSensors(s.sensors),
    ]),
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

const GPU_CLASS_IDS = new Set(["030000", "030200", "038000"]);

/** PVE returns PCI classes as hex ids plus human-readable names, depending on version. */
function normalizeGpu(raw: Record<string, unknown>): GpuInfo | null {
  const classId = String(raw.class ?? raw.classid ?? "").toLowerCase().replace(/^0x/, "");
  const className = String(raw.class_name ?? raw.classname ?? raw.class ?? "");
  const isGpu = GPU_CLASS_IDS.has(classId) || /vga|3d controller|display controller/i.test(className);
  if (!isGpu) return null;
  const vendor = String(raw.vendor_name ?? raw.vendorname ?? raw.vendor ?? "") || "Unknown vendor";
  const device = String(raw.device_name ?? raw.devicename ?? raw.device ?? "") || "Display controller";
  const iommu = Number(raw.iommugroup ?? raw.iommu_group);
  return {
    name: `${vendor} ${device}`.replace(/\s+/g, " ").trim(),
    vendor,
    device,
    pci: String(raw.id ?? raw.pci ?? ""),
    className,
    ...(Number.isFinite(iommu) && iommu >= 0 ? { iommuGroup: iommu } : {}),
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

const TEMP_INPUT_KEY = /^temp\d+_input$/i;
const TEMP_META_KEY = /^temp\d+_(?:max|min|crit|crit_alarm|alarm|lcrit|emergency|offset)$/i;
const DIRECT_VALUE_KEYS = ["value", "temperature", "reading", "temp", "celsius", "temp1_input"] as const;

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = /-?\d+(?:\.\d+)?/.exec(value);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanSensorName(raw: string): string {
  return raw.replace(/^.*\//, "").replace(/\s+/g, " ").trim().slice(0, 64) || "sensor";
}

function normalizeUnit(unit: unknown, name: string): string {
  const raw = typeof unit === "string" ? unit.trim() : "";
  if (!raw) return /temp|package|tctl|tdie|core|cpu|thermal/i.test(name) ? "°C" : "";
  if (/^(?:c|celsius|degrees?\s*c(?:elsius)?|°c)$/i.test(raw)) return "°C";
  if (/^(?:f|fahrenheit|degrees?\s*f(?:ahrenheit)?|°f)$/i.test(raw)) return "°F";
  return raw;
}

function readDirectSensor(record: Record<string, unknown>, fallbackName: string): SensorReading | null {
  for (const key of DIRECT_VALUE_KEYS) {
    if (!(key in record)) continue;
    const numeric = parseNumber(record[key]);
    if (numeric === null) continue;
    const name = cleanSensorName(String((record.name ?? record.label ?? record.sensor ?? fallbackName) || "sensor"));
    return { name, value: numeric, unit: normalizeUnit(record.unit, name) };
  }
  return null;
}

function tryParseJson(text: string): unknown {
  let current: unknown = text;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (typeof current !== "string") return current;
    try {
      current = JSON.parse(current);
    } catch {
      return undefined;
    }
  }
  return current;
}

/** Plain `sensors` output, e.g. "Package id 0:  +45.0°C  (high = +80.0°C)". */
function collectPlainSensorText(text: string, out: SensorReading[]): void {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([^:]{2,48}):\s*\+?(-?\d+(?:\.\d+)?)\s*°\s*C\b/i.exec(line.trim());
    if (!match) continue;
    const name = cleanSensorName(match[1]);
    if (!/temp|package|tctl|tdie|core|cpu|thermal/i.test(name)) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < -40 || value > 200) continue;
    out.push({ name, value, unit: "°C" });
  }
}

/**
 * Proxmox sensor payloads are not uniform: nested `sensors -j` objects,
 * `{name,value,unit}` arrays, PVE 9 `{sensor,temperature,unit}` arrays, or a
 * JSON string embedded in /status. Walk all of them without inventing values.
 */
function collectSensors(raw: unknown, path: string[], out: SensorReading[], depth = 0): void {
  if (raw === null || raw === undefined || depth > 8) return;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return;
    if (text.startsWith("{") || text.startsWith("[")) {
      const parsed = tryParseJson(text);
      if (parsed !== undefined) collectSensors(parsed, path, out, depth + 1);
      return;
    }
    collectPlainSensorText(text, out);
    return;
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) collectSensors(entry, path, out, depth + 1);
    return;
  }
  if (typeof raw !== "object") return;

  const record = raw as Record<string, unknown>;
  const direct = readDirectSensor(record, path[path.length - 1] ?? "");
  if (direct) {
    out.push(direct);
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    if (TEMP_META_KEY.test(key)) continue;
    if (TEMP_INPUT_KEY.test(key)) {
      const numeric = parseNumber(child);
      if (numeric === null) continue;
      const name = cleanSensorName(path[path.length - 1] || "sensor");
      out.push({ name, value: numeric, unit: "°C" });
      continue;
    }
    collectSensors(child, [...path, key], out, depth + 1);
  }
}

function sensorRank(reading: SensorReading): number {
  const name = reading.name.toLowerCase();
  if (/package|socket|pkg/.test(name)) return 0;
  if (/tctl|tdie/.test(name)) return 1;
  if (/cpu|core|k10temp|coretemp|peci|tccd|soc/.test(name)) return 2;
  if (/°c|celsius|temp|thermal|nvme|composite|acpitz/.test(`${reading.unit} ${name}`.toLowerCase())) return 3;
  return 4;
}

function mergeSensors(readings: SensorReading[]): SensorReading[] {
  const seen = new Set<string>();
  const merged: SensorReading[] = [];
  for (const reading of readings) {
    if (!reading || !Number.isFinite(reading.value)) continue;
    if (reading.value < -1000 || reading.value > 100000) continue;
    const key = `${reading.name.toLowerCase()}|${reading.unit}|${reading.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(reading);
  }
  return merged.sort((a, b) => sensorRank(a) - sensorRank(b) || b.value - a.value).slice(0, 32);
}

function flattenSensors(raw: unknown): SensorReading[] {
  const readings: SensorReading[] = [];
  collectSensors(raw, [], readings);
  return mergeSensors(readings);
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
