import crypto from "node:crypto";
import type { ConfigStore } from "../config";
import { configStore } from "../config";
import type {
  RelayChain,
  RelayChainInput,
  RelayDeployOutput,
  RelayDeployResult,
  RelayHost,
  RelayNodeStatus,
  RelayOverview,
  RelayRemoveResult,
} from "../../shared/fabric-types";
import { execOnHost } from "../ssh/collect";
import { runEdge } from "../ddos/remote";
import { RelayStore } from "./store";
import {
  buildInstallScript,
  buildPlan,
  buildTeardownScript,
  generateRelayKeys,
  type RelayKeyPair,
} from "./plan";

const MIN_NODES = 2;
const MAX_NODES = 5;
const DEFAULT_ENTRY_PORT = 7443;
const DEFAULT_RELAY_PORT = 7444;
const DEFAULT_ORIGIN_PORT = 25565;
const DEFAULT_MTU = 1420;

function integer(value: unknown, field: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function text(value: unknown, field: string, fallback = ""): string {
  const parsed = typeof value === "string" ? value.trim() : fallback;
  if (!parsed) throw new Error(`${field} is required`);
  if (/\s/.test(parsed)) throw new Error(`${field} cannot contain spaces`);
  return parsed;
}

function hostView(store: ConfigStore): RelayHost[] {
  return store.sshHosts().map((host) => ({
    id: host.id,
    label: host.label,
    host: host.host,
    port: host.port,
    username: host.username,
    color: host.color,
  }));
}

function normalizeChain(store: ConfigStore, input: RelayChainInput, existing: RelayChain | null): RelayChain {
  const name = (input.name || "").trim() || "Nexus relay chain";
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  if (nodes.length < MIN_NODES) throw new Error(`A relay chain needs at least ${MIN_NODES} hops (entry and exit)`);
  if (nodes.length > MAX_NODES) throw new Error(`A relay chain is limited to ${MAX_NODES} hops`);

  const seen = new Set<string>();
  const normalizedNodes = nodes.map((node, index) => {
    const host = store.sshHost(node.hostId);
    if (!host) throw new Error(`Hop ${index + 1}: unknown Linux host ${node.hostId}`);
    if (seen.has(host.id)) throw new Error(`Hop ${index + 1}: ${host.label} is already in the chain`);
    seen.add(host.id);
    return {
      hostId: host.id,
      label: (node.label || host.label).trim() || host.label,
      region: (node.region || "").trim(),
      publicHost: (node.publicHost || host.host).trim() || host.host,
      wgPort: integer(node.wgPort || 51820, `Hop ${index + 1} WireGuard port`, 1, 65535),
    };
  });

  const originHost = text(input.originHost, "Origin host");
  const originPort = integer(input.originPort || DEFAULT_ORIGIN_PORT, "Origin port", 1, 65535);
  const entryPort = integer(input.entryPort || DEFAULT_ENTRY_PORT, "Entry port", 1, 65535);
  const relayPort = integer(input.relayPort || DEFAULT_RELAY_PORT, "Relay port", 1, 65535);
  if (entryPort === relayPort) throw new Error("Entry port and internal relay port must differ");
  if (normalizedNodes.some((node) => node.wgPort === entryPort || node.wgPort === relayPort)) {
    throw new Error("WireGuard port cannot collide with the public or internal relay port");
  }

  const now = Date.now();
  return {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    nodes: normalizedNodes,
    originHost,
    originPort,
    entryPort,
    relayPort,
    mtu: integer(input.mtu || DEFAULT_MTU, "MTU", 1280, 1500),
    transport: "wireguard",
    obfuscation: input.obfuscation === "tls" ? "tls" : "none",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function parseProbe(stdout: string): { wg: string; relay: string; peers: number; listeners: number; tls: string; tlsfp: string } {
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([a-z]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].trim();
  }
  return {
    wg: values.wg || "",
    relay: values.relay || "",
    peers: Number(values.peers) || 0,
    listeners: Number(values.listeners) || 0,
    tls: values.tls || "",
    tlsfp: values.tlsfp || "",
  };
}

export class RelayService {
  constructor(
    private readonly store: ConfigStore = configStore,
    private readonly relayStore: RelayStore = new RelayStore(),
  ) {}

  private async probeNode(chain: RelayChain, index: number): Promise<RelayNodeStatus> {
    const node = chain.nodes[index];
    const plan = buildPlan(chain).hops[index];
    const port = plan.role === "entry" ? chain.entryPort : chain.relayPort;
    const tlsEntry = index === 0 && chain.obfuscation === "tls";
    const started = Date.now();
    try {
      const result = await execOnHost(
        this.store,
        node.hostId,
        [
          `printf 'wg=%s\\n' "$(systemctl is-active wg-quick@nexus0 2>/dev/null || true)"`,
          `printf 'relay=%s\\n' "$(systemctl is-active nexus-relay 2>/dev/null || true)"`,
          `printf 'peers=%s\\n' "$(wg show nexus0 2>/dev/null | grep -c '^peer:' || true)"`,
          `printf 'listeners=%s\\n' "$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Ec ':${port}$' || true)"`,
          ...(tlsEntry
            ? [
                `printf 'tls=%s\\n' "$(openssl x509 -in /etc/nexus-relay/tls/server.crt -noout -checkend 0 >/dev/null 2>&1 && echo valid || echo missing)"`,
                `printf 'tlsfp=%s\\n' "$(openssl x509 -in /etc/nexus-relay/tls/server.crt -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' || true)"`,
              ]
            : []),
        ].join("\n"),
        { allowShell: true, timeoutMs: 15_000 },
      );
      const parsed = parseProbe(result.stdout);
      const wgActive = parsed.wg === "active";
      const relayActive = parsed.relay === "active";
      const health = wgActive && relayActive ? "online" : wgActive || relayActive ? "degraded" : "offline";
      return {
        hostId: node.hostId,
        health,
        latencyMs: result.latencyMs || Date.now() - started,
        wgActive,
        relayActive,
        peers: parsed.peers,
        listener: parsed.listeners > 0,
        tls: tlsEntry ? parsed.tls === "valid" && relayActive : false,
        tlsFingerprint: tlsEntry ? parsed.tlsfp || undefined : undefined,
        error: result.ok ? undefined : (result.stderr.trim().split(/\r?\n/).slice(-1)[0] || `ssh exited ${result.code ?? "?"}`),
        checkedAt: Date.now(),
      };
    } catch (err) {
      return {
        hostId: node.hostId,
        health: "offline",
        latencyMs: Date.now() - started,
        wgActive: false,
        relayActive: false,
        peers: 0,
        listener: false,
        error: err instanceof Error ? err.message : String(err),
        checkedAt: Date.now(),
      };
    }
  }

  private async statuses(chain: RelayChain): Promise<RelayNodeStatus[]> {
    return Promise.all(chain.nodes.map((_node, index) => this.probeNode(chain, index)));
  }

  private async overviewFor(chain: RelayChain | null, error?: string): Promise<RelayOverview> {
    const statuses = chain ? await this.statuses(chain) : [];
    return {
      chain,
      hosts: hostView(this.store),
      statuses,
      plan: chain ? buildPlan(chain) : null,
      error,
      checkedAt: Date.now(),
    };
  }

  async overview(): Promise<RelayOverview> {
    try {
      return await this.overviewFor(this.relayStore.chain());
    } catch (err) {
      return {
        chain: this.relayStore.chain(),
        hosts: hostView(this.store),
        statuses: [],
        plan: null,
        error: err instanceof Error ? err.message : String(err),
        checkedAt: Date.now(),
      };
    }
  }

  async probe(): Promise<RelayOverview> {
    return this.overview();
  }

  save(input: RelayChainInput): RelayChain {
    const existing = this.relayStore.chain();
    const chain = normalizeChain(this.store, input, existing);
    return this.relayStore.save(chain);
  }

  async deploy(): Promise<RelayDeployResult> {
    const chain = this.relayStore.chain();
    if (!chain) throw new Error("Build and save a relay chain first");
    const plan = buildPlan(chain);
    for (const node of chain.nodes) {
      const host = this.store.sshHost(node.hostId);
      if (!host) throw new Error(`Unknown host ${node.hostId}`);
      if (host.username !== "root") {
        throw new Error(`${host.label}: relay deployment needs a root SSH account (or a root key); this host logs in as "${host.username}".`);
      }
    }

    const keys: RelayKeyPair[] = chain.nodes.map(() => generateRelayKeys());
    const publicHosts = plan.hops.map((hop) => hop.publicHost);
    const outputs: RelayDeployOutput[] = [];
    const applied: number[] = [];

    for (let index = 0; index < chain.nodes.length; index += 1) {
      const node = chain.nodes[index];
      let result: Awaited<ReturnType<typeof runEdge>> | undefined;
      try {
        const script = buildInstallScript(chain, index, keys, publicHosts);
        result = await runEdge(this.store, node.hostId, script, 180_000);
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        outputs.push({ hostId: node.hostId, label: node.label, ok: result.ok, output });
        if (!result.ok) throw new Error(output.split(/\r?\n/).slice(-3).join(" ") || `ssh exited ${result.code ?? "?"}`);
        applied.push(index);
      } catch (err) {
        const rollbackOutputs: RelayDeployOutput[] = [];
        // An install can fail after writing a config or starting one unit. Roll
        // back the current hop too, but only when the remote shell actually ran
        // (a null exit code is a connection/timeout failure and a second attempt
        // would only stall the report).
        const rollbackIndexes = [
          ...(result && result.code !== null ? [index] : []),
          ...[...applied].reverse(),
        ];
        for (const rollbackIndex of rollbackIndexes) {
          const rollbackNode = chain.nodes[rollbackIndex];
          try {
            const rollback = await runEdge(this.store, rollbackNode.hostId, buildTeardownScript(), 60_000);
            rollbackOutputs.push({
              hostId: rollbackNode.hostId,
              label: `${rollbackNode.label} rollback`,
              ok: rollback.ok,
              output: [rollback.stdout, rollback.stderr].filter(Boolean).join("\n").trim(),
            });
          } catch (rollbackError) {
            rollbackOutputs.push({
              hostId: rollbackNode.hostId,
              label: `${rollbackNode.label} rollback`,
              ok: false,
              output: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
          }
        }
        return {
          ok: false,
          chain,
          outputs: [...outputs, ...rollbackOutputs],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { ok: true, chain, outputs };
  }

  async remove(): Promise<RelayRemoveResult> {
    const chain = this.relayStore.chain();
    if (!chain) throw new Error("No relay chain is saved");
    const outputs: RelayDeployOutput[] = [];
    for (const node of chain.nodes) {
      try {
        const result = await runEdge(this.store, node.hostId, buildTeardownScript(), 60_000);
        outputs.push({
          hostId: node.hostId,
          label: node.label,
          ok: result.ok,
          output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
        });
      } catch (err) {
        outputs.push({
          hostId: node.hostId,
          label: node.label,
          ok: false,
          output: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const ok = outputs.every((entry) => entry.ok);
    return { ok, outputs, error: ok ? undefined : "one or more hops did not acknowledge teardown" };
  }
}

export const relay = new RelayService();
