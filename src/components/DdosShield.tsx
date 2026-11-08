import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DdosConfig,
  DdosIncident,
  DdosLimits,
  DdosMode,
  DdosOverview,
  DdosStatus,
} from "../../shared/types";
import { bridge } from "../lib/bridge";
import { ago } from "../lib/format";
import { DdosGauges } from "./DdosGauges";
import { Icon } from "./Icon";
import { Chip, Panel, Sparkline } from "./ui";

const MODES: Array<{ id: DdosMode; label: string; hint: string }> = [
  { id: "observe", label: "Observe", hint: "Count and sample only. Nothing is dropped." },
  { id: "defend", label: "Defend", hint: "Per-port ceilings, malformed drops and automatic bans." },
  { id: "lockdown", label: "Lockdown", hint: "Defend with the tighter half-rate profile." },
];

function fmtRate(bitsPerSecond: number): string {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return "0 bps";
  if (bitsPerSecond >= 1e9) return `${(bitsPerSecond / 1e9).toFixed(2)} Gbps`;
  if (bitsPerSecond >= 1e6) return `${(bitsPerSecond / 1e6).toFixed(1)} Mbps`;
  if (bitsPerSecond >= 1e3) return `${(bitsPerSecond / 1e3).toFixed(0)} Kbps`;
  return `${bitsPerSecond.toFixed(0)} bps`;
}

function fmtPps(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 pps";
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M pps`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K pps`;
  return `${Math.round(value)} pps`;
}

function fmtPorts(ports: Array<{ from: number; to: number }>): string {
  return ports.map((range) => (range.from === range.to ? String(range.from) : `${range.from}-${range.to}`)).join(", ");
}

function toneFor(status: DdosStatus | undefined): "ok" | "warn" | "err" | "muted" {
  if (!status || status.health === "offline") return "err";
  if (status.mode === "lockdown" || status.tight) return "warn";
  return "ok";
}

export function DdosShield({
  onToast,
  onOpenConnections,
}: {
  onToast: (level: "info" | "warn" | "error" | "ok", title: string, detail?: string) => void;
  onOpenConnections: () => void;
}) {
  const [overview, setOverview] = useState<DdosOverview | null>(null);
  const [history, setHistory] = useState<Array<{ t: number; bps: number; pps: number; drops: number }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<string | null>(null);
  const [allowInput, setAllowInput] = useState("");
  const [draftLimits, setDraftLimits] = useState<DdosLimits | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await bridge.ddos.overview();
      setOverview(next);
      setError(next.error ?? null);
      setPendingInstall((current) => current ?? next.edgeHostId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const status = overview?.status;
  const hostId = overview?.edgeHostId;
  const config = overview?.config;
  const installed = Boolean(status?.installed);
  const online = Boolean(status?.running && status.health !== "offline");
  const limits = draftLimits ?? status?.limits ?? config?.limits ?? null;

  useEffect(() => {
    if (!status?.sampledAt) return;
    const point = {
      t: status.sampledAt,
      bps: status.ingressBps,
      pps: status.ingressPps,
      drops: status.drops.total,
    };
    setHistory((current) => {
      if (current.length > 0 && current[current.length - 1].t === point.t) return current;
      return [...current, point].slice(-60);
    });
  }, [status?.sampledAt, status?.ingressBps, status?.ingressPps, status?.drops.total]);

  const events = useMemo(() => {
    const local: DdosIncident[] = overview?.incidents ?? [];
    const remote: DdosIncident[] = (status?.recent ?? []).map((entry, index) => ({
      id: `remote-${entry.at}-${index}`,
      at: entry.at,
      kind: (entry.kind as DdosIncident["kind"]) ?? "attack",
      message: entry.message,
    }));
    return [...local, ...remote]
      .filter((entry, index, all) => all.findIndex((other) => other.at === entry.at && other.message === entry.message) === index)
      .sort((left, right) => right.at - left.at)
      .slice(0, 40);
  }, [overview?.incidents, status?.recent]);

  const toastError = (title: string, err: unknown) => {
    onToast("error", title, err instanceof Error ? err.message : String(err));
  };

  const install = async (id: string) => {
    setBusy("install");
    try {
      const result = await bridge.ddos.install(id);
      onToast("ok", "Edge shield installed", `mode ${result.status?.mode ?? "defend"} · ${result.status?.forwards.length ?? 0} forwards`);
      setPendingInstall(null);
      await load();
    } catch (err) {
      toastError("Install failed", err);
    } finally {
      setBusy(null);
    }
  };

  const sample = async () => {
    if (!hostId) return;
    setBusy("refresh");
    try {
      const next = await bridge.ddos.status(hostId);
      setOverview((current) => (current ? { ...current, status: next, error: next.error } : current));
      setError(next.error ?? null);
    } catch (err) {
      toastError("Could not sample the edge", err);
    } finally {
      setBusy(null);
    }
  };

  const setMode = async (mode: DdosMode) => {
    if (!hostId) return;
    setBusy(`mode:${mode}`);
    try {
      const next = await bridge.ddos.setMode(hostId, mode);
      setOverview((current) => (current ? { ...current, status: next, config: { ...current.config, mode } } : current));
      onToast("ok", `Shield ${mode}`, mode === "observe" ? "Nothing is being dropped." : "Rate ceilings and auto-bans are live.");
    } catch (err) {
      toastError("Mode change rejected", err);
    } finally {
      setBusy(null);
    }
  };

  const ban = async (ip: string) => {
    if (!hostId) return;
    setBusy(`ban:${ip}`);
    try {
      const next = await bridge.ddos.ban(hostId, ip, undefined, "operator");
      setOverview((current) => (current ? { ...current, status: next } : current));
      onToast("ok", `Banned ${ip}`, "Drop rule is live at the edge.");
    } catch (err) {
      toastError(`Could not ban ${ip}`, err);
    } finally {
      setBusy(null);
    }
  };

  const unban = async (ip: string) => {
    if (!hostId) return;
    setBusy(`unban:${ip}`);
    try {
      const next = await bridge.ddos.unban(hostId, ip);
      setOverview((current) => (current ? { ...current, status: next } : current));
      onToast("ok", `Unbanned ${ip}`);
    } catch (err) {
      toastError(`Could not unban ${ip}`, err);
    } finally {
      setBusy(null);
    }
  };

  const allow = async (ip: string, add: boolean) => {
    if (!hostId) return;
    setBusy(`allow:${ip}`);
    try {
      const next = await bridge.ddos.allow(hostId, ip, add);
      setOverview((current) => (current ? { ...current, status: next } : current));
      setAllowInput("");
      onToast("ok", add ? `Allowlisted ${ip}` : `Removed ${ip}`, add ? "This address now bypasses rate limits and auto-bans." : undefined);
    } catch (err) {
      toastError("Allowlist change failed", err);
    } finally {
      setBusy(null);
    }
  };

  const apply = async (patch: Partial<DdosConfig>, label: string) => {
    if (!hostId) return;
    setBusy(`apply:${label}`);
    try {
      const next = await bridge.ddos.apply(hostId, patch);
      setOverview((current) =>
        current
          ? {
              ...current,
              status: next,
              config: {
                ...current.config,
                ...patch,
                limits: { ...current.config.limits, ...(patch.limits ?? {}) },
              },
            }
          : current,
      );
      setDraftLimits(next.limits);
      onToast("ok", "Edge policy applied", label);
    } catch (err) {
      toastError("Policy rejected", err);
    } finally {
      setBusy(null);
    }
  };

  const saveLimits = async () => {
    if (!limits) return;
    await apply({ limits }, `udp ${limits.udpPps} pps · tcp ${limits.tcpNewPerSec}/s`);
  };

  const toggleForward = async (id: string) => {
    const forwards = (status?.forwards ?? config?.forwards ?? []).map((entry) =>
      entry.id === id ? { ...entry, enabled: !entry.enabled } : entry,
    );
    await apply({ forwards }, `forward ${id} toggled`);
  };

  const last = history[history.length - 1];
  const peak = history.reduce((max, point) => Math.max(max, point.bps), 0);
  const blocked = status?.blocked ?? [];

  return (
    <div className="stack ddos">
      {error ? (
        <div className="warn-banner">
          <Icon name="alert" size={14} />
          <span>{error}</span>
          <button className="btn small ghost" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {!installed ? (
        <Panel
          eyebrow="EDGE MITIGATION"
          title={overview?.edgeHostId ? "Shield not installed on this host" : "Choose the edge host"}
          actions={
            <button className="btn small ghost" onClick={onOpenConnections}>
              <Icon name="plug" size={13} /> Connections
            </button>
          }
        >
          <p className="ddos-copy">
            The shield runs on the public relay and keeps the existing WireGuard path. Installation backs up the live ruleset,
            starts the daemon, and only then removes the legacy relay tables. If the daemon fails its health check, the old
            forwarding stays untouched.
          </p>
          <div className="ddos-host-list">
            {(overview?.candidates ?? []).map((host) => (
              <div className={`ddos-host ${pendingInstall === host.id ? "selected" : ""}`} key={host.id}>
                <span className="ddos-host-dot" style={{ background: host.color }} />
                <div>
                  <strong>{host.label}</strong>
                  <span className="mono">
                    {host.username}@{host.host}:{host.port}
                    {host.authMode === "password" ? " · password" : " · key"}
                  </span>
                </div>
                <button className="btn small" onClick={() => setPendingInstall(host.id)}>
                  Select
                </button>
              </div>
            ))}
          </div>
          {pendingInstall ? (
            <div className="ddos-confirm">
              <div>
                <strong>Adopt the relay on {overview?.candidates.find((host) => host.id === pendingInstall)?.label ?? pendingInstall}?</strong>
                <span>Existing forwards are preserved. This is a firewall change, not a reinstall of the game stack.</span>
              </div>
              <div className="ddos-confirm-actions">
                <button className="btn small primary" onClick={() => void install(pendingInstall)} disabled={busy === "install"}>
                  {busy === "install" ? "Installing…" : "Install and cut over"}
                </button>
                <button className="btn small ghost" onClick={() => setPendingInstall(null)} disabled={busy === "install"}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {overview?.candidates.length === 0 ? (
            <p className="ddos-copy">No Linux hosts yet. Add the relay under Connections first.</p>
          ) : null}
        </Panel>
      ) : null}

      <Panel
        eyebrow="EDGE MITIGATION"
        title={status ? `${status.publicIp || "edge"} · ${status.wan}` : "Edge shield"}
        actions={
          <div className="ddos-head-actions">
            {status ? <Chip tone={toneFor(status)}>{online ? (status.tight ? "attack window" : status.mode) : "offline"}</Chip> : null}
            <button className="btn small ghost" onClick={() => void sample()} disabled={!hostId || busy === "refresh"}>
              <Icon name="refresh" size={13} className={busy === "refresh" ? "spin" : ""} /> Sample
            </button>
          </div>
        }
      >
        <div className="ddos-hero">
          <div className={`ddos-core ${online ? (status?.tight ? "hot" : "calm") : "cold"}`}>
            <span className="ddos-core-glyph">
              <Icon name="shield" size={38} />
            </span>
            <div>
              <strong>{online ? (status?.tight ? "Mitigating" : "Shield online") : installed ? "Shield offline" : "Not installed"}</strong>
              <span>
                {online
                  ? `${status?.forwards.length ?? 0} protected forwards · up ${Math.max(1, Math.round((status?.uptimeSec ?? 0) / 3600))}h`
                  : "Protection is enforced by the edge daemon, not this window."}
              </span>
            </div>
          </div>
          <div className="ddos-modes" role="group" aria-label="Shield mode">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                className={`ddos-mode ${status?.mode === mode.id ? "active" : ""}`}
                onClick={() => void setMode(mode.id)}
                disabled={!online || busy === `mode:${mode.id}`}
                title={mode.hint}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="ddos-spark">
            <div className="ddos-spark-head">
              <span>Ingress</span>
              <strong className="mono">{fmtRate(last?.bps ?? status?.ingressBps ?? 0)}</strong>
            </div>
            <Sparkline data={history.length > 1 ? history.map((point) => point.bps) : [0, 0]} width={250} height={48} tone={status?.tight ? "amber" : "cyan"} />
            <div className="ddos-spark-foot mono">
              <span>{fmtPps(status?.ingressPps ?? 0)}</span>
              <span>peak {fmtRate(peak)}</span>
            </div>
          </div>
        </div>

        {status ? <DdosGauges status={status} history={history} online={online} /> : null}
      </Panel>

      {online ? (
        <>
          <div className="ddos-columns">
            <Panel
              eyebrow="TOP TALKERS"
              title="Sources by packet rate"
              actions={<span className="ddos-muted mono">{status ? `sampled ${ago(status.sampledAt)}` : ""}</span>}
            >
              {(status?.sources.length ?? 0) === 0 ? (
                <p className="ddos-empty">No active sources above the sampling floor. This is normal on a quiet edge.</p>
              ) : (
                <div className="ddos-table-wrap">
                  <table className="ddos-table">
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>Rate</th>
                        <th>Volume</th>
                        <th>Conns</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {(status?.sources ?? []).map((source) => (
                        <tr key={source.ip} className={source.blocked ? "blocked" : source.pps >= (limits?.autoBanPps ?? 0) ? "hot" : ""}>
                          <td className="mono">
                            {source.ip}
                            {source.blocked ? <Chip tone="err">blocked</Chip> : null}
                            {source.allowlisted ? <Chip tone="muted">allowed</Chip> : null}
                          </td>
                          <td className="mono">{fmtPps(source.pps)}</td>
                          <td className="mono">{fmtRate(source.bps)}</td>
                          <td className="mono">{source.connections}</td>
                          <td className="ddos-row-actions">
                            {source.blocked ? (
                              <button className="btn small ghost" onClick={() => void unban(source.ip)} disabled={busy === `unban:${source.ip}`}>
                                Unban
                              </button>
                            ) : (
                              <button className="btn small" onClick={() => void ban(source.ip)} disabled={busy === `ban:${source.ip}`}>
                                Ban
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel
              eyebrow="CONTAINMENT"
              title={`${blocked.length} address${blocked.length === 1 ? "" : "es"} in the drop set`}
              actions={<Chip tone={status?.autoBan ? "ok" : "muted"}>{status?.autoBan ? "auto-ban on" : "auto-ban off"}</Chip>}
            >
              <div className="ddos-chips">
                {blocked.length === 0 ? <p className="ddos-empty">The drop set is empty.</p> : null}
                {blocked.map((ip) => (
                  <button key={ip} className="ddos-chip" onClick={() => void unban(ip)} title="Remove this ban">
                    <span className="mono">{ip}</span>
                    <Icon name="close" size={11} />
                  </button>
                ))}
              </div>
              <div className="ddos-subhead">
                <strong>Allowlist</strong>
                <span>Bypasses rate limits and auto-bans.</span>
              </div>
              <div className="ddos-chips">
                {(status?.allowlist ?? []).map((ip) => (
                  <button key={ip} className="ddos-chip allow" onClick={() => void allow(ip, false)} title="Remove from allowlist">
                    <span className="mono">{ip}</span>
                    <Icon name="close" size={11} />
                  </button>
                ))}
                {(status?.allowlist.length ?? 0) === 0 ? <p className="ddos-empty">No allowlisted addresses.</p> : null}
              </div>
              <div className="ddos-inline-form">
                <input
                  value={allowInput}
                  onChange={(event) => setAllowInput(event.target.value)}
                  placeholder="203.0.113.10"
                  aria-label="Allowlist address"
                  className="mono"
                />
                <button
                  className="btn small"
                  onClick={() => void allow(allowInput.trim(), true)}
                  disabled={!hostId || !allowInput.trim() || busy === `allow:${allowInput.trim()}`}
                >
                  Allow
                </button>
              </div>
            </Panel>
          </div>

          <div className="ddos-columns">
            <Panel eyebrow="DNAT" title="Protected forwards" actions={<span className="ddos-muted mono">WireGuard → {config?.wireguardInterface ?? "wg0"}</span>}>
              <div className="ddos-table-wrap">
                <table className="ddos-table">
                  <thead>
                    <tr>
                      <th>Service</th>
                      <th>Ports</th>
                      <th>Ceiling</th>
                      <th>Target</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(status?.forwards ?? config?.forwards ?? []).map((forward) => (
                      <tr key={forward.id} className={forward.enabled ? "" : "disabled"}>
                        <td>
                          <strong>{forward.label}</strong>
                          <span className="ddos-proto">{forward.proto}</span>
                        </td>
                        <td className="mono">{fmtPorts(forward.ports)}</td>
                        <td className="mono">{forward.proto === "udp" ? `${(forward.pps ?? limits?.udpPps ?? 0).toLocaleString()} pps` : `${(limits?.tcpNewPerSec ?? 0).toLocaleString()}/s`}</td>
                        <td className="mono">{forward.target}</td>
                        <td className="ddos-row-actions">
                          <button
                            className={`ddos-toggle ${forward.enabled ? "on" : ""}`}
                            onClick={() => void toggleForward(forward.id)}
                            disabled={busy === "apply:forward toggled" || busy?.startsWith("apply:")}
                            aria-label={`${forward.enabled ? "Disable" : "Enable"} ${forward.label}`}
                          >
                            <i />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="ddos-note">
                Disabling a forward removes its public DNAT immediately. The origin is still reachable over the encrypted
                WireGuard backhaul; nothing about this table opens a new port.
              </p>
            </Panel>

            <Panel eyebrow="POLICY" title="Rate ceilings and auto-ban">
              {limits ? (
                <div className="ddos-form">
                  <label>
                    <span>UDP packets / second</span>
                    <input
                      type="number"
                      min={50}
                      max={200000}
                      value={limits.udpPps}
                      onChange={(event) => setDraftLimits({ ...limits, udpPps: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    <span>TCP new connections / second</span>
                    <input
                      type="number"
                      min={5}
                      max={20000}
                      value={limits.tcpNewPerSec}
                      onChange={(event) => setDraftLimits({ ...limits, tcpNewPerSec: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    <span>Auto-ban at (per-source pps)</span>
                    <input
                      type="number"
                      min={100}
                      max={200000}
                      value={limits.autoBanPps}
                      onChange={(event) => setDraftLimits({ ...limits, autoBanPps: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    <span>Ban duration (seconds)</span>
                    <input
                      type="number"
                      min={60}
                      max={604800}
                      value={limits.blockSeconds}
                      onChange={(event) => setDraftLimits({ ...limits, blockSeconds: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    <span>Samples before ban</span>
                    <input
                      type="number"
                      min={2}
                      max={60}
                      value={limits.autoBanSamples}
                      onChange={(event) => setDraftLimits({ ...limits, autoBanSamples: Number(event.target.value) })}
                    />
                  </label>
                  <div className="ddos-form-actions">
                    <button className="btn small primary" onClick={() => void saveLimits()} disabled={busy?.startsWith("apply:")}>
                      Push policy
                    </button>
                    <button
                      className={`ddos-switch ${status?.autoBan ? "on" : ""}`}
                      onClick={() => void apply({ autoBan: !status?.autoBan }, `auto-ban ${status?.autoBan ? "off" : "on"}`)}
                      disabled={busy?.startsWith("apply:")}
                    >
                      <i />
                      <span>Auto-ban</span>
                    </button>
                    <button className="btn small ghost" onClick={() => setDraftLimits(status?.limits ?? null)}>
                      Reset
                    </button>
                  </div>
                  <p className="ddos-note">
                    During an attack the shield halves both ceilings for five minutes, then restores the values above.
                    These limits are enforced in the kernel before DNAT, so excess packets never reach the origin.
                  </p>
                </div>
              ) : (
                <p className="ddos-empty">No policy sampled yet.</p>
              )}
            </Panel>
          </div>
        </>
      ) : null}

      <Panel
        eyebrow="JOURNAL"
        title="Shield activity"
        actions={
          hostId ? (
            <button className="btn small ghost" onClick={() => void install(hostId)} disabled={busy === "install"}>
              {busy === "install" ? "Reinstalling…" : "Reinstall / upgrade"}
            </button>
          ) : null
        }
      >
        <div className="ddos-events">
          {events.length === 0 ? <p className="ddos-empty">No shield activity yet.</p> : null}
          {events.map((entry) => (
            <div className="ddos-event" key={entry.id}>
              <span className="mono">{new Date(entry.at).toLocaleTimeString()}</span>
              <Chip tone={entry.kind === "error" ? "err" : entry.kind === "attack" || entry.kind === "ban" ? "warn" : entry.kind === "install" ? "violet" : "muted"}>
                {entry.kind}
              </Chip>
              <span>{entry.message}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
