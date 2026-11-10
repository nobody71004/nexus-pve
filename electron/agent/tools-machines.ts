import type { ConfigStore } from "../config";
import type { FleetSnapshot, NodeStats } from "../../shared/types";
import { collectSnapshot } from "../pve/collect";
import { execOnHost, findSshHostForPveNode } from "../ssh/collect";
import { vnc } from "../vnc/service";
import {
  confirmDestructive,
  optionalNumber,
  requireString,
  type ToolContext,
  type ToolRegistry,
} from "./registry";

type MachineKind = "linux" | "proxmox";

interface MachineTarget {
  target: string;
  kind: MachineKind;
  label: string;
  address: string;
  sshHostId?: string;
  sshHostLabel?: string;
  sshPort?: number;
  vncPort?: number;
  endpointId?: string;
  endpointLabel?: string;
  node?: string;
  sshMapped: boolean;
  note?: string;
}

interface MachineList {
  machines: MachineTarget[];
  errors: Array<{ endpoint: string; error: string }>;
}

function publicTarget(target: MachineTarget) {
  return {
    target: target.target,
    kind: target.kind,
    label: target.label,
    address: target.address,
    node: target.node ?? null,
    endpoint: target.endpointLabel ?? null,
    sshHost: target.sshHostLabel ?? null,
    sshPort: target.sshPort ?? null,
    vncPort: target.vncPort ?? null,
    sshMapped: target.sshMapped,
    note: target.note ?? null,
  };
}

function nodeAddress(node: NodeStats): string {
  const address = node.network
    .map((nic) => nic.address || nic.cidr?.split("/")[0])
    .find((value): value is string => Boolean(value) && value !== "127.0.0.1" && value !== "::1");
  return address ?? node.node;
}

/**
 * Build one control surface for both parts of the fleet. Proxmox nodes are
 * listed even when they have no SSH inventory match, so an agent can see the
 * gap and ask for it instead of silently treating the node as unreachable.
 */
async function collectMachines(
  store: ConfigStore,
  options: { mappedOnly?: boolean; includeLinkedLinux?: boolean } = {},
): Promise<MachineList> {
  const errors: MachineList["errors"] = [];
  const endpoints = store.hosts();
  const snapshots = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        return { endpoint, snapshot: await collectSnapshot(store, endpoint.id) as FleetSnapshot };
      } catch (error) {
        return { endpoint, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  const machines: MachineTarget[] = [];
  const mappedSshHosts = new Set<string>();
  for (const entry of snapshots) {
    if (!("snapshot" in entry) || !entry.snapshot) {
      errors.push({
        endpoint: entry.endpoint.label,
        error: "error" in entry && entry.error ? entry.error : "snapshot unavailable",
      });
      continue;
    }
    for (const node of entry.snapshot.nodes) {
      const ssh = findSshHostForPveNode(store, entry.endpoint, node);
      if (ssh) mappedSshHosts.add(ssh.id);
      machines.push({
        target: `pve:${entry.endpoint.id}/${node.node}`,
        kind: "proxmox",
        label: `${entry.endpoint.label} / ${node.node}`,
        address: ssh?.host ?? nodeAddress(node),
        sshHostId: ssh?.id,
        sshHostLabel: ssh?.label,
        sshPort: ssh?.port,
        vncPort: ssh?.vncPort,
        endpointId: entry.endpoint.id,
        endpointLabel: entry.endpoint.label,
        node: node.node,
        sshMapped: Boolean(ssh),
        note: ssh
          ? undefined
          : "No matching Linux host. Add this Proxmox node under Linux hosts to enable commands and VNC.",
      });
    }
  }

  if (options.includeLinkedLinux !== false) {
    for (const host of store.sshHosts()) {
      machines.push({
        target: `ssh:${host.id}`,
        kind: "linux",
        label: host.label,
        address: host.host,
        sshHostId: host.id,
        sshHostLabel: host.label,
        sshPort: host.port,
        vncPort: host.vncPort,
        sshMapped: true,
        note: mappedSshHosts.has(host.id) ? "Also used as the SSH transport for a Proxmox node." : undefined,
      });
    }
  }

  const filtered = options.mappedOnly ? machines.filter((machine) => machine.sshMapped) : machines;
  return {
    machines: filtered.sort((left, right) => left.label.localeCompare(right.label)),
    errors,
  };
}

function matchesTarget(machine: MachineTarget, requested: string): boolean {
  const needle = requested.trim().toLowerCase();
  if (!needle) return false;
  const values = [
    machine.target,
    machine.label,
    machine.address,
    machine.sshHostId,
    machine.sshHostLabel,
    machine.node,
    machine.node ? `${machine.endpointLabel}/${machine.node}` : undefined,
    machine.node ? `${machine.endpointId}/${machine.node}` : undefined,
  ];
  return values.some((value) => value?.toLowerCase() === needle);
}

async function resolveMachine(ctx: ToolContext, args: Record<string, unknown>): Promise<MachineTarget> {
  const listed = await collectMachines(ctx.store);
  if (listed.machines.length === 0) {
    throw new Error(
      "No Linux hosts or Proxmox nodes are configured. Add a Proxmox endpoint or an SSH host in Nexus PVE first.",
    );
  }
  const requested = typeof args.target === "string" ? args.target.trim() : "";
  if (requested) {
    const matched = listed.machines.filter((machine) => matchesTarget(machine, requested));
    if (matched.length === 0) {
      throw new Error(
        `No machine matches "${requested}". Use machines.list to see targets: ${listed.machines
          .map((machine) => machine.target)
          .join(", ")}`,
      );
    }
    if (matched.length > 1) {
      throw new Error(
        `"${requested}" matches several machines. Use the full target id: ${matched
          .map((machine) => machine.target)
          .join(", ")}`,
      );
    }
    return matched[0];
  }
  if (listed.machines.length === 1) return listed.machines[0];
  throw new Error(
    `Several machines are configured; pass "target". Options: ${listed.machines
      .map((machine) => machine.target)
      .join(", ")}`,
  );
}

function requireSshTarget(target: MachineTarget): string {
  if (!target.sshHostId) {
    throw new Error(
      `${target.label} has no mapped SSH host. Add the Proxmox node (or its address) under Connections → Linux hosts, then retry.`,
    );
  }
  return target.sshHostId;
}

async function preflightTarget(target: MachineTarget) {
  if (!target.sshHostId) {
    return {
      target: target.target,
      kind: target.kind,
      label: target.label,
      hostId: null,
      ok: false,
      ports: [],
      loopbackPorts: [],
      exposedPorts: [],
      suggestedPort: 5900,
      detail: target.note ? `No mapped SSH host. ${target.note}` : "No mapped SSH host.",
    };
  }
  const result = await vnc.preflight(target.sshHostId);
  return { target: target.target, kind: target.kind, label: target.label, ...result };
}

export function registerMachineTools(registry: ToolRegistry): void {
  registry.register({
    name: "machines.list",
    title: "List Linux and Proxmox control targets",
    description:
      "Unified inventory of every Linux SSH host and Proxmox node the agent can control. Proxmox nodes without a matching SSH host are shown with sshMapped:false and a repair hint. Read-only.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        mappedOnly: { type: "boolean", description: "Only return machines with a working SSH transport." },
        includeLinkedLinux: {
          type: "boolean",
          description: "Include standalone Linux entries even when the same SSH host backs a Proxmox node. Default true.",
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const listed = await collectMachines(ctx.store, {
        mappedOnly: args.mappedOnly === true,
        includeLinkedLinux: args.includeLinkedLinux !== false,
      });
      return {
        count: listed.machines.length,
        machines: listed.machines.map(publicTarget),
        errors: listed.errors,
      };
    },
  });

  registry.register({
    name: "machines.exec",
    title: "Run a command on a Linux host or Proxmox node",
    description:
      "Execute a command over SSH on a Linux host or on a Proxmox node with a matching Linux host. Destructive and gated: requires confirm:true. Set shell:true only when the command genuinely needs pipes or redirection.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "machines.list target, e.g. ssh:<host-id> or pve:<endpoint-id>/<node>." },
        command: { type: "string" },
        shell: { type: "boolean" },
        confirm: { type: "boolean" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const target = await resolveMachine(ctx, args);
      const hostId = requireSshTarget(target);
      const command = requireString(args, "command");
      await confirmDestructive(ctx, args, {
        title: `Run on ${target.label}: ${command.slice(0, 60)}`,
        tool: "machines.exec",
        args: { target: target.target, command },
      });
      const result = await execOnHost(ctx.store, hostId, command, { allowShell: args.shell === true });
      return {
        target: target.target,
        kind: target.kind,
        label: target.label,
        node: target.node ?? null,
        sshHost: target.sshHostLabel ?? null,
        ...result,
      };
    },
  });

  registry.register({
    name: "machines.vnc.preflight",
    title: "Check a machine's VNC console",
    description:
      "Probe a Linux host or Proxmox node's loopback VNC listener and root route through its SSH transport. Read-only; never opens a console or exposes a token.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "machines.list target. Optional when only one machine is configured." },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      return preflightTarget(await resolveMachine(ctx, args));
    },
  });

  registry.register({
    name: "machines.vnc.setup",
    title: "Install or repair a machine VNC console",
    description:
      "Install and start a boot-persistent loopback-only terminal VNC console on a Linux host or Proxmox node. Uses the mapped SSH host, validates sudoers/root access and pins the chosen port. Destructive and gated: requires confirm:true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "machines.list target." },
        sudoPassword: {
          type: "string",
          description: "One-time sudo password for a key-auth host that cannot escalate non-interactively.",
        },
        confirm: { type: "boolean" },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const target = await resolveMachine(ctx, args);
      const hostId = requireSshTarget(target);
      await confirmDestructive(ctx, args, {
        title: `Install the VNC console on ${target.label}`,
        tool: "machines.vnc.setup",
        args: { target: target.target },
      });
      const result = await vnc.setup(
        hostId,
        typeof args.sudoPassword === "string" && args.sudoPassword ? args.sudoPassword : undefined,
      );
      return { target: target.target, kind: target.kind, label: target.label, sshHost: target.sshHostLabel ?? null, ...result };
    },
  });

  registry.register({
    name: "machines.vnc.open",
    title: "Open a machine VNC console",
    description:
      "Open a loopback-only noVNC-compatible WebSocket console for a Linux host or Proxmox node. Returns a single-session ws://127.0.0.1 URL and token; treat it as a credential. The token is never logged or written to disk. Destructive and gated: requires confirm:true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "machines.list target." },
        port: { type: "number", description: "Remote loopback RFB port. Auto-detected when omitted." },
        confirm: { type: "boolean" },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const target = await resolveMachine(ctx, args);
      const hostId = requireSshTarget(target);
      await confirmDestructive(ctx, args, {
        title: `Open the VNC console for ${target.label}`,
        tool: "machines.vnc.open",
        args: { target: target.target },
      });

      let port = optionalNumber(args, "port") ?? target.vncPort;
      if (!port) {
        const probe = await vnc.preflight(hostId);
        if (probe.ok) port = probe.suggestedPort;
        else throw new Error(probe.detail);
      }
      const session = await vnc.open(hostId, port);
      return {
        target: target.target,
        kind: target.kind,
        label: target.label,
        sshHost: target.sshHostLabel ?? null,
        session: {
          id: session.id,
          wsUrl: session.wsUrl,
          expiresAt: session.expiresAt,
        },
        note: "The console is bound to 127.0.0.1 and can only reach the host through the existing authenticated SSH tunnel. Keep the ws URL private; it contains the session token.",
      };
    },
  });

  registry.register({
    name: "machines.vnc.sessions",
    title: "List open VNC console sessions",
    description: "List local VNC bridge sessions and their expiry without returning any WebSocket tokens. Read-only.",
    category: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      return {
        sessions: vnc.list().map((session) => ({
          id: session.id,
          hostId: session.hostId,
          expiresAt: session.expiresAt,
        })),
      };
    },
  });

  registry.register({
    name: "machines.vnc.close",
    title: "Close a VNC console session",
    description: "Close a local VNC bridge session and its SSH tunnel. Safe to repeat; no host-side service is stopped.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = requireString(args, "sessionId");
      await vnc.close(sessionId);
      return { closed: sessionId };
    },
  });
}
