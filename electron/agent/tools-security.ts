import type { ToolContext, ToolRegistry } from "./registry";
import { confirmDestructive, requireString } from "./registry";
import { guardian, REMEDIATIONS } from "../security/guardian";

function resolveSshHost(ctx: ToolContext, args: Record<string, unknown>): string {
  const requested = typeof args.host === "string" && args.host.trim() ? args.host.trim() : undefined;
  const hosts = ctx.store.sshHosts();
  if (hosts.length === 0) throw new Error("No Linux hosts configured. Add one in Nexus PVE → Linux hosts.");
  if (requested) {
    const match = ctx.store.sshHost(requested);
    if (!match) throw new Error(`No Linux host matches "${requested}". Configured: ${hosts.map((host) => host.label).join(", ")}`);
    return match.id;
  }
  if (hosts.length === 1) return hosts[0].id;
  throw new Error(`Several Linux hosts are configured; pass "host". Options: ${hosts.map((host) => host.label).join(", ")}`);
}

function summarize(scan: Awaited<ReturnType<typeof guardian.scan>>) {
  return {
    host: scan.label,
    at: new Date(scan.at).toISOString(),
    mode: scan.mode,
    score: scan.score,
    grade: scan.grade,
    privileged: scan.privileged,
    layers: scan.layers,
    findings: scan.checks
      .filter((check) => check.status === "fail" || check.status === "warn")
      .map((check) => ({
        id: check.id,
        layer: check.layer,
        severity: check.severity,
        status: check.status,
        title: check.title,
        detail: check.detail,
        remediation: check.remediation ?? null,
      })),
    drift: scan.drift,
    actions: scan.actions,
    bans: scan.bans,
    errors: scan.errors,
  };
}

export function registerSecurityTools(registry: ToolRegistry): void {
  registry.register({
    name: "security.overview",
    title: "Security guard status",
    description:
      "Read the 24/7 security guardian: policy (observe/defend/lockdown), per-host score, last scan, journal integrity and recent decisions. Read-only.",
    category: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const overview = guardian.overview();
      return {
        running: overview.running,
        policy: overview.policy,
        chain: overview.chain,
        hosts: overview.hosts.map((host) => ({
          host: host.label,
          running: host.running,
          nextRunAt: host.nextRunAt ? new Date(host.nextRunAt).toISOString() : null,
          lastError: host.lastError ?? null,
          score: host.scan?.score ?? null,
          grade: host.scan?.grade ?? null,
          lastScanAt: host.scan ? new Date(host.scan.at).toISOString() : null,
          failing: host.scan?.checks.filter((check) => check.status === "fail").length ?? null,
        })),
        journal: overview.journal.slice(-15).map((entry) => ({
          at: new Date(entry.at).toISOString(),
          host: entry.label,
          kind: entry.kind,
          trigger: entry.trigger ?? null,
          route: entry.route ?? null,
          message: entry.message,
        })),
      };
    },
  });

  registry.register({
    name: "security.scan",
    title: "Run a security audit",
    description:
      "Audit one Linux host across access, network, patch, kernel, integrity and persistence layers. Applies safe auto-remediations when the policy has them enabled. Returns findings, drift and any actions taken.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string", description: "Host label, address or id. Optional with one host." } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      return summarize(await guardian.scan(id));
    },
  });

  registry.register({
    name: "security.enforce",
    title: "Apply a security remediation",
    description:
      `Apply one fixed remediation through the narrow root helper, then re-audit. Destructive and gated: requires confirm:true. Available: ${Object.keys(REMEDIATIONS).join(", ")}. Guarded fixes (ssh-key-only, firewall-baseline) can lock you out; review them first.`,
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        action: { type: "string", description: Object.keys(REMEDIATIONS).join(", ") },
        confirm: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const action = requireString(args, "action");
      if (!REMEDIATIONS[action]) throw new Error(`Unknown remediation. Available: ${Object.keys(REMEDIATIONS).join(", ")}`);
      await confirmDestructive(ctx, args, {
        title: `${REMEDIATIONS[action].label} on ${ctx.store.sshHost(id)?.label}`,
        tool: "security.enforce",
        args: { action },
      });
      return summarize(await guardian.enforce(id, action, { confirm: true }));
    },
  });

  registry.register({
    name: "security.policy",
    title: "Change guard policy",
    description:
      "Update the 24/7 guardian policy: enabled, mode (observe|defend|lockdown), intervalSec, autoRemediate, resident, allowlist, maxBansPerRun, banThreshold. The policy is re-signed; a hand-edited policy file is refused.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        mode: { type: "string", description: "observe, defend or lockdown" },
        intervalSec: { type: "number", description: "60–86400" },
        autoRemediate: { type: "boolean" },
        resident: { type: "boolean" },
        allowlist: { type: "array", items: { type: "string" } },
        maxBansPerRun: { type: "number" },
        banThreshold: { type: "number" },
      },
      additionalProperties: false,
    },
    async run(args) {
      const patch: Record<string, unknown> = {};
      for (const key of ["enabled", "mode", "intervalSec", "autoRemediate", "resident", "allowlist", "maxBansPerRun", "banThreshold"]) {
        if (args[key] !== undefined) patch[key] = args[key];
      }
      return guardian.setPolicy(patch);
    },
  });

  registry.register({
    name: "security.journal",
    title: "Security journal",
    description:
      "Read the tamper-evident security journal (hash-chained) and verify the chain. Every scan, fix, ban and policy change is a record. Helper-install records also expose structured route and trigger fields.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "default 50, max 500" } },
      additionalProperties: false,
    },
    async run(args) {
      const limit = Math.min(500, Math.max(1, Number(args.limit) || 50));
      const verify = guardian.journal.verify();
      return {
        chain: verify,
        records: guardian.journal.list(limit).map((entry) => ({
          seq: entry.seq,
          at: new Date(entry.at).toISOString(),
          host: entry.label,
          kind: entry.kind,
          trigger: entry.trigger ?? null,
          route: entry.route ?? null,
          message: entry.message,
          hash: entry.hash.slice(0, 16),
        })),
      };
    },
  });

  registry.register({
    name: "security.contain",
    title: "Ban an address",
    description:
      "Add an address to the guard's 24h nftables drop set on a host. Destructive and gated: requires confirm:true. The helper refuses loopback, link-local and any address holding a live SSH session.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        address: { type: "string", description: "IPv4 or IPv6 address" },
        confirm: { type: "boolean" },
      },
      required: ["address"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      const address = requireString(args, "address");
      await confirmDestructive(ctx, args, {
        title: `Ban ${address} on ${ctx.store.sshHost(id)?.label}`,
        tool: "security.contain",
        args: { address },
      });
      return guardian.ban(id, address);
    },
  });

  registry.register({
    name: "security.resident",
    title: "Resident enforcer",
    description:
      "Install or remove the guest-side systemd timer that re-applies the chosen baseline every 15 minutes, so protection continues while the desktop app is closed. Requires the root helper.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        enable: { type: "boolean" },
      },
      required: ["enable"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolveSshHost(ctx, args);
      return guardian.resident(id, args.enable === true);
    },
  });
}
