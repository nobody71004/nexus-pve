import type { ToolContext, ToolRegistry } from "./registry";
import { confirmDestructive, optionalNumber, requireString } from "./registry";
import { collectSshSnapshot, execOnHost, listSshHosts, sshRunner } from "../ssh/collect";
import { runRemote } from "../ssh/probe";
import { actOnSshHost, runSpeedTest, runSpeedTestAll } from "../ssh/actions";
import { checkHelper, installHelper } from "../ssh/helper";

function resolveSshHost(ctx: ToolContext, args: Record<string, unknown>): string {
  const requested = typeof args.host === "string" && args.host.trim() ? args.host.trim() : undefined;
  const hosts = ctx.store.sshHosts();
  if (hosts.length === 0) throw new Error("No Linux hosts configured. Add one in Nexus PVE → Linux hosts.");
  if (requested) {
    const match = ctx.store.sshHost(requested);
    if (!match) {
      throw new Error(`No Linux host matches "${requested}". Configured: ${hosts.map((host) => host.label).join(", ")}`);
    }
    return match.id;
  }
  if (hosts.length === 1) return hosts[0].id;
  throw new Error(`Several Linux hosts are configured; pass "host". Options: ${hosts.map((host) => host.label).join(", ")}`);
}

export function registerSshTools(registry: ToolRegistry): void {
  registry.register({
    name: "ssh.hosts",
    title: "List Linux hosts",
    description:
      "List the plain Linux hosts (VPS or VM guests) reachable over SSH, with user, address, key path and last-seen time.",
    category: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      return {
        count: ctx.store.sshHosts().length,
        hosts: listSshHosts(ctx.store).map((host) => ({
          id: host.id,
          label: host.label,
          target: `${host.username}@${host.host}:${host.port}`,
          keyPath: host.keyPath ?? "(ssh agent / default keys)",
          lastSeenAt: host.lastSeenAt ? new Date(host.lastSeenAt).toISOString() : null,
        })),
      };
    },
  });

  registry.register({
    name: "ssh.status",
    title: "Linux host telemetry",
    description:
      "Read live hardware and service telemetry from a Linux host over SSH: CPU model/topology, memory, physical block devices, filesystems, NIC link details and counters, temperatures, GPU utilization/temperature/VRAM/power/fan/clocks/processes, failed units, containers, top processes and SSH auth history. Read-only.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string", description: "Host label, address or id. Optional with one host." } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const snapshot = await collectSshSnapshot(ctx.store, id);
      if (snapshot.status.health !== "online") {
        throw new Error(`${snapshot.host.label}: ${snapshot.status.error ?? "unreachable"}`);
      }
      return {
        host: snapshot.host.label,
        target: `${snapshot.host.username}@${snapshot.host.host}:${snapshot.host.port}`,
        latencyMs: snapshot.status.latencyMs,
        identity: {
          ...snapshot.identity,
          uptimeHours: Math.round((snapshot.identity.uptime / 3600) * 10) / 10,
        },
        cpu: {
          model: snapshot.cpu.model,
          cores: snapshot.cpu.cores,
          physicalCores: snapshot.cpu.physicalCores ?? null,
          sockets: snapshot.cpu.sockets ?? null,
          threads: snapshot.cpu.cores,
          usagePct: Math.round(snapshot.cpu.usage * 10) / 10,
          load: snapshot.cpu.load,
          mhz: snapshot.cpu.mhz,
        },
        memory: {
          totalGB: Math.round((snapshot.memory.total / 1024 ** 3) * 10) / 10,
          usedGB: Math.round((snapshot.memory.used / 1024 ** 3) * 10) / 10,
          swapUsedGB: Math.round((snapshot.memory.swapUsed / 1024 ** 3) * 10) / 10,
        },
        disks: snapshot.disks.map((disk) => ({
          mount: disk.mount,
          fs: disk.fs,
          sizeGB: Math.round((disk.size / 1024 ** 3) * 10) / 10,
          usedPct: disk.size > 0 ? Math.round((disk.used / disk.size) * 1000) / 10 : 0,
        })),
        blockDevices: snapshot.blockDevices,
        nics: snapshot.nics,
        temps: snapshot.temps,
        gpus: snapshot.gpus,
        gpuError: snapshot.gpuError ?? null,
        failedUnits: snapshot.services.filter((service) => service.state === "failed").map((service) => service.name),
        containers: snapshot.containers,
        topProcesses: snapshot.processes.slice(0, 5),
        security: snapshot.security,
        samples: snapshot.samples.slice(-12),
      };
    },
  });

  registry.register({
    name: "ssh.journal",
    title: "Read a systemd journal slice",
    description:
      "Read the last N journal lines for a unit or the whole system on a Linux host. Use for incident triage: ssh, nginx, docker, kernel. Read-only.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        unit: { type: "string", description: "systemd unit, e.g. ssh or nginx. Omit for the full journal." },
        lines: { type: "number", description: "How many lines (max 400, default 120)." },
        since: { type: "string", description: "journalctl --since value, e.g. '24 hours ago'." },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const unit = typeof args.unit === "string" && args.unit.trim() ? args.unit.trim() : undefined;
      if (unit && !/^[A-Za-z0-9@._-]+$/.test(unit)) throw new Error("unit must be a plain systemd unit name");
      const count = Math.min(400, Math.max(1, optionalNumber(args, "lines") ?? 120));
      const since = typeof args.since === "string" && args.since.trim() ? args.since.trim() : "24 hours ago";
      const host = ctx.store.sshHost(id)!;
      const parts = ["journalctl --no-pager -n " + count];
      if (unit) parts.push("-u " + unit);
      parts.push("--since '" + since.replace(/'/g, "") + "'");
      const result = await runRemote(sshRunner(ctx.store, id, 30_000), parts.join(" ") + "\n", "bash");
      return {
        host: host.label,
        ok: result.ok,
        unit: unit ?? "(system)",
        lines: result.stdout.split(/\r?\n/).filter(Boolean).slice(-count),
        error: result.ok ? undefined : result.stderr.trim().slice(0, 800),
      };
    },
  });

  registry.register({
    name: "ssh.speedtest",
    title: "Measure host throughput",
    description:
      "Run a download/upload/latency test on one Linux host or every configured host. Reports Mbps and connect latency. Read-only; nothing is installed remotely.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Host label. Omit to test every configured host." },
        all: { type: "boolean", description: "Test every host in parallel." },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (args.all === true) return { results: await runSpeedTestAll(ctx.store) };
      const id = resolveSshHost(ctx, args);
      return runSpeedTest(ctx.store, id);
    },
  });

  registry.register({
    name: "ssh.power",
    title: "Reboot or shut down a host",
    description:
      "Reboot or power off a Linux host over SSH. Destructive and gated: requires confirm:true. Uses sudo when the login user is not root.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        action: { type: "string", description: "reboot or shutdown" },
        confirm: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const action = requireString(args, "action");
      if (action !== "reboot" && action !== "shutdown") throw new Error('action must be "reboot" or "shutdown"');
      await confirmDestructive(ctx, args, {
        title: `${action} ${ctx.store.sshHost(id)?.label}`,
        tool: "ssh.power",
        args: { action },
      });
      return actOnSshHost(ctx.store, id, action);
    },
  });

  registry.register({
    name: "ssh.service",
    title: "Control a systemd unit",
    description:
      "Start, stop or restart a systemd service on a Linux host. Destructive and gated: requires confirm:true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        unit: { type: "string", description: "systemd unit, e.g. nginx" },
        action: { type: "string", description: "restart, start or stop" },
        confirm: { type: "boolean" },
      },
      required: ["unit", "action"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const unit = requireString(args, "unit");
      const action = requireString(args, "action");
      const mapped = action === "start" ? "start-service" : action === "stop" ? "stop-service" : action === "restart" ? "restart-service" : null;
      if (!mapped) throw new Error('action must be "start", "stop" or "restart"');
      await confirmDestructive(ctx, args, {
        title: `${action} ${unit} on ${ctx.store.sshHost(id)?.label}`,
        tool: "ssh.service",
        args: { unit, action },
      });
      return actOnSshHost(ctx.store, id, mapped as "restart-service", unit);
    },
  });

  registry.register({
    name: "ssh.backup",
    title: "Back up a host's config and data",
    description:
      "Create a timestamped tar.gz on a Linux host under /var/backups/nexus and keep the three newest per host. Defaults to /etc and /home; pass paths to narrow or extend it. Gated: requires confirm:true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        paths: { type: "string", description: "Space or comma separated absolute paths, e.g. '/etc /opt/app'." },
        confirm: { type: "boolean" },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const paths = typeof args.paths === "string" ? args.paths.trim() : "";
      await confirmDestructive(ctx, args, {
        title: `Back up ${ctx.store.sshHost(id)?.label}${paths ? ` (${paths})` : " (/etc /home)"}`,
        tool: "ssh.backup",
        args: { paths },
      });
      return actOnSshHost(ctx.store, id, "backup", paths || undefined);
    },
  });

  registry.register({
    name: "ssh.helper",
    title: "Privileged helper readiness",
    description:
      "Check whether the root helper /usr/local/sbin/nexus-priv and its sudoers drop-in are installed, current and usable on a Linux host, and which route (root, NOPASSWD, stored password) the app would use to install them. Read-only.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string" } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      return checkHelper(ctx.store, ctx.appRoot, resolveSshHost(ctx, args));
    },
  });

  registry.register({
    name: "ssh.helper.install",
    title: "Install the privileged helper",
    description:
      "Install /usr/local/sbin/nexus-priv and /etc/sudoers.d/nexus-actions on a Linux host so service, power, backup and guard subcommands work without a password prompt. Writes root-owned files and validates the sudoers drop-in with visudo before installing it. Gated: requires confirm:true. Refuses a host with no root route.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        confirm: { type: "boolean" },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      await confirmDestructive(ctx, args, {
        title: `Install the privileged helper on ${ctx.store.sshHost(id)?.label}`,
        tool: "ssh.helper.install",
        args: { host: id },
      });
      return installHelper(ctx.store, ctx.appRoot, id, undefined, { trigger: "manual" });
    },
  });

  registry.register({
    name: "ssh.exec",
    title: "Run a command over SSH",
    description:
      "Execute a command on a Linux host over SSH and return stdout/stderr. Destructive: requires confirm:true. Set shell:true only when the command genuinely needs pipes or redirection.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        command: { type: "string" },
        shell: { type: "boolean" },
        confirm: { type: "boolean" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const command = requireString(args, "command");
      await confirmDestructive(ctx, args, {
        title: `Run on ${ctx.store.sshHost(id)?.label}: ${command.slice(0, 60)}`,
        tool: "ssh.exec",
        args: { command },
      });
      return execOnHost(ctx.store, id, command, { allowShell: args.shell === true });
    },
  });
}
