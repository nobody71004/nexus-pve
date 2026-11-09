import type { ToolContext, ToolRegistry } from "./registry";
import { confirmDestructive } from "./registry";
import { allProfiles, profilesPath, readHostProfiles } from "../praetor/profiles";
import {
  install as installPraetor,
  overview as praetorOverview,
  rotate as rotatePraetor,
} from "../praetor/service";
import type { PraetorHostStatus, PraetorProfile } from "../../shared/types";

function resolvePraetorHost(ctx: ToolContext, args: Record<string, unknown>): string {
  const requested = typeof args.host === "string" && args.host.trim() ? args.host.trim() : undefined;
  const hosts = ctx.store.sshHosts();
  if (hosts.length === 0) throw new Error("No Linux hosts configured. Add one in Nexus PVE → Linux hosts.");
  if (!requested) {
    if (hosts.length === 1) return hosts[0].id;
    throw new Error(`Several Linux hosts are configured; pass "host". Options: ${hosts.map((host) => host.label).join(", ")}`);
  }
  const needle = requested.toLowerCase();
  const match = hosts.find(
    (host) =>
      host.id === requested ||
      host.label.toLowerCase() === needle ||
      host.host.toLowerCase() === needle ||
      host.username.toLowerCase() === needle,
  );
  if (!match) {
    throw new Error(`No Linux host matches "${requested}". Configured: ${hosts.map((host) => host.label).join(", ")}`);
  }
  return match.id;
}

function profileSummary(profile: PraetorProfile) {
  return {
    id: profile.id,
    name: profile.name,
    suite: profile.suite,
    endpoint: profile.endpoint,
    cellSize: profile.cellSize,
    autoConnect: profile.autoConnect,
    tags: profile.tags,
    updatedAt: profile.updatedAt,
    serverPublicKey: profile.serverPublicKey,
  };
}

function hostSummary(host: PraetorHostStatus) {
  return {
    hostId: host.hostId,
    label: host.label,
    target: `${host.username}@${host.host}:${host.port}`,
    endpoint: host.endpoint,
    state: host.state,
    detail: host.detail,
    tcpReachable: host.tcpReachable,
    tcpLatencyMs: host.tcpLatencyMs ?? null,
    tcpError: host.tcpError ?? null,
    portListening: host.portListening,
    bindAddress: host.bindAddress ?? null,
    firewallBlocked: host.firewallBlocked,
    firewallActive: host.firewallActive,
    firewallAllow: host.firewallAllow,
    firewallDetail: host.firewallDetail,
    profilesOnHost: host.profilesOnHost,
    profileCount: host.profiles.length,
    nodeVersion: host.nodeVersion ?? null,
    publicKey: host.publicKey ?? null,
    installedSha: host.installedSha ?? null,
    expectedSha: host.expectedSha,
    checkedAt: new Date(host.checkedAt).toISOString(),
    error: host.error ?? null,
    profiles: host.profiles.map(profileSummary),
    history: host.history.map((check) => ({
      ...check,
      checkedAt: new Date(check.checkedAt).toISOString(),
    })),
  };
}

function installSummary(result: Awaited<ReturnType<typeof installPraetor>>) {
  return {
    hostId: result.hostId,
    label: result.label,
    ok: result.ok,
    state: result.state,
    route: result.route,
    endpoint: result.endpoint,
    publicKey: result.publicKey ?? null,
    profileCount: result.profiles.length,
    profiles: result.profiles.map(profileSummary),
    latencyMs: result.latencyMs,
    warning: result.warning ?? null,
    error: result.error ?? null,
    output: result.output.slice(-2500),
  };
}

function rotateSummary(result: Awaited<ReturnType<typeof rotatePraetor>>) {
  return {
    hostId: result.hostId,
    label: result.label,
    ok: result.ok,
    state: result.state,
    route: result.route,
    endpoint: result.endpoint,
    oldPublicKey: result.oldPublicKey ?? null,
    publicKey: result.publicKey ?? null,
    profileCount: result.profiles.length,
    profiles: result.profiles.map(profileSummary),
    latencyMs: result.latencyMs,
    warning: result.warning ?? null,
    error: result.error ?? null,
    output: result.output.slice(-2500),
  };
}

function needsRollout(host: PraetorHostStatus): boolean {
  return host.state !== "ready" || !host.profilesOnHost || host.profiles.length === 0;
}

function targetHosts(ctx: ToolContext, args: Record<string, unknown>): string[] {
  const configured = ctx.store.sshHosts();
  const requested = Array.isArray(args.hosts) ? args.hosts.map(String).filter(Boolean) : [];
  if (requested.length === 0) return configured.map((host) => host.id);
  const selected = new Set<string>();
  for (const value of requested) {
    const needle = value.toLowerCase();
    const match = configured.find(
      (host) =>
        host.id === value ||
        host.label.toLowerCase() === needle ||
        host.host.toLowerCase() === needle,
    );
    if (!match) throw new Error(`No Linux host matches "${value}". Configured: ${configured.map((host) => host.label).join(", ")}`);
    selected.add(match.id);
  }
  return [...selected];
}

export function registerPraetorTools(registry: ToolRegistry): void {
  registry.register({
    name: "praetor.overview",
    title: "PRAETOR egress fleet status",
    description:
      "Read the PRAETOR/1 rollout across every configured SSH host: service state, installed bundle hash, public endpoint, runtime version, X-Wing public key and four client profiles per host. The check also opens TCP 9443 from this workstation and inspects Proxmox firewall status and rules, reporting a firewall block separately from a missing listener. Read-only; private keys are never returned.",
    category: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const overview = await praetorOverview(ctx.store);
      return {
        expectedSha: overview.expectedSha,
        profilesPath: overview.profilesPath,
        historyPath: overview.historyPath,
        checkedAt: new Date(overview.checkedAt).toISOString(),
        hosts: overview.hosts.map(hostSummary),
      };
    },
  });

  registry.register({
    name: "praetor.plan",
    title: "Plan the PRAETOR rollout",
    description:
      "Compare every SSH host with the expected PRAETOR bundle and profiles, then return the exact hosts that need installation or repair. Read-only; use praetor.install or praetor.install_all to execute.",
    category: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const overview = await praetorOverview(ctx.store);
      const pending = overview.hosts.filter(needsRollout);
      return {
        expectedSha: overview.expectedSha,
        profilesPath: overview.profilesPath,
        totalHosts: overview.hosts.length,
        readyHosts: overview.hosts.length - pending.length,
        pending: pending.map((host) => ({
          hostId: host.hostId,
          label: host.label,
          target: `${host.username}@${host.host}:${host.port}`,
          state: host.state,
          profilesOnHost: host.profilesOnHost,
          tcpReachable: host.tcpReachable,
          firewallBlocked: host.firewallBlocked,
          detail: host.detail,
          error: host.error ?? null,
        })),
      };
    },
  });

  registry.register({
    name: "praetor.profiles",
    title: "Export PRAETOR client profiles",
    description:
      "Read the locally saved PRAETOR Command profiles generated by the last successful host installs. Pass host to select one host, or omit it for the whole fleet. Read-only; the server public key is public, private keys are never stored in profiles.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string", description: "Linux host label, address or id." } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const requested = typeof args.host === "string" && args.host.trim() ? args.host : undefined;
      const hostId = requested ? resolvePraetorHost(ctx, args) : null;
      const profiles = hostId ? readHostProfiles(hostId) : allProfiles();
      return {
        path: profilesPath(),
        hostId,
        count: profiles.length,
        profiles: profiles.map(profileSummary),
      };
    },
  });

  registry.register({
    name: "praetor.install",
    title: "Install PRAETOR on a host",
    description:
      "Stage and install the bundled PRAETOR/1 egress, X-Wing keypair, systemd services, firewall allowance and four client profiles on one SSH host. On Proxmox it adds or validates an idempotent host-level TCP 9443 rule and fails the rollout if the active firewall still blocks the endpoint. Destructive and gated: requires confirm:true. The host needs a root route; Proxmox nodes must be present in the SSH inventory.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Linux host label, address or id." },
        confirm: { type: "boolean" },
      },
      required: ["host"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolvePraetorHost(ctx, args);
      await confirmDestructive(ctx, args, {
        title: `Install PRAETOR/1 on ${ctx.store.sshHost(id)?.label}`,
        tool: "praetor.install",
        args: { host: id },
      });
      return installSummary(await installPraetor(ctx.store, id));
    },
  });

  registry.register({
    name: "praetor.rotate",
    title: "Rotate the PRAETOR egress key",
    description:
      "Regenerate the X-Wing keypair on one SSH host and update every client pin location: /opt/praetor-egress/profiles.json on the host and the four local PRAETOR Command profiles. The egress restarts with the new key, and the previous keypair and profiles are restored automatically if it does not come back. Clients must re-import the refreshed profiles because their old pin is replaced. Destructive and gated: requires confirm:true. The host needs a root route and an existing install.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Linux host label, address or id." },
        confirm: { type: "boolean" },
      },
      required: ["host"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = resolvePraetorHost(ctx, args);
      await confirmDestructive(ctx, args, {
        title: `Rotate the PRAETOR key on ${ctx.store.sshHost(id)?.label}`,
        tool: "praetor.rotate",
        args: { host: id },
      });
      return rotateSummary(await rotatePraetor(ctx.store, id));
    },
  });

  registry.register({
    name: "praetor.install_all",
    title: "Install PRAETOR across the fleet",
    description:
      "Sequentially install or repair PRAETOR/1 on every configured SSH host, or on the hosts named in hosts[]. Each host gets its own egress key, four client profiles, services and firewall allowance; Proxmox hosts receive an idempotent host-level TCP 9443 rule and fail the rollout when the active firewall still blocks it. Destructive and gated: requires confirm:true. Nodes missing from SSH inventory are not invented.",
    category: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        hosts: {
          type: "array",
          items: { type: "string" },
          description: "Optional host labels, addresses or ids. Omit to target every SSH host.",
        },
        confirm: { type: "boolean" },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const ids = targetHosts(ctx, args);
      if (ids.length === 0) throw new Error("No Linux hosts configured. Add one in Nexus PVE → Linux hosts.");
      await confirmDestructive(ctx, args, {
        title: `Install PRAETOR/1 on ${ids.length} SSH host${ids.length === 1 ? "" : "s"}`,
        tool: "praetor.install_all",
        args: { hosts: ids },
      });
      const results: ReturnType<typeof installSummary>[] = [];
      for (const id of ids) {
        results.push(installSummary(await installPraetor(ctx.store, id)));
      }
      const failed = results.filter((result) => !result.ok);
      return {
        total: results.length,
        ok: failed.length === 0,
        installed: results.length - failed.length,
        failed: failed.length,
        results,
      };
    },
  });
}
