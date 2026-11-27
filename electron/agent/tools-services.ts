import type { ToolRegistry } from "./registry";
import { confirmDestructive, optionalNumber, requireString } from "./registry";
import { resolveSshHost } from "./tools-ssh";
import {
  controlService,
  createService,
  dockerAction,
  installService,
  listServices,
  packageAction,
  removeService,
  serviceLogs,
  serviceStatus,
  type DockerAction,
  type PackageAction,
  type ServiceAction,
} from "../ssh/services";

const SERVICE_ACTIONS: ServiceAction[] = ["start", "stop", "restart", "enable", "disable"];
const PACKAGE_ACTIONS: PackageAction[] = ["install", "remove", "update", "upgrade"];

function packageList(args: Record<string, unknown>): string[] {
  const raw = args.packages ?? args.package;
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
  }
  throw new Error('"package" is required (one name or a comma separated list)');
}

function envMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
  }
  if (typeof value === "string") {
    const out: Record<string, string> = {};
    for (const pair of value.split(/[\n,]+/)) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const index = trimmed.indexOf("=");
      if (index < 1) throw new Error(`environment entry "${trimmed}" is not KEY=VALUE`);
      out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  throw new Error('"env" must be an object or a KEY=VALUE list');
}

/**
 * Service install and lifecycle across the Linux fleet.
 *
 * These tools are the difference between "restart something that exists" and
 * "install and run something that does not": package install, unit authoring,
 * journal reads and docker compose projects. Every mutation is gated and every
 * privileged step runs through the host's nexus-priv helper.
 */
export function registerServiceTools(registry: ToolRegistry): void {
  registry.register({
    name: "ssh.services",
    title: "List services on a Linux host",
    description:
      "Inventory of a Linux host's services: systemd units with active/enabled state, failed units, docker containers (" +
      "when docker is installed) and docker compose projects under /opt/nexus. Read-only, no sudo. Use state:\"all\" to see " +
      "inactive and disabled units, or filter by name.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Host label, address or id. Optional with one host." },
        state: { type: "string", description: "running (default), failed or all" },
        filter: { type: "string", description: "Case-insensitive match on unit name or description" },
        limit: { type: "number", description: "Max units to return (default 200, max 600)" },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const state = typeof args.state === "string" ? args.state.trim() : "running";
      if (!["running", "failed", "all"].includes(state)) {
        throw new Error('"state" must be running, failed or all');
      }
      return listServices(ctx.store, id, {
        state: state as "running" | "failed" | "all",
        filter: typeof args.filter === "string" ? args.filter : undefined,
        limit: optionalNumber(args, "limit"),
      });
    },
  });

  registry.register({
    name: "ssh.service.status",
    title: "Inspect one systemd unit",
    description:
      "Full state of one systemd unit on a Linux host: ActiveState, UnitFileState, main PID, restart count, memory, start " +
      "time, the last 15 journal lines and the unit file itself. Read-only.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        unit: { type: "string", description: "Unit name, e.g. nginx.service or nginx" },
      },
      required: ["unit"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      return serviceStatus(ctx.store, id, requireString(args, "unit"));
    },
  });

  registry.register({
    name: "ssh.service.logs",
    title: "Read a service journal",
    description:
      "Read the journal for one systemd unit (default 80 lines, max 500). Falls back to the privileged helper when the " +
      "login account cannot read the system journal. Read-only.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        unit: { type: "string" },
        lines: { type: "number", description: "How many lines (default 80, max 500)" },
      },
      required: ["unit"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      return serviceLogs(ctx.store, id, requireString(args, "unit"), optionalNumber(args, "lines") ?? 80);
    },
  });

  registry.register({
    name: "ssh.service.control",
    title: "Start, stop, restart, enable or disable a service",
    description:
      "Change the runtime and boot state of an existing systemd unit on a Linux host. Gated: requires confirm:true. " +
      "Reports the resulting active and enabled state, so a unit that fails to come up is visible, not assumed.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        unit: { type: "string" },
        action: { type: "string", description: "start, stop, restart, enable or disable" },
        confirm: { type: "boolean" },
      },
      required: ["unit", "action"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const unit = requireString(args, "unit");
      const action = requireString(args, "action") as ServiceAction;
      if (!SERVICE_ACTIONS.includes(action)) {
        throw new Error(`"action" must be one of ${SERVICE_ACTIONS.join(", ")}`);
      }
      const host = ctx.store.sshHost(id);
      if (args.confirm !== true) {
        await confirmDestructive(ctx, args, {
          title: `${action} ${unit} on ${host?.label}`,
          tool: "ssh.service.control",
          args: { unit, action },
        });
      }
      return controlService(ctx.store, id, unit, action);
    },
  });

  registry.register({
    name: "ssh.service.install",
    title: "Install a service from a package",
    description:
      "Install one or more apt packages on a Linux host, then enable and start the systemd unit they ship. Use this to " +
      "install a service that is not on the host yet (nginx, redis, postgresql, docker.io, ...). Gated: requires " +
      "confirm:true. Pass \"unit\" when the unit name differs from the package name; when no unit matches, the package is " +
      "still installed and the result says so instead of claiming a running service.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        package: { type: "string", description: "Package name, or a comma separated list" },
        unit: { type: "string", description: "Unit to enable/start (defaults to <package>.service)" },
        enable: { type: "boolean", description: "Enable at boot (default true)" },
        start: { type: "boolean", description: "Start now (default true)" },
        confirm: { type: "boolean" },
      },
      required: ["package"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const packages = packageList(args);
      const host = ctx.store.sshHost(id);
      if (args.confirm !== true) {
        await confirmDestructive(ctx, args, {
          title: `Install ${packages.join(", ")} on ${host?.label}`,
          tool: "ssh.service.install",
          args: { packages },
        });
      }
      return installService(ctx.store, id, {
        packages,
        unit: typeof args.unit === "string" && args.unit.trim() ? args.unit.trim() : undefined,
        enable: args.enable !== false,
        start: args.start !== false,
      });
    },
  });

  registry.register({
    name: "ssh.service.create",
    title: "Create and run a systemd service",
    description:
      "Write a systemd unit on a Linux host from a command line, then daemon-reload, enable and start it. Use this for an " +
      "app, bot or game server that has no distro package. The unit is marked as managed by Nexus PVE and the helper " +
      "refuses to overwrite a unit file it did not write. Gated: requires confirm:true.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        name: { type: "string", description: "Service name; the unit becomes <name>.service" },
        exec: { type: "string", description: "Full command line, e.g. '/usr/bin/node /opt/app/index.js'" },
        description: { type: "string" },
        user: { type: "string", description: "Run as this user (default root)" },
        workdir: { type: "string", description: "Working directory" },
        env: { type: "object", description: "Environment variables as KEY: value pairs" },
        restart: { type: "string", description: "no, always, on-failure (default) or unless-stopped" },
        after: { type: "string", description: "After= dependency (default network-online.target)" },
        enable: { type: "boolean", description: "Enable at boot (default true)" },
        start: { type: "boolean", description: "Start now (default true)" },
        confirm: { type: "boolean" },
      },
      required: ["name", "exec"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const name = requireString(args, "name");
      const exec = requireString(args, "exec");
      const host = ctx.store.sshHost(id);
      if (args.confirm !== true) {
        await confirmDestructive(ctx, args, {
          title: `Create service ${name}.service on ${host?.label}`,
          tool: "ssh.service.create",
          args: { name, exec: exec.slice(0, 120) },
        });
      }
      return createService(ctx.store, id, {
        name,
        exec,
        description: typeof args.description === "string" ? args.description : undefined,
        user: typeof args.user === "string" && args.user.trim() ? args.user.trim() : undefined,
        workdir: typeof args.workdir === "string" && args.workdir.trim() ? args.workdir.trim() : undefined,
        env: envMap(args.env),
        restart: typeof args.restart === "string" ? (args.restart.trim() as "no" | "always" | "on-failure" | "unless-stopped") : undefined,
        after: typeof args.after === "string" && args.after.trim() ? args.after.trim() : undefined,
        enable: args.enable !== false,
        start: args.start !== false,
      });
    },
  });

  registry.register({
    name: "ssh.service.remove",
    title: "Remove a managed service",
    description:
      "Stop and disable a Nexus-managed systemd unit, then delete its unit file. Refuses a unit file that Nexus PVE did " +
      "not write, so a distro unit cannot be deleted by accident. Optionally purges the package too. Destructive: " +
      "requires confirm:true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        unit: { type: "string", description: "Unit name, e.g. mybot.service (the .service suffix is required here)" },
        purge: { type: "string", description: "Also remove this apt package" },
        confirm: { type: "boolean" },
      },
      required: ["unit"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const unit = requireString(args, "unit");
      const purge = typeof args.purge === "string" && args.purge.trim() ? args.purge.trim() : undefined;
      if (args.confirm !== true) {
        await confirmDestructive(ctx, args, {
          title: `Remove ${unit}${purge ? ` and package ${purge}` : ""} on ${ctx.store.sshHost(id)?.label}`,
          tool: "ssh.service.remove",
          args: { unit, purge },
        });
      }
      return removeService(ctx.store, id, unit, purge);
    },
  });

  registry.register({
    name: "ssh.pkg",
    title: "Manage apt packages",
    description:
      "Install, remove, update the index or upgrade packages on a Linux host. Gated: requires confirm:true. Installs wait " +
      "for the apt lock and keep existing config files (confold), so a running service is never replaced by a debconf " +
      "prompt. Reports the resulting dpkg status and whether a reboot is required.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        action: { type: "string", description: "install, remove, update or upgrade" },
        packages: { type: "string", description: "Comma separated package names (not needed for update/upgrade)" },
        confirm: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const action = requireString(args, "action") as PackageAction;
      if (!PACKAGE_ACTIONS.includes(action)) {
        throw new Error(`"action" must be one of ${PACKAGE_ACTIONS.join(", ")}`);
      }
      const packages = action === "update" || action === "upgrade" ? [] : packageList(args);
      if (args.confirm !== true) {
        await confirmDestructive(ctx, args, {
          title: `apt ${action} ${packages.join(", ") || "(all packages)"} on ${ctx.store.sshHost(id)?.label}`,
          tool: "ssh.pkg",
          args: { action, packages },
        });
      }
      return packageAction(ctx.store, id, action, packages);
    },
  });

  registry.register({
    name: "ssh.docker",
    title: "Docker and compose services",
    description:
      "Run container services on a Linux host. action:\"apply\" writes a compose file to /opt/nexus/<name>/compose.yml and " +
      "brings it up detached, which is how a new container service gets installed; up, down, restart, status, logs and " +
      "remove then manage that project. ps and images list containers; pull fetches an image; start, stop and remove act " +
      "on a single container. Gated: requires confirm:true. Needs the docker compose plugin (installable with ssh.pkg).",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        action: {
          type: "string",
          description: "apply, up, down, restart, status, logs, remove, ps, images, pull, start or stop",
        },
        name: { type: "string", description: "Compose project or container name (lowercase)" },
        compose: { type: "string", description: "Compose YAML for action:\"apply\"" },
        image: { type: "string", description: "Image reference for action:\"pull\"" },
        lines: { type: "number", description: "Log lines for action:\"logs\" (default 40, max 500)" },
        confirm: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const action = requireString(args, "action") as DockerAction;
      const known: DockerAction[] = [
        "apply",
        "up",
        "down",
        "restart",
        "status",
        "logs",
        "remove",
        "ps",
        "images",
        "pull",
        "start",
        "stop",
      ];
      if (!known.includes(action)) throw new Error(`"action" must be one of ${known.join(", ")}`);
      if (args.confirm !== true) {
        await confirmDestructive(ctx, args, {
          title: `docker ${action}${typeof args.name === "string" ? ` ${args.name}` : ""} on ${ctx.store.sshHost(id)?.label}`,
          tool: "ssh.docker",
          args: { action, name: args.name ?? null },
        });
      }
      return dockerAction(ctx.store, id, {
        action,
        name: typeof args.name === "string" ? args.name : undefined,
        image: typeof args.image === "string" ? args.image : undefined,
        compose: typeof args.compose === "string" ? args.compose : undefined,
        lines: optionalNumber(args, "lines"),
      });
    },
  });
}
