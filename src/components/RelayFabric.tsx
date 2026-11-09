import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RelayChain,
  RelayChainInput,
  RelayDeployOutput,
  RelayNodeConfig,
  RelayNodeStatus,
  RelayOverview,
} from "../../shared/types";
import { bridge } from "../lib/bridge";
import { Icon } from "./Icon";
import { Chip, Panel, StatusDot } from "./ui";

const EMPTY: RelayChainInput = {
  name: "Stream relay",
  nodes: [],
  originHost: "",
  originPort: 25565,
  entryPort: 7443,
  relayPort: 7444,
  mtu: 1420,
  transport: "wireguard",
  obfuscation: "none",
};

const ROLE_LABEL = { entry: "Entry", relay: "Relay", exit: "Exit" } as const;

/** Electron wraps rejected IPC handlers twice; show the message the service raised. */
function readableError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}

function chainToInput(chain: RelayChain): RelayChainInput {
  return {
    id: chain.id,
    name: chain.name,
    nodes: chain.nodes.map((node) => ({ ...node })),
    originHost: chain.originHost,
    originPort: chain.originPort,
    entryPort: chain.entryPort,
    relayPort: chain.relayPort,
    mtu: chain.mtu,
    transport: chain.transport,
    obfuscation: chain.obfuscation ?? "none",
  };
}

function roleAt(index: number, total: number): "entry" | "relay" | "exit" {
  if (index === 0) return "entry";
  return index === total - 1 ? "exit" : "relay";
}

function statusTone(status?: RelayNodeStatus): "ok" | "warn" | "err" | "muted" {
  if (!status) return "muted";
  if (status.health === "online") return "ok";
  if (status.health === "degraded") return "warn";
  return "err";
}

export function RelayFabric({
  onToast,
  onOpenConnections,
}: {
  onToast: (level: "info" | "warn" | "error" | "ok", title: string, detail?: string) => void;
  onOpenConnections: () => void;
}) {
  const [overview, setOverview] = useState<RelayOverview | null>(null);
  const [draft, setDraft] = useState<RelayChainInput>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [selectedHost, setSelectedHost] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<RelayDeployOutput[]>([]);
  const [tlsReviewed, setTlsReviewed] = useState(false);
  const originRef = useRef<HTMLInputElement>(null);

  const applyOverview = useCallback((next: RelayOverview, preserveDraft: boolean) => {
    setOverview(next);
    if (!preserveDraft && next.chain) setDraft(chainToInput(next.chain));
    setError(next.error ?? null);
  }, []);

  const load = useCallback(
    async (probe = false, preserveDraft = false) => {
      try {
        const next = probe ? await bridge.relay.probe() : await bridge.relay.overview();
        applyOverview(next, preserveDraft);
        return next;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [applyOverview],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(true, dirty), 20_000);
    return () => window.clearInterval(timer);
  }, [dirty, load]);

  const availableHosts = useMemo(
    () => (overview?.hosts ?? []).filter((host) => !draft.nodes.some((node) => node.hostId === host.id)),
    [draft.nodes, overview?.hosts],
  );

  const update = (patch: Partial<RelayChainInput>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
  };

  const updateNode = (index: number, patch: Partial<RelayNodeConfig>) => {
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node, nodeIndex) => (nodeIndex === index ? { ...node, ...patch } : node)),
    }));
    setDirty(true);
  };

  const addNode = () => {
    const host = availableHosts.find((entry) => entry.id === selectedHost) ?? availableHosts[0];
    if (!host) return;
    setDraft((current) => ({
      ...current,
      nodes: [
        ...current.nodes,
        { hostId: host.id, label: host.label, region: "", publicHost: host.host, wgPort: 51820 },
      ],
    }));
    setSelectedHost("");
    setDirty(true);
  };

  const moveNode = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draft.nodes.length) return;
    setDraft((current) => {
      const nodes = [...current.nodes];
      [nodes[index], nodes[target]] = [nodes[target], nodes[index]];
      return { ...current, nodes };
    });
    setDirty(true);
  };

  const removeNode = (index: number) => {
    setDraft((current) => ({ ...current, nodes: current.nodes.filter((_node, nodeIndex) => nodeIndex !== index) }));
    setDirty(true);
  };

  const save = async () => {
    const origin = draft.originHost.trim();
    if (!origin || /\s/.test(origin)) {
      const message = origin
        ? "Origin host cannot contain spaces."
        : "Origin host is required: the exit hop forwards traffic to this address.";
      setError(message);
      onToast("error", "Relay chain not saved", message);
      originRef.current?.focus();
      return;
    }
    setBusy("save");
    setError(null);
    try {
      await bridge.relay.save(draft);
      setDirty(false);
      await load();
      onToast("ok", "Relay chain saved", `${draft.nodes.length} hops · entry :${draft.entryPort}`);
    } catch (err) {
      const message = readableError(err);
      setError(message);
      onToast("error", "Relay chain not saved", message);
    } finally {
      setBusy(null);
    }
  };

  const probe = async () => {
    setBusy("probe");
    try {
      await load(true, dirty);
      onToast("ok", "Relay probes complete", "WireGuard + HAProxy state sampled on every hop");
    } catch (err) {
      onToast("error", "Relay probe failed", readableError(err));
    } finally {
      setBusy(null);
    }
  };

  const deploy = async () => {
    const warning =
      `Deploy this chain to ${draft.nodes.length} hosts?\n\n` +
      `Entry: 0.0.0.0:${draft.entryPort} → ${draft.relayPort} over WireGuard → ${draft.originHost}:${draft.originPort}\n\n` +
      (draft.obfuscation === "tls"
        ? "TLS camouflage will be enabled on the public entry. Nexus will generate a self-signed certificate, print its SHA-256 fingerprint, and keep it for this install. Clients must pin that fingerprint; this does not hide traffic timing.\n\n"
        : "No obfuscation layer will be installed; the entry remains plain TCP over WireGuard.\n\n") +
      "Nexus will install wireguard-tools, haproxy and (for TLS) openssl, create the dedicated nexus0 interface, and start a dedicated nexus-relay service. It refuses to overwrite an existing HAProxy service or a non-Nexus WireGuard/relay config. Every hop needs root SSH.";
    if (!window.confirm(warning)) return;
    setBusy("deploy");
    setError(null);
    setOutputs([]);
    try {
      const result = await bridge.relay.deploy();
      setOutputs(result.outputs);
      if (result.ok) {
        onToast("ok", "Relay chain deployed", `${result.chain.nodes.length} hops online`);
      } else {
        setError(result.error ?? "deployment failed; applied hops were rolled back");
        onToast("error", "Relay deployment rolled back", result.error ?? "one hop failed");
      }
      await load(true);
    } catch (err) {
      const message = readableError(err);
      setError(message);
      onToast("error", "Relay deployment failed", message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm("Stop and remove the relay service and nexus0 interface on every hop? The saved chain stays in Nexus.")) return;
    setBusy("remove");
    try {
      const result = await bridge.relay.remove();
      setOutputs(result.outputs);
      onToast(result.ok ? "ok" : "warn", result.ok ? "Relay chain stopped" : "Teardown incomplete", result.error);
      await load(true);
    } catch (err) {
      onToast("error", "Teardown failed", readableError(err));
    } finally {
      setBusy(null);
    }
  };

  const harden = async () => {
    if (!draft.nodes.length) return;
    setBusy("harden");
    let ok = 0;
    try {
      for (const node of draft.nodes) {
        const state = await bridge.security.resident(node.hostId, true);
        if (state.active) ok += 1;
      }
      onToast(ok === draft.nodes.length ? "ok" : "warn", "Resident bots enabled", `${ok}/${draft.nodes.length} hops active`);
    } catch (err) {
      onToast("error", "Resident bot failed", readableError(err));
    } finally {
      setBusy(null);
    }
  };

  const statuses = new Map((overview?.statuses ?? []).map((status) => [status.hostId, status]));
  const plan = overview?.plan;
  const tlsEntryReady = draft.obfuscation !== "tls" || tlsReviewed;
  const total = draft.nodes.length;
  const nonRootHops = overview
    ? draft.nodes.filter((node) => {
        const host = hostFor(overview, node.hostId);
        return host && host.username !== "root";
      })
    : [];

  return (
    <div className="relay-fabric">
      <div className="fabric-head">
        <div>
          <span className="eyebrow">STREAM RELAY</span>
          <h2>Multi-hop ingress chain</h2>
          <p>
            Public traffic lands on the entry hop, crosses an encrypted WireGuard mesh, and exits at the origin. Management stays on SSH;
            there is no second public port on the middle or exit nodes.
          </p>
        </div>
        <div className="fabric-head-actions">
          <button className="btn small ghost" onClick={() => void probe()} disabled={busy !== null || !overview?.chain}>
            <Icon name="activity" size={13} className={busy === "probe" ? "spin" : ""} /> Probe
          </button>
          <button
            className="btn small primary"
            onClick={() => void deploy()}
            disabled={busy !== null || !overview?.chain || dirty || nonRootHops.length > 0 || !tlsEntryReady}
            title={nonRootHops.length > 0 ? "Deploy requires a root SSH account on every hop" : !tlsEntryReady ? "Review the TLS camouflage warning first" : undefined}
          >
            <Icon name="play" size={13} /> Deploy
          </button>
        </div>
      </div>

      {error ? (
        <div className="error-banner">
          <Icon name="alert" size={16} />
          <div>
            <strong>Relay fabric error</strong>
            <span>{error}</span>
          </div>
        </div>
      ) : null}

      <div className="fabric-grid">
        <Panel
          eyebrow="TOPOLOGY"
          title={draft.name || "Untitled chain"}
          actions={
            <span className="mono subtle">
              {total} hop{total === 1 ? "" : "s"} · {dirty ? "unsaved" : overview?.chain ? "saved" : "draft"}
            </span>
          }
        >
          {!overview ? (
            <p className="subtle small">Loading relay topology…</p>
          ) : overview.hosts.length === 0 ? (
            <div className="empty-inline">
              <Icon name="terminal" size={20} />
              <div>
                <strong>Add Linux hosts first</strong>
                <p>The relay builder uses the SSH hosts already in Nexus. No new credential store is introduced.</p>
                <button className="btn small ghost" onClick={onOpenConnections}>
                  <Icon name="plus" size={12} /> Open connections
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="relay-chain">
                {draft.nodes.map((node, index) => {
                  const role = roleAt(index, total);
                  const status = statuses.get(node.hostId);
                  return (
                    <div className="relay-hop" key={`${node.hostId}-${index}`}>
                      <div className="relay-hop-index mono">{String(index + 1).padStart(2, "0")}</div>
                      <div className="relay-hop-body">
                        <div className="relay-hop-title">
                          <strong>{node.label}</strong>
                          <Chip tone={role === "entry" ? "info" : role === "exit" ? "ok" : "muted"}>{ROLE_LABEL[role]}</Chip>
                          {status ? <Chip tone={statusTone(status)} dot>{status.health}</Chip> : null}
                          <span className="mono subtle small">{node.publicHost || hostFor(overview, node.hostId)?.host}</span>
                        </div>
                        <div className="relay-hop-fields">
                          <label className="field">
                            <span>Region</span>
                            <input
                              value={node.region}
                              placeholder="Ashburn, VA"
                              onChange={(event) => updateNode(index, { region: event.target.value })}
                            />
                          </label>
                          <label className="field">
                            <span>Public endpoint</span>
                            <input
                              value={node.publicHost ?? ""}
                              placeholder="203.0.113.10"
                              onChange={(event) => updateNode(index, { publicHost: event.target.value })}
                            />
                          </label>
                          <label className="field">
                            <span>WG UDP port</span>
                            <input
                              type="number"
                              min={1}
                              max={65535}
                              value={node.wgPort}
                              onChange={(event) => updateNode(index, { wgPort: Number(event.target.value) || 51820 })}
                            />
                          </label>
                        </div>
                        {status ? (
                          <div className="relay-hop-status mono">
                            <span>{status.latencyMs} ms</span>
                            <span>wg {status.wgActive ? "up" : "down"}</span>
                            <span>relay {status.relayActive ? "up" : "down"}</span>
                            <span>{status.peers} peers</span>
                            <span>{status.listener ? "listener" : "no listener"}</span>
                            {status.tls ? <span title={status.tlsFingerprint}>tls pinned</span> : null}
                            {status.error ? <em title={status.error}>{status.error.slice(0, 44)}</em> : null}
                          </div>
                        ) : null}
                        {role === "entry" && status?.tlsFingerprint ? (
                          <p className="mono relay-fingerprint" title="Pin this SHA-256 fingerprint in every client">
                            TLS SHA-256 {status.tlsFingerprint}
                          </p>
                        ) : null}
                      </div>
                      <div className="relay-hop-tools">
                        <button className="btn icon ghost" onClick={() => moveNode(index, -1)} disabled={index === 0} title="Move up">
                          ↑
                        </button>
                        <button className="btn icon ghost" onClick={() => moveNode(index, 1)} disabled={index === total - 1} title="Move down">
                          ↓
                        </button>
                        <button className="btn icon ghost danger" onClick={() => removeNode(index)} title="Remove hop">
                          <Icon name="trash" size={12} />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {draft.nodes.length === 0 ? (
                  <div className="relay-empty">
                    <Icon name="plug" size={22} />
                    <strong>No hops yet</strong>
                    <p>Add at least an entry and exit host. Order is the path traffic takes.</p>
                  </div>
                ) : null}
              </div>

              <div className="relay-add">
                <select value={selectedHost} onChange={(event) => setSelectedHost(event.target.value)} disabled={availableHosts.length === 0}>
                  <option value="">{availableHosts.length ? "Select a Linux host…" : "All configured hosts are in the chain"}</option>
                  {availableHosts.map((host) => (
                    <option value={host.id} key={host.id}>
                      {host.label} · {host.host}{host.username !== "root" ? " · root SSH required" : ""}
                    </option>
                  ))}
                </select>
                <button className="btn small ghost" onClick={addNode} disabled={availableHosts.length === 0}>
                  <Icon name="plus" size={12} /> Add hop
                </button>
              </div>
              {nonRootHops.length > 0 ? (
                <p className="relay-warning">
                  <Icon name="alert" size={12} /> Deploy needs a root SSH account on every hop:{" "}
                  {nonRootHops.map((node) => node.label).join(", ")}. Save the chain, switch those hosts to root or a root key, then deploy.
                </p>
              ) : null}
            </>
          )}
        </Panel>

        <div className="stack">
          <Panel eyebrow="INGRESS" title="Chain settings">
            <div className="form-grid">
              <label className="field wide">
                <span>Chain name</span>
                <input value={draft.name} onChange={(event) => update({ name: event.target.value })} placeholder="US stream relay" />
              </label>
              <label className="field">
                <span>Public entry port</span>
                <input type="number" value={draft.entryPort} onChange={(event) => update({ entryPort: Number(event.target.value) || 7443 })} />
              </label>
              <label className="field">
                <span>Private relay port</span>
                <input type="number" value={draft.relayPort} onChange={(event) => update({ relayPort: Number(event.target.value) || 7444 })} />
              </label>
              <label className="field">
                <span>Origin host (required)</span>
                <input
                  ref={originRef}
                  value={draft.originHost}
                  onChange={(event) => update({ originHost: event.target.value })}
                  placeholder="origin IP or DNS name"
                  aria-invalid={!draft.originHost.trim()}
                />
              </label>
              <label className="field">
                <span>Origin port</span>
                <input type="number" value={draft.originPort} onChange={(event) => update({ originPort: Number(event.target.value) || 25565 })} />
              </label>
              <label className="field">
                <span>MTU</span>
                <input type="number" min={1280} max={1500} value={draft.mtu} onChange={(event) => update({ mtu: Number(event.target.value) || 1420 })} />
              </label>
              <div className="field">
                <span>Transport</span>
                <div className="fabric-transport">
                  <Icon name="shield" size={13} />
                  <strong>WireGuard</strong>
                  <em>Noise IK · ChaCha20-Poly1305</em>
                </div>
              </div>
              <label className="field">
                <span>Public entry obfuscation</span>
                <select
                  value={draft.obfuscation ?? "none"}
                  onChange={(event) => update({ obfuscation: event.target.value === "tls" ? "tls" : "none" })}
                >
                  <option value="none">None · plain WireGuard TCP</option>
                  <option value="tls">TLS 1.2+ camouflage · opt in</option>
                </select>
              </label>
            </div>
            {draft.obfuscation === "tls" ? (
              <label className="review-check relay-review-check">
                <input type="checkbox" checked={tlsReviewed} onChange={(event) => setTlsReviewed(event.target.checked)} />
                <span>
                  I reviewed the TLS boundary: only the public entry is wrapped, it uses a generated self-signed certificate
                  that clients must pin, and it does not hide traffic timing or provide client certificates.
                </span>
              </label>
            ) : null}
            <div className="action-row">
              <button className="btn small primary" onClick={() => void save()} disabled={busy !== null || draft.nodes.length < 2}>
                {busy === "save" ? "Saving…" : "Save chain"}
              </button>
              <button className="btn small ghost" onClick={() => void harden()} disabled={busy !== null || draft.nodes.length === 0}>
                <Icon name="shield" size={12} /> Harden hops
              </button>
              <button className="btn small ghost danger" onClick={() => void remove()} disabled={busy !== null || !overview?.chain}>
                Tear down
              </button>
            </div>
            <p className="hint">
              WireGuard is the encryption layer. TLS camouflage is a separate, explicitly reviewed entry layer and is never enabled
              silently. The public entry is TCP; UDP game traffic is not proxied by this chain.
            </p>
          </Panel>

          <Panel eyebrow="PATH" title="Deployment plan">
            {plan ? (
              <div className="relay-plan">
                {plan.hops.map((hop) => (
                  <div className="relay-plan-hop" key={`${hop.hostId}-${hop.index}`}>
                    <span className="mono subtle">{String(hop.index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{hop.label}</strong>
                      <span className="mono small">{hop.listen}</span>
                    </div>
                    <span className="mono small">→ {hop.forwardTo}</span>
                    {statuses.get(hop.hostId) ? <StatusDot state={statuses.get(hop.hostId)!.health} /> : null}
                  </div>
                ))}
                <div className="relay-plan-meta">
                  <span className="mono">origin {plan.origin}</span>
                  <span className="mono">{plan.encryption}</span>
                  <span className="mono">{plan.obfuscation}</span>
                </div>
                {plan.warnings.map((warning) => (
                  <p className="relay-warning" key={warning}>
                    <Icon name="alert" size={12} /> {warning}
                  </p>
                ))}
              </div>
            ) : (
              <p className="subtle small">Save a chain with at least two hops to generate a plan.</p>
            )}
          </Panel>

          {outputs.length > 0 ? (
            <Panel eyebrow="DEPLOY LOG" title="Remote output" flush>
              <pre className="relay-output mono">
                {outputs
                  .map((output) => `[${output.ok ? "ok" : "fail"}] ${output.label}\n${output.output || "(no output)"}`)
                  .join("\n\n")}
              </pre>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function hostFor(overview: RelayOverview, hostId: string) {
  return overview.hosts.find((host) => host.id === hostId);
}
