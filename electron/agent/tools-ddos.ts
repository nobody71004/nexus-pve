import type { ToolContext, ToolRegistry } from "./registry";
import { confirmDestructive, requireString } from "./registry";
import { ddos } from "../ddos/service";
import type { DdosConfig, DdosMode } from "../../shared/ddos-types";

const MODES: DdosMode[] = ["observe", "defend", "lockdown"];

function resolveEdgeHost(ctx: ToolContext, args: Record<string, unknown>): string {
  const hosts = ctx.store.sshHosts();
  if (hosts.length === 0) throw new Error("No Linux hosts configured. Add the edge under Nexus PVE → Connections.");
  const requested = typeof args.host === "string" && args.host.trim() ? args.host.trim() : undefined;
  if (requested) {
    const match = ctx.store.sshHost(requested);
    if (!match) throw new Error(`No Linux host matches "${requested}". Configured: ${hosts.map((host) => host.label).join(", ")}`);
    return match.id;
  }
  const preferred = hosts.find((host) => /demo|relay|shield/i.test(host.label) || host.host === "192.0.2.12");
  if (preferred) return preferred.id;
  if (hosts.length === 1) return hosts[0].id;
  throw new Error(`Several Linux hosts are configured; pass "host". Options: ${hosts.map((host) => host.label).join(", ")}`);
}

export function registerDdosTools(registry: ToolRegistry): void {
  registry.register({
    name: "ddos.overview",
    title: "DDoS shield overview",
    description:
      "Read the edge DDoS shield: configured policy, live mode, traffic rates, top sources, dropped packets and recent incidents. Read-only.",
    category: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const overview = await ddos.overview();
      return {
        edge: overview.edgeLabel ?? null,
        edgeHostId: overview.edgeHostId ?? null,
        config: overview.config,
        status: overview.status ?? null,
        incidents: overview.incidents.slice(0, 20),
        error: overview.error ?? null,
        checkedAt: new Date(overview.checkedAt).toISOString(),
      };
    },
  });

  registry.register({
    name: "ddos.status",
    title: "Sample the edge shield",
    description:
      "Force a fresh sample from the edge: ingress/egress rates, conntrack, CPU/memory, drops, blocked addresses and top talkers. Read-only.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string", description: "Edge host label, address or id." } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveEdgeHost(ctx, args);
      return ddos.status(id, true);
    },
  });

  registry.register({
    name: "ddos.rules",
    title: "Read the enforced nftables ruleset",
    description:
      "Return the exact nftables ruleset the edge has loaded, including the forward table, per-port limits and the blocklist. Read-only.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string" } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      return { rules: await ddos.rules(resolveEdgeHost(ctx, args)) };
    },
  });

  registry.register({
    name: "ddos.install",
    title: "Install or upgrade the edge shield",
    description:
      "Push the bundled Nexus Shield daemon, systemd unit and sysctl tuning to an edge host, then adopt the relay's forwards. Destructive and gated: requires confirm:true. The installer backs up the live ruleset and leaves the legacy relay tables in place if the new daemon fails.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Edge host label, address or id. Must log in as root." },
        confirm: { type: "boolean" },
      },
      required: ["host"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveEdgeHost(ctx, args);
      await confirmDestructive(ctx, args, {
        title: `Install the DDoS edge shield on ${ctx.store.sshHost(id)?.label}`,
        tool: "ddos.install",
        args: { host: id },
      });
      return ddos.install(id);
    },
  });

  registry.register({
    name: "ddos.mode",
    title: "Set the shield mode",
    description:
      "Switch the edge between observe (count only), defend (rates + auto-ban) and lockdown (defend with the tighter half-rate profile). Mutating.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        mode: { type: "string", description: "observe, defend or lockdown" },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveEdgeHost(ctx, args);
      const mode = requireString(args, "mode") as DdosMode;
      if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
      return ddos.setMode(id, mode);
    },
  });

  registry.register({
    name: "ddos.ban",
    title: "Ban a source at the edge",
    description:
      "Add an IPv4 address to the edge drop set with a timeout. Destructive and gated: requires confirm:true. Loopback, link-local and allowlisted addresses are refused.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        ip: { type: "string", description: "IPv4 address" },
        seconds: { type: "number", description: "30-604800; defaults to the policy block duration" },
        reason: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["ip"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveEdgeHost(ctx, args);
      const ip = requireString(args, "ip");
      await confirmDestructive(ctx, args, {
        title: `Ban ${ip} at the edge`,
        tool: "ddos.ban",
        args: { ip },
      });
      return ddos.ban(id, ip, Number(args.seconds) || undefined, typeof args.reason === "string" ? args.reason : undefined);
    },
  });

  registry.register({
    name: "ddos.unban",
    title: "Remove an edge ban",
    description: "Remove an address from the edge drop set. Mutating.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string" }, ip: { type: "string" } },
      required: ["ip"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return ddos.unban(resolveEdgeHost(ctx, args), requireString(args, "ip"));
    },
  });

  registry.register({
    name: "ddos.allow",
    title: "Edit the edge allowlist",
    description:
      "Add or remove an address from the allowlist that bypasses rate limits and auto-bans. Mutating. Keep this short: an allowlisted address is also exempt from the blocklist.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        ip: { type: "string" },
        add: { type: "boolean", description: "true to allow, false to remove" },
      },
      required: ["ip", "add"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return ddos.allow(resolveEdgeHost(ctx, args), requireString(args, "ip"), args.add !== false);
    },
  });

  registry.register({
    name: "ddos.config",
    title: "Change edge protection policy",
    description:
      "Update mode, rate ceilings, auto-ban behaviour, forwards or the allowlist, then push and reload the edge configuration. Mutating. Forwards are the exact DNAT table; changing one changes what is public.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        mode: { type: "string" },
        udpPps: { type: "number" },
        tcpNewPerSec: { type: "number" },
        autoBanPps: { type: "number" },
        blockSeconds: { type: "number" },
        autoBanSamples: { type: "number" },
        autoBan: { type: "boolean" },
        allowlist: { type: "array", items: { type: "string" } },
        forwards: { type: "array", items: { type: "object" } },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveEdgeHost(ctx, args);
      const patch: Partial<DdosConfig> = {};
      if (args.mode !== undefined) {
        const mode = String(args.mode) as DdosMode;
        if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
        patch.mode = mode;
      }
      const limits: Partial<DdosConfig["limits"]> = {};
      for (const key of ["udpPps", "tcpNewPerSec", "autoBanPps", "blockSeconds", "autoBanSamples"] as const) {
        if (args[key] !== undefined) limits[key] = Number(args[key]);
      }
      if (Object.keys(limits).length > 0) patch.limits = limits as DdosConfig["limits"];
      if (args.autoBan !== undefined) patch.autoBan = args.autoBan === true;
      if (Array.isArray(args.allowlist)) patch.allowlist = args.allowlist.map(String);
      if (Array.isArray(args.forwards)) patch.forwards = args.forwards as DdosConfig["forwards"];
      if (Object.keys(patch).length === 0) throw new Error("Nothing to change");
      return ddos.apply(id, patch);
    },
  });

  registry.register({
    name: "ddos.journal",
    title: "DDoS incident journal",
    description: "Read the app-side DDoS journal: installs, mode changes, bans, allowlist edits and policy pushes. Read-only.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "default 50, max 200" } },
      additionalProperties: false,
    },
    async run(args) {
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
      return ddos.journal(limit);
    },
  });
}
