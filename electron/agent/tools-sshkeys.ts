import type { ToolContext, ToolRegistry } from "./registry";
import { confirmDestructive, requireString } from "./registry";
import { sshKeys } from "../sshkeys/service";

function resolveHost(ctx: ToolContext, args: Record<string, unknown>): string {
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

function keySummary(args: Record<string, unknown>): string {
  const key = typeof args.key === "string" ? args.key : "";
  if (!key) throw new Error("key is required (label, id or SHA256 fingerprint)");
  return key;
}

function overviewReport(overview: ReturnType<typeof sshKeys.overview>) {
  return {
    running: overview.running,
    policy: overview.policy,
    keys: overview.keys,
    hosts: overview.hosts.map((host) => ({
      hostId: host.hostId,
      host: host.label,
      address: host.host,
      user: host.username,
      path: host.path,
      mode: host.mode ?? null,
      exists: host.exists,
      scannedAt: host.scannedAt ? new Date(host.scannedAt).toISOString() : null,
      managed: host.managed,
      trusted: host.trusted,
      unknown: host.unknown,
      loginFingerprint: host.loginFingerprint ?? null,
      error: host.error ?? null,
      keys: host.keys,
    })),
    events: overview.events.slice(0, 15).map((event) => ({ ...event, at: new Date(event.at).toISOString() })),
  };
}

export function registerSshKeyTools(registry: ToolRegistry): void {
  registry.register({
    name: "sshkey.overview",
    title: "SSH key inventory and watcher",
    description:
      "Read the managed Ed25519 key vault, per-host authorized_keys findings, login-key protection, 24/7 watcher policy and recent events. Private keys are never returned. Read-only.",
    category: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      return overviewReport(sshKeys.overview());
    },
  });

  registry.register({
    name: "sshkey.generate",
    title: "Generate a managed SSH key",
    description:
      "Generate an Ed25519 keypair in the encrypted local vault. Returns the public key and SHA256 fingerprint; the private key stays encrypted on this machine until deployed.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Human label, e.g. 'ops-laptop'" },
        owner: { type: "string", description: "Person or automation that owns the key" },
      },
      required: ["label"],
      additionalProperties: false,
    },
    async run(args) {
      const overview = sshKeys.generate({ label: args.label, owner: args.owner });
      return {
        key: overview.keys.find((key) => key.label === args.label) ?? overview.keys[0],
        policy: overview.policy,
      };
    },
  });

  registry.register({
    name: "sshkey.deploy",
    title: "Deploy a managed key",
    description:
      "Append a managed public key to the configured account's ~/.ssh/authorized_keys, back up the file first, and point that Linux host at the encrypted private key for key auth. Idempotent.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Host label, address or id. Optional with one host." },
        key: { type: "string", description: "Managed key label, id or SHA256 fingerprint" },
      },
      required: ["key"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return sshKeys.deploy(resolveHost(ctx, args), keySummary(args));
    },
  });

  registry.register({
    name: "sshkey.scan",
    title: "Scan authorized_keys",
    description:
      "Read one host's authorized_keys as the configured login user, fingerprint every key, classify managed/trusted/unmanaged, protect the current login key, and record the report. Read-only on the host.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string" } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      return sshKeys.scan(resolveHost(ctx, args));
    },
  });

  registry.register({
    name: "sshkey.trust",
    title: "Trust scanned SSH keys",
    description:
      "Accept one or more unmanaged fingerprints from the latest scan into a host's trust baseline. Omit fingerprints to trust every currently unmanaged key.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        fingerprints: { type: "array", items: { type: "string" }, description: "Defaults to every unmanaged key" },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const fingerprints = Array.isArray(args.fingerprints)
        ? args.fingerprints.filter((entry): entry is string => typeof entry === "string")
        : undefined;
      return sshKeys.trust(resolveHost(ctx, args), fingerprints);
    },
  });

  registry.register({
    name: "sshkey.enforce",
    title: "Remove unmanaged SSH keys",
    description:
      "Back up authorized_keys and remove every unmanaged key. Refuses if no managed/trusted key would remain, and the configured login key is always trusted first. Destructive: requires confirm:true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["confirm"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const hostId = resolveHost(ctx, args);
      if (args.confirm !== true) throw new Error("sshkey.enforce requires confirm:true");
      await confirmDestructive(ctx, args, {
        title: `Remove unmanaged SSH keys on ${ctx.store.sshHost(hostId)?.label}`,
        tool: "sshkey.enforce",
        args: {},
      });
      return sshKeys.enforce(hostId, true);
    },
  });

  registry.register({
    name: "sshkey.policy",
    title: "Configure SSH-key watcher",
    description:
      "Enable or pause the 24/7 watcher and set its interval. Auto-enforcement is opt-in because removing keys can lock out a login. Returns the signed policy.",
    category: "mutate",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        autoEnforce: { type: "boolean" },
        intervalSec: { type: "number", minimum: 30, maximum: 86400 },
      },
      additionalProperties: false,
    },
    async run(args) {
      return sshKeys.setPolicy({
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.autoEnforce !== undefined ? { autoEnforce: args.autoEnforce } : {}),
        ...(args.intervalSec !== undefined ? { intervalSec: args.intervalSec } : {}),
      });
    },
  });

  registry.register({
    name: "sshkey.revoke",
    title: "Revoke a managed SSH key",
    description:
      "Remove a managed key from every host it was deployed to, with a per-host backup, then retire the key and delete its private material. Destructive: requires confirm:true.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Label, id or SHA256 fingerprint" },
        confirm: { type: "boolean" },
      },
      required: ["key", "confirm"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const key = requireString(args, "key");
      if (args.confirm !== true) throw new Error("sshkey.revoke requires confirm:true");
      await confirmDestructive(ctx, args, {
        title: `Revoke SSH key ${key}`,
        tool: "sshkey.revoke",
        args: { key },
      });
      return overviewReport(await sshKeys.revoke(key, true));
    },
  });
}
