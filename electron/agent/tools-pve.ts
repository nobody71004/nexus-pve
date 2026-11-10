import fs from "node:fs/promises";
import path from "node:path";
import type { BackupArchive, FleetSnapshot, NodeStats, VmDetail, VmSummary } from "../../shared/types";
import { incidentsDir } from "../paths";
import {
  actOnVm,
  collectSnapshot,
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
} from "../pve/collect";
import { createSnapshot, deleteSnapshot, fetchSnapshots, rollbackSnapshot } from "../pve/api";
import {
  confirmDestructive,
  optionalNumber,
  requireNumber,
  requireString,
  resolveHostId,
  type ToolContext,
  type ToolRegistry,
} from "./registry";
import type { VmAction, VmType } from "../../shared/types";

const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 1000) / 10 : 0);
const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

function nodeCompact(node: NodeStats) {
  const critical = node.disks.filter((disk) => {
    const health = disk.health.toUpperCase();
    return health && health !== "PASSED" && health !== "UNKNOWN" && health !== "OK";
  });
  const temps = node.sensors.filter((sensor) => /temp/i.test(sensor.unit) || /coretemp|cpu/i.test(sensor.name));
  const maxTemp = temps.length > 0 ? Math.max(...temps.map((sensor) => sensor.value)) : null;
  return {
    node: node.node,
    status: node.status,
    cpuPct: Math.round(node.cpu * 1000) / 10,
    cores: node.cores,
    threads: node.threads,
    sockets: node.sockets,
    cpuModel: node.model,
    memory: { pct: pct(node.memory.used, node.memory.total), usedGB: gb(node.memory.used), totalGB: gb(node.memory.total) },
    swapPct: pct(node.swap.used, node.swap.total),
    rootfsPct: pct(node.rootfs.used, node.rootfs.total),
    loadavg: node.loadavg.map((value) => Math.round(value * 100) / 100),
    uptimeDays: Math.round((node.uptime / 86400) * 10) / 10,
    pveVersion: node.pveVersion,
    vmCount: node.vmCount,
    runningCount: node.runningCount,
    maxTempC: maxTemp,
    storage: node.storages.map((entry) => ({
      name: entry.storage,
      type: entry.type,
      active: entry.active,
      usedPct: pct(entry.used, entry.total),
      freeGB: gb(entry.avail),
      totalGB: gb(entry.total),
    })),
    disksWithHealthWarnings: critical.map((disk) => ({ dev: disk.dev, health: disk.health, wearout: disk.wearout ?? null })),
    gpus: node.gpus,
    gpuError: node.gpuError ?? null,
  };
}

function vmCompact(vm: VmSummary) {
  return {
    vmid: vm.vmid,
    name: vm.name,
    type: vm.type,
    node: vm.node,
    status: vm.status,
    cpuPct: Math.round(vm.cpu * 1000) / 10,
    cpus: vm.cpus,
    memPct: pct(vm.mem, vm.maxmem),
    memGB: gb(vm.mem),
    maxmemGB: gb(vm.maxmem),
    diskGB: gb(vm.disk),
    uptimeHours: Math.round((vm.uptime / 3600) * 10) / 10,
    tags: vm.tags,
    lock: vm.lock ?? null,
    pool: vm.pool ?? null,
    haState: vm.haState ?? null,
    template: vm.template,
  };
}

function overviewOf(snapshot: FleetSnapshot) {
  return {
    host: {
      label: snapshot.host.label,
      url: snapshot.host.baseUrl,
      health: snapshot.status.health,
      latencyMs: snapshot.status.latencyMs ?? null,
      version: snapshot.version ?? null,
      cluster: snapshot.clusterName ?? null,
      checkedAt: new Date(snapshot.fetchedAt).toISOString(),
    },
    nodes: snapshot.nodes.map(nodeCompact),
    vms: {
      total: snapshot.vms.length,
      running: snapshot.vms.filter((vm) => vm.status === "running").length,
      stopped: snapshot.vms.filter((vm) => vm.status !== "running").length,
      templates: snapshot.vms.filter((vm) => vm.template).length,
    },
    activeTasks: snapshot.tasks
      .filter((task) => task.state === "running")
      .map((task) => ({ upid: task.upid, node: task.node, type: task.type, startedAt: new Date(task.starttime).toISOString() })),
    failedTasks: snapshot.tasks
      .filter((task) => task.state === "error")
      .slice(0, 10)
      .map((task) => ({ upid: task.upid, node: task.node, type: task.type, exitstatus: task.exitstatus ?? null })),
    backupSchedules: snapshot.schedules.map((job) => ({
      id: job.id,
      enabled: job.enabled,
      schedule: job.schedule,
      storage: job.storage,
      scope: job.vmid ? `vmid ${job.vmid}` : "all",
      nextRun: job.nextRun ? new Date(job.nextRun).toISOString() : null,
    })),
    errors: snapshot.errors,
  };
}

async function findVm(store: ToolContext["store"], hostId: string, args: Record<string, unknown>) {
  const vmid = requireNumber(args, "vmid");
  const snapshot = await collectSnapshot(store, hostId);
  const vm = snapshot.vms.find((entry) => entry.vmid === vmid && (!args.node || entry.node === args.node));
  if (!vm) throw new Error(`VM ${vmid} not found on host ${snapshot.host.label}`);
  return vm;
}

const hostProp = { type: "string", description: "Host id or label. Required when several hosts are configured." };

export function registerPveTools(registry: ToolRegistry): void {
  registry.register({
    name: "hosts.list",
    title: "List configured Proxmox hosts",
    description: "Returns every configured Proxmox endpoint with its auth mode and last-seen time. Never returns secrets.",
    category: "read",
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      const hosts = ctx.store.hosts();
      if (hosts.length === 0) {
        return { hosts: [], note: "No hosts configured. Add one in the Nexus PVE desktop app (Connections)." };
      }
      return {
        hosts: hosts.map((host) => ({
          id: host.id,
          label: host.label,
          baseUrl: host.baseUrl,
          authMode: host.authMode,
          tlsVerify: host.tlsVerify,
          lastSeenAt: host.lastSeenAt ? new Date(host.lastSeenAt).toISOString() : null,
        })),
      };
    },
  });

  registry.register({
    name: "fleet.overview",
    title: "Fleet overview",
    description:
      "Live health of one Proxmox host: CPU/memory/storage per node, VM counts, running and failed tasks, backup schedules, and partial-failure errors.",
    category: "read",
    inputSchema: { type: "object", properties: { host: hostProp } },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      return overviewOf(await collectSnapshot(ctx.store, hostId));
    },
  });

  registry.register({
    name: "node.detail",
    title: "Node hardware detail",
    description:
      "Full hardware report for one node: CPU model/cores/threads/sockets, memory, swap, rootfs, load, physical disks (model, serial, health, wearout), storage pools, PCI GPUs, NICs, sensors and a 1-hour RRD sample. GPU errors are reported rather than hidden.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: { host: hostProp, node: { type: "string", description: "Node name, e.g. pve" } },
      required: ["node"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const nodeName = requireString(args, "node");
      const snapshot = await collectSnapshot(ctx.store, hostId);
      const node = snapshot.nodes.find((entry) => entry.node === nodeName);
      if (!node) throw new Error(`Node ${nodeName} not found. Nodes: ${snapshot.nodes.map((entry) => entry.node).join(", ")}`);
      return {
        ...nodeCompact(node),
        kernel: node.kernel,
        sockets: node.sockets,
        mhz: node.mhz,
        ksm: node.ksm,
        storage: node.storages,
        disks: node.disks,
        network: node.network,
        sensors: node.sensors,
        rrd: node.rrd.slice(-24).map((point) => ({
          at: new Date(point.t).toISOString(),
          cpuPct: Math.round(point.cpu * 1000) / 10,
          memGB: gb(point.mem),
          netinMbps: Math.round(point.netin * 8 / 1000 / 1000 * 100) / 100,
          netoutMbps: Math.round(point.netout * 8 / 1000 / 1000 * 100) / 100,
          load: point.load,
          iowait: point.iowait,
        })),
        latencyMs: node.latencyMs,
      };
    },
  });

  registry.register({
    name: "node.rrd",
    title: "Node RRD series",
    description: "CPU, memory and network history for a node at hour/day/week resolution.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        host: hostProp,
        node: { type: "string" },
        timeframe: { type: "string", enum: ["hour", "day", "week"] },
      },
      required: ["node"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const nodeName = requireString(args, "node");
      const timeframe = (args.timeframe === "day" || args.timeframe === "week" ? args.timeframe : "hour") as
        | "hour"
        | "day"
        | "week";
      const series = await nodeRrd(ctx.store, hostId, nodeName, timeframe);
      return { node: nodeName, timeframe, points: series.length, series: series.slice(-120) };
    },
  });

  registry.register({
    name: "vms.list",
    title: "List VMs and containers",
    description: "Every VM/CT on the host with live CPU, memory, disk and uptime, optionally filtered by node, status or search text.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        host: hostProp,
        node: { type: "string" },
        status: { type: "string", enum: ["running", "stopped", "paused"] },
        search: { type: "string" },
      },
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const snapshot = await collectSnapshot(ctx.store, hostId);
      const search = typeof args.search === "string" ? args.search.toLowerCase() : "";
      const vms = snapshot.vms.filter((vm) => {
        if (args.node && vm.node !== args.node) return false;
        if (args.status && vm.status !== args.status) return false;
        if (search && !`${vm.name} ${vm.vmid} ${vm.tags.join(" ")}`.toLowerCase().includes(search)) return false;
        return true;
      });
      return { host: snapshot.host.label, count: vms.length, vms: vms.map(vmCompact) };
    },
  });

  registry.register({
    name: "vm.detail",
    title: "VM detail",
    description: "Configuration, guest-agent network interfaces, snapshots and recent tasks for one VM or container.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: { host: hostProp, vmid: { type: "number" }, node: { type: "string" } },
      required: ["vmid"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const vm = await findVm(ctx.store, hostId, args);
      const detail: VmDetail = await getVmDetail(ctx.store, hostId, vm.node, vm.type, vm.vmid);
      const config = Object.fromEntries(
        Object.entries(detail.config).filter(([key]) =>
          /^(name|cores|sockets|memory|balloon|ostype|bootdisk|scsi\d|sata\d|virtio\d|ide\d|net\d|agent|onboot|ostemplate|rootfs|unprivileged)$/.test(
            key,
          ),
        ),
      );
      return {
        ...vmCompact(vm),
        config,
        guestAgent: detail.agentAvailable ? detail.agentNetworks : "not available",
        snapshots: detail.snapshots,
        recentTasks: detail.tasks.slice(0, 8),
      };
    },
  });

  registry.register({
    name: "vm.action",
    title: "VM power action",
    description:
      "Start, gracefully shut down, force stop, reboot, reset, suspend or resume a VM/CT. Stop, reset, reboot and shutdown need confirm:true.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: hostProp,
        vmid: { type: "number" },
        node: { type: "string" },
        action: {
          type: "string",
          enum: ["start", "shutdown", "stop", "reboot", "reset", "suspend", "resume"],
        },
        confirm: { type: "boolean" },
      },
      required: ["vmid", "action"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const vm = await findVm(ctx.store, hostId, args);
      const action = requireString(args, "action") as VmAction;
      const disruptive: VmAction[] = ["stop", "reset", "reboot", "shutdown"];
      if (disruptive.includes(action)) {
        await confirmDestructive(ctx, args, {
          title: `${action} ${vm.type === "lxc" ? "CT" : "VM"} ${vm.vmid} (${vm.name})`,
          tool: "vm.action",
          args: { host: hostId, vmid: vm.vmid, action },
        });
      }
      const result = await actOnVm(ctx.store, hostId, vm.node, vm.type, vm.vmid, action as VmAction);
      return { vmid: vm.vmid, node: vm.node, action, upid: result.upid ?? null, accepted: true };
    },
  });

  registry.register({
    name: "snapshot.list",
    title: "List snapshots",
    description: "Snapshot tree for a VM or container.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: { host: hostProp, vmid: { type: "number" }, node: { type: "string" } },
      required: ["vmid"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const vm = await findVm(ctx.store, hostId, args);
      const snapshots = await fetchSnapshots(hostClient(ctx.store, hostId), vm.node, vm.type, vm.vmid);
      return { vmid: vm.vmid, snapshots };
    },
  });

  registry.register({
    name: "snapshot.create",
    title: "Create snapshot",
    description: "Create a named snapshot (with optional description) on a VM or container.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: hostProp,
        vmid: { type: "number" },
        node: { type: "string" },
        name: { type: "string", description: "Snapshot name, alphanumeric" },
        description: { type: "string" },
      },
      required: ["vmid", "name"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const vm = await findVm(ctx.store, hostId, args);
      const name = requireString(args, "name");
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(name)) {
        throw new Error("Snapshot names must start with a letter and contain only letters, digits, - or _ (max 40).");
      }
      const upid = await createSnapshot(
        hostClient(ctx.store, hostId),
        vm.node,
        vm.type,
        vm.vmid,
        name,
        typeof args.description === "string" ? args.description : undefined,
      );
      invalidate(hostId);
      return { vmid: vm.vmid, snapshot: name, upid: upid ?? null };
    },
  });

  registry.register({
    name: "snapshot.rollback",
    title: "Roll back to snapshot",
    description: "Destroys current VM state and returns to the snapshot. Requires confirm:true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: hostProp,
        vmid: { type: "number" },
        node: { type: "string" },
        name: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["vmid", "name"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const vm = await findVm(ctx.store, hostId, args);
      const name = requireString(args, "name");
      await confirmDestructive(ctx, args, {
        title: `Roll back ${vm.name} (${vm.vmid}) to ${name}`,
        tool: "snapshot.rollback",
        args: { host: hostId, vmid: vm.vmid, name },
      });
      const upid = await rollbackSnapshot(hostClient(ctx.store, hostId), vm.node, vm.type, vm.vmid, name);
      invalidate(hostId);
      return { vmid: vm.vmid, rolledBackTo: name, upid: upid ?? null };
    },
  });

  registry.register({
    name: "snapshot.delete",
    title: "Delete snapshot",
    description: "Delete a snapshot from a VM or container. Requires confirm:true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: hostProp,
        vmid: { type: "number" },
        node: { type: "string" },
        name: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["vmid", "name"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const vm = await findVm(ctx.store, hostId, args);
      const name = requireString(args, "name");
      await confirmDestructive(ctx, args, {
        title: `Delete snapshot ${name} on ${vm.name}`,
        tool: "snapshot.delete",
        args: { host: hostId, vmid: vm.vmid, name },
      });
      await deleteSnapshot(hostClient(ctx.store, hostId), vm.node, vm.type, vm.vmid, name);
      invalidate(hostId);
      return { vmid: vm.vmid, deleted: name };
    },
  });

  registry.register({
    name: "tasks.list",
    title: "Recent tasks",
    description: "Recent Proxmox tasks with state, exit status and UPID for log retrieval.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        host: hostProp,
        state: { type: "string", enum: ["running", "ok", "error"] },
        limit: { type: "number" },
      },
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const snapshot = await collectSnapshot(ctx.store, hostId);
      const limit = Math.min(100, optionalNumber(args, "limit") ?? 25);
      const tasks = snapshot.tasks
        .filter((task) => !args.state || task.state === args.state)
        .slice(0, limit)
        .map((task) => ({
          ...task,
          starttime: new Date(task.starttime).toISOString(),
          endtime: task.endtime ? new Date(task.endtime).toISOString() : null,
        }));
      return { count: tasks.length, tasks };
    },
  });

  registry.register({
    name: "task.log",
    title: "Task log",
    description: "Log lines for a Proxmox task UPID (vzdump progress, start/stop results, failures).",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        host: hostProp,
        node: { type: "string" },
        upid: { type: "string" },
        tail: { type: "number" },
      },
      required: ["node", "upid"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const node = requireString(args, "node");
      const upid = requireString(args, "upid");
      const lines = await taskLog(ctx.store, hostId, node, upid);
      const tail = Math.min(400, optionalNumber(args, "tail") ?? 80);
      return { upid, lines: lines.slice(-tail) };
    },
  });

  registry.register({
    name: "backup.list",
    title: "List backup archives",
    description: "All vzdump archives across backup-capable storages, newest first, plus scheduled backup jobs.",
    category: "read",
    inputSchema: { type: "object", properties: { host: hostProp, vmid: { type: "number" } } },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const [archives, snapshot] = await Promise.all([
        listArchives(ctx.store, hostId),
        collectSnapshot(ctx.store, hostId),
      ]);
      const vmid = optionalNumber(args, "vmid");
      const filtered: BackupArchive[] = vmid ? archives.filter((archive) => archive.vmid === vmid) : archives;
      return {
        host: snapshot.host.label,
        count: filtered.length,
        totalGB: Math.round(filtered.reduce((sum, archive) => sum + (archive.size ?? 0), 0) / 1024 ** 3),
        archives: filtered.map((archive) => ({
          ...archive,
          ctime: archive.ctime ? new Date(archive.ctime).toISOString() : null,
          sizeGB: archive.size ? gb(archive.size) : null,
        })),
        schedules: snapshot.schedules,
      };
    },
  });

  registry.register({
    name: "backup.run",
    title: "Run backup now",
    description:
      "Start a vzdump backup of one VM/CT (or all guests on a node). Returns the UPID; poll task.log until it finishes.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: hostProp,
        node: { type: "string" },
        vmid: { type: "number", description: "Omit to back up every guest on the node" },
        storage: { type: "string" },
        mode: { type: "string", enum: ["snapshot", "suspend", "stop"] },
        compress: { type: "string", enum: ["zstd", "gzip", "lzo", "0"] },
        notes: { type: "string" },
      },
      required: ["node"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const node = requireString(args, "node");
      const vmid = optionalNumber(args, "vmid");
      const result = await startBackup(ctx.store, hostId, {
        node,
        vmid,
        storage: typeof args.storage === "string" ? args.storage : undefined,
        mode: (args.mode as "snapshot" | "suspend" | "stop") ?? "snapshot",
        compress: (args.compress as "0" | "zstd" | "gzip" | "lzo") ?? "zstd",
        notes: typeof args.notes === "string" ? args.notes : undefined,
      });
      return { ...result, startedAt: new Date().toISOString() };
    },
  });

  registry.register({
    name: "backup.restore",
    title: "Restore backup archive",
    description:
      "Restore a vzdump archive into a VM/CT id. Overwrite destroys the existing guest at that id. Requires confirm:true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: hostProp,
        node: { type: "string" },
        vmid: { type: "number" },
        archive: { type: "string", description: "Volume id, e.g. local:backup/vzdump-qemu-100-....vma.zst" },
        type: { type: "string", enum: ["qemu", "lxc"] },
        storage: { type: "string" },
        overwrite: { type: "boolean" },
        start: { type: "boolean" },
        confirm: { type: "boolean" },
      },
      required: ["node", "vmid", "archive"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const node = requireString(args, "node");
      const vmid = requireNumber(args, "vmid");
      const archive = requireString(args, "archive");
      const type = (args.type === "lxc" ? "lxc" : "qemu") as VmType;
      const overwrite = args.overwrite === true;
      await confirmDestructive(ctx, args, {
        title: `Restore ${type} ${vmid} from ${archive}${overwrite ? " (OVERWRITE)" : ""}`,
        tool: "backup.restore",
        args: { host: hostId, node, vmid, archive, overwrite },
      });
      const result = await restore(ctx.store, hostId, {
        node,
        vmid,
        archive,
        type,
        storage: typeof args.storage === "string" ? args.storage : undefined,
        overwrite,
        start: args.start === true,
      });
      return { vmid, archive, upid: result.upid ?? null };
    },
  });

  registry.register({
    name: "backup.remove",
    title: "Delete backup archive",
    description: "Permanently delete a vzdump archive from storage. Requires confirm:true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: hostProp,
        node: { type: "string" },
        storage: { type: "string" },
        volid: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["node", "storage", "volid"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const node = requireString(args, "node");
      const storage = requireString(args, "storage");
      const volid = requireString(args, "volid");
      await confirmDestructive(ctx, args, {
        title: `Delete archive ${volid}`,
        tool: "backup.remove",
        args: { host: hostId, node, storage, volid },
      });
      await removeArchive(ctx.store, hostId, node, storage, volid);
      return { deleted: volid };
    },
  });

  registry.register({
    name: "backup.schedule.save",
    title: "Create or update a backup schedule",
    description:
      "Native Proxmox scheduled backup (cluster backup job): cron schedule, target storage, mode, compression and scope.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: hostProp,
        id: { type: "string", description: "Existing job id to update" },
        node: { type: "string" },
        vmid: { type: "number" },
        storage: { type: "string" },
        schedule: { type: "string", description: "systemd calendar, e.g. 02:30 or sat 03:00" },
        mode: { type: "string", enum: ["snapshot", "suspend", "stop"] },
        compress: { type: "string", enum: ["zstd", "gzip", "lzo", "0"] },
        enabled: { type: "boolean" },
        comment: { type: "string" },
      },
      required: ["node", "storage", "schedule"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const input = {
        id: typeof args.id === "string" && args.id ? args.id : undefined,
        node: requireString(args, "node"),
        vmid: optionalNumber(args, "vmid"),
        storage: requireString(args, "storage"),
        schedule: requireString(args, "schedule"),
        mode: ((args.mode as string) ?? "snapshot") as "snapshot" | "suspend" | "stop",
        compress: ((args.compress as string) ?? "zstd") as "0" | "zstd" | "gzip" | "lzo",
        enabled: args.enabled !== false,
        comment: typeof args.comment === "string" ? args.comment : undefined,
      };
      const result = await persistSchedule(ctx.store, hostId, input);
      return { ...result, schedule: input.schedule, storage: input.storage, scope: input.vmid ?? "all" };
    },
  });

  registry.register({
    name: "backup.schedule.delete",
    title: "Delete a backup schedule",
    description: "Delete a Proxmox cluster backup job. Requires confirm:true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: { host: hostProp, id: { type: "string" }, confirm: { type: "boolean" } },
      required: ["id"],
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const id = requireString(args, "id");
      await confirmDestructive(ctx, args, {
        title: `Delete backup schedule ${id}`,
        tool: "backup.schedule.delete",
        args: { host: hostId, id },
      });
      await removeSchedule(ctx.store, hostId, id);
      return { deleted: id };
    },
  });

  registry.register({
    name: "incident.bundle",
    title: "Capture an incident bundle",
    description:
      "Write a timestamped JSON evidence bundle (node hardware, VM inventory, tasks, schedules, optional VM configs) into the Nexus incidents folder. Read-only against Proxmox.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        host: hostProp,
        note: { type: "string", description: "Why the bundle is being captured" },
        includeVmConfigs: { type: "boolean" },
      },
    },
    async run(args, ctx) {
      const hostId = resolveHostId(args, ctx);
      const snapshot = await collectSnapshot(ctx.store, hostId, true);
      const includeConfigs = args.includeVmConfigs !== false;
      const configs: Record<string, unknown> = {};
      if (includeConfigs) {
        const client = hostClient(ctx.store, hostId);
        await Promise.all(
          snapshot.vms.slice(0, 40).map(async (vm) => {
            try {
              configs[`${vm.node}/${vm.vmid}`] = await client.get(`/nodes/${vm.node}/${vm.type}/${vm.vmid}/config`);
            } catch (err) {
              configs[`${vm.node}/${vm.vmid}`] = { error: String(err) };
            }
          }),
        );
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeHost = snapshot.host.label.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const file = path.join(incidentsDir(), `${stamp}-${safeHost}.json`);
      await fs.mkdir(incidentsDir(), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        file,
        JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            note: typeof args.note === "string" ? args.note : undefined,
            snapshot,
            vmConfigs: configs,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      return {
        file,
        nodes: snapshot.nodes.length,
        vms: snapshot.vms.length,
        errors: snapshot.errors,
        note: includeConfigs ? `configs captured for up to 40 guests` : "guest configs omitted",
      };
    },
  });
}

