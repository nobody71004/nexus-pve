import type { FleetSnapshot, HostRuntimeStatus, HostTestResult, RrdPoint, TaskSummary, VmDetail } from "../../shared/types";
import type { ConfigStore, StoredHost } from "../config";
import { collectPveNodeGpuTelemetry, collectPveNodeSshTemps } from "../ssh/collect";
import { PveClient, PveError, errorMessage } from "./client";
import {
  deleteArchive,
  deleteSchedule,
  fetchArchives,
  fetchCluster,
  fetchNodeStats,
  fetchNodes,
  fetchResources,
  fetchSchedules,
  fetchTaskLog,
  fetchTasks,
  fetchVersion,
  fetchVmDetail,
  restoreArchive,
  runBackup,
  saveSchedule,
  vmAction,
} from "./api";
import type {
  BackupArchive,
  BackupRunRequest,
  BackupRunResult,
  ClusterBackupJob,
  RestoreRequest,
  ScheduleInput,
  VmAction,
  VmType,
} from "../../shared/types";

const clients = new Map<string, { signature: string; client: PveClient }>();

export function clientFor(host: StoredHost, secret: string | undefined): PveClient {
  if (!secret) throw new Error(`No credential stored for ${host.label}. Edit the host and re-enter its token.`);
  const signature = `${host.baseUrl}|${host.authMode}|${host.tokenId ?? host.username}|${secret}|${host.tlsVerify}`;
  const cached = clients.get(host.id);
  if (cached && cached.signature === signature) return cached.client;
  const client = new PveClient({
    baseUrl: host.baseUrl,
    tlsVerify: host.tlsVerify,
    auth:
      host.authMode === "token"
        ? { mode: "token", tokenId: host.tokenId ?? "", secret }
        : { mode: "password", username: host.username ?? "", secret },
  });
  clients.set(host.id, { signature, client });
  return client;
}

export function dropClient(hostId: string): void {
  clients.delete(hostId);
}

function requireHost(store: ConfigStore, hostId: string): { host: StoredHost; client: PveClient } {
  const host = store.host(hostId);
  if (!host) throw new Error("Unknown host. Re-add the connection.");
  return { host, client: clientFor(host, store.secretFor(hostId)) };
}

/** Shared entry point for the agent tools, which are not part of the collector. */
export function hostClient(store: ConfigStore, hostId: string): PveClient {
  return requireHost(store, hostId).client;
}

const cache = new Map<string, { at: number; snapshot: FleetSnapshot }>();
const inflight = new Map<string, Promise<FleetSnapshot>>();
const CACHE_MS = 2500;
let lastTouch = 0;

export function invalidate(hostId: string): void {
  cache.delete(hostId);
}

export async function collectSnapshot(store: ConfigStore, hostId: string, force = false): Promise<FleetSnapshot> {
  const cached = cache.get(hostId);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.snapshot;
  const running = inflight.get(hostId);
  if (running) return running;

  const task = buildSnapshot(store, hostId)
    .then((snapshot) => {
      cache.set(hostId, { at: Date.now(), snapshot });
      return snapshot;
    })
    .finally(() => inflight.delete(hostId));
  inflight.set(hostId, task);
  return task;
}

async function buildSnapshot(store: ConfigStore, hostId: string): Promise<FleetSnapshot> {
  const { host, client } = requireHost(store, hostId);
  const started = Date.now();
  const errors: string[] = [];

  const [version, cluster] = await Promise.allSettled([fetchVersion(client), fetchCluster(client)]);

  if (version.status === "rejected") {
    const status: HostRuntimeStatus = {
      id: hostId,
      health: "offline",
      error: errorMessage(version.reason),
      checkedAt: Date.now(),
    };
    return {
      host: publicOf(store, hostId),
      status,
      nodes: [],
      vms: [],
      tasks: [],
      schedules: [],
      fetchedAt: Date.now(),
      errors: [errorMessage(version.reason)],
    };
  }

  if (cluster.status === "rejected") errors.push(`cluster status: ${errorMessage(cluster.reason)}`);
  const clusterInfo = cluster.status === "fulfilled" ? cluster.value : undefined;

  let nodeList: Awaited<ReturnType<typeof fetchNodes>> = [];
  try {
    nodeList = await fetchNodes(client);
  } catch (err) {
    errors.push(`nodes: ${errorMessage(err)}`);
  }

  const nodes = await Promise.all(
    nodeList.map(async (summary) => {
      try {
        const stats = await fetchNodeStats(client, summary.node, summary);
        await Promise.all([
          collectPveNodeGpuTelemetry(store, host, stats),
          collectPveNodeSshTemps(store, host, stats),
        ]);
        return stats;
      } catch (err) {
        errors.push(`${summary.node}: ${errorMessage(err)}`);
        return null;
      }
    }),
  );
  const goodNodes = nodes.filter((node): node is NonNullable<typeof node> => node !== null);

  const [resources, schedules] = await Promise.all([
    fetchResources(client).catch((err) => {
      errors.push(`resources: ${errorMessage(err)}`);
      return [] as Awaited<ReturnType<typeof fetchResources>>;
    }),
    fetchSchedules(client).catch((err) => {
      if (!(err instanceof PveError && err.status === 403)) errors.push(`backup schedules: ${errorMessage(err)}`);
      return [] as ClusterBackupJob[];
    }),
  ]);

  const tasks: TaskSummary[] = [];
  const taskLists = await Promise.all(
    nodeList.map((node) => fetchTasks(client, node.node, 8).catch(() => [] as TaskSummary[])),
  );
  for (const list of taskLists) tasks.push(...list);
  tasks.sort((a, b) => b.starttime - a.starttime);

  const vmByNode = new Map<string, { total: number; running: number }>();
  for (const vm of resources) {
    const entry = vmByNode.get(vm.node) ?? { total: 0, running: 0 };
    entry.total += 1;
    if (vm.status === "running") entry.running += 1;
    vmByNode.set(vm.node, entry);
  }
  for (const node of goodNodes) {
    const entry = vmByNode.get(node.node);
    node.vmCount = entry?.total ?? 0;
    node.runningCount = entry?.running ?? 0;
  }

  const latencyMs = Date.now() - started;
  const health: HostRuntimeStatus["health"] = errors.length > 0 ? "degraded" : "online";
  const status: HostRuntimeStatus = {
    id: hostId,
    health,
    latencyMs,
    version: version.value.version,
    clusterName: clusterInfo?.name,
    nodeCount: nodeList.length,
    vmCount: resources.length,
    error: errors[0],
    checkedAt: Date.now(),
  };

  if (version.value.release) status.version = `${version.value.version} (${version.value.release})`;

  if (Date.now() - lastTouch > 60_000) {
    lastTouch = Date.now();
    try {
      store.touchHost(hostId);
    } catch {
      /* a read-only profile is still usable */
    }
  }

  return {
    host: publicOf(store, hostId),
    status,
    version: version.value.version,
    release: version.value.release,
    clusterName: clusterInfo?.name,
    nodes: goodNodes,
    vms: resources,
    tasks,
    schedules,
    fetchedAt: Date.now(),
    errors,
  };
}

function publicOf(store: ConfigStore, hostId: string) {
  const host = store.host(hostId);
  if (!host) throw new Error("Unknown host");
  const { secretEnc: _enc, ...rest } = host;
  return rest;
}

export async function testHost(
  input: { baseUrl: string; authMode: "token" | "password"; tokenId?: string; username?: string; secret?: string; tlsVerify: boolean },
): Promise<HostTestResult> {
  const started = Date.now();
  if (!input.secret) return { ok: false, latencyMs: 0, error: "Enter a token secret or password first." };
  try {
    const client = new PveClient({
      baseUrl: input.baseUrl,
      tlsVerify: input.tlsVerify,
      timeoutMs: 10_000,
      auth:
        input.authMode === "token"
          ? { mode: "token", tokenId: input.tokenId ?? "", secret: input.secret }
          : { mode: "password", username: input.username ?? "", secret: input.secret },
    });
    const [version, cluster, nodes] = await Promise.all([
      fetchVersion(client),
      fetchCluster(client).catch(() => undefined),
      fetchNodes(client).catch(() => []),
    ]);
    return {
      ok: true,
      latencyMs: Date.now() - started,
      version: version.version,
      release: version.release,
      clusterName: cluster?.name,
      nodes: nodes.map((n) => n.node),
      tlsFingerprint: client.tlsFingerprint,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof PveError && err.status === 401 ? "Authentication failed — check the token secret/id." : errorMessage(err),
    };
  }
}

export async function getVmDetail(
  store: ConfigStore,
  hostId: string,
  node: string,
  type: VmType,
  vmid: number,
): Promise<VmDetail> {
  const { client } = requireHost(store, hostId);
  const [snapshot, detail] = await Promise.all([
    collectSnapshot(store, hostId),
    fetchVmDetail(client, node, type, vmid),
  ]);
  const summary = snapshot.vms.find((vm) => vm.vmid === vmid && vm.node === node && vm.type === type);
  if (!summary) throw new Error(`VM ${vmid} not found on ${node}`);
  return { ...summary, ...detail };
}

export async function actOnVm(
  store: ConfigStore,
  hostId: string,
  node: string,
  type: VmType,
  vmid: number,
  action: VmAction,
): Promise<{ upid?: string }> {
  const { client } = requireHost(store, hostId);
  const upid = await vmAction(client, node, type, vmid, action);
  invalidate(hostId);
  return { upid };
}

export async function taskLog(store: ConfigStore, hostId: string, node: string, upid: string): Promise<string[]> {
  const { client } = requireHost(store, hostId);
  return fetchTaskLog(client, node, upid);
}

export async function nodeRrd(
  store: ConfigStore,
  hostId: string,
  node: string,
  timeframe: "hour" | "day" | "week",
): Promise<RrdPoint[]> {
  const { client } = requireHost(store, hostId);
  const raw = await client.get<Record<string, number | string | null>[]>(`/nodes/${encodeURIComponent(node)}/rrddata`, {
    timeframe,
    cf: "AVERAGE",
  });
  return (raw ?? [])
    .map((point) => ({
      t: Number(point.time ?? 0) * 1000,
      cpu: Number(point.cpu ?? 0),
      mem: Number(point.memused ?? 0),
      netin: Number(point.netin ?? 0),
      netout: Number(point.netout ?? 0),
      load: Number(point.loadavg ?? 0),
      iowait: Number(point.iowait ?? 0),
    }))
    .filter((point) => point.t > 0);
}

export async function listArchives(store: ConfigStore, hostId: string): Promise<BackupArchive[]> {
  const { client } = requireHost(store, hostId);
  const schedules = await fetchSchedules(client).catch(() => []);
  return fetchArchives(client, schedules);
}

export async function startBackup(store: ConfigStore, hostId: string, req: BackupRunRequest): Promise<BackupRunResult> {
  const { client } = requireHost(store, hostId);
  const upid = await runBackup(client, req);
  invalidate(hostId);
  return { upid, node: req.node };
}

export async function restore(store: ConfigStore, hostId: string, req: RestoreRequest): Promise<{ upid?: string }> {
  const { client } = requireHost(store, hostId);
  const upid = await restoreArchive(client, req);
  invalidate(hostId);
  return { upid };
}

export async function removeArchive(
  store: ConfigStore,
  hostId: string,
  node: string,
  storage: string,
  volid: string,
): Promise<void> {
  const { client } = requireHost(store, hostId);
  await deleteArchive(client, node, storage, volid);
  invalidate(hostId);
}

export async function persistSchedule(store: ConfigStore, hostId: string, input: ScheduleInput): Promise<{ id: string }> {
  const { client } = requireHost(store, hostId);
  const id = await saveSchedule(client, input);
  invalidate(hostId);
  return { id };
}

export async function removeSchedule(store: ConfigStore, hostId: string, id: string): Promise<void> {
  const { client } = requireHost(store, hostId);
  await deleteSchedule(client, id);
  invalidate(hostId);
}
