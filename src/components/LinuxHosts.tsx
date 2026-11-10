import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  HelperState,
  HelperStatus,
  SecurityJournalEntry,
  SshAuthMode,
  SshHostInput,
  SshHostSummary,
  SshRuntimeStatus,
  SshSnapshot,
  SshTestResult,
} from "../../shared/types";
import { bridge, isMockBridge } from "../lib/bridge";
import { noteHelper } from "../lib/helperFleet";
import { ago, bytes, cx, duration, pct, rate } from "../lib/format";
import { speedHistory, useSpeedHistory } from "../lib/speed";
import { linkLabel, shortRate } from "./Throughput";
import { Icon } from "./Icon";
import { SshTerminal } from "./SshTerminal";
import { VncConsole } from "./VncConsole";
import { Chip, Gauge, Modal, Panel, Skeleton, Sparkline, StatusDot, type Tone } from "./ui";
import { GpuTelemetryPanel } from "./GpuDial";
import { ServerHardware } from "./ServerHardware";
import { sshGpuAlertHostKey } from "../../shared/gpu-alerts";

const EMPTY: SshHostInput = {
  label: "",
  host: "",
  port: 22,
  username: "root",
  authMode: "key",
  keyPath: "~/.ssh/id_ed25519",
  password: "",
};

const POLL_MS = 8_000;

const HELPER_TONE: Record<HelperState, "ok" | "warn" | "err"> = {
  ready: "ok",
  missing: "warn",
  partial: "warn",
  outdated: "warn",
  blocked: "err",
};

const HELPER_LABEL: Record<HelperState, string> = {
  ready: "Helper ready",
  missing: "Helper missing",
  partial: "Helper partial",
  outdated: "Helper outdated",
  blocked: "No root route",
};

const ROUTE_LABEL: Record<HelperStatus["route"], string> = {
  root: "root account",
  nopasswd: "NOPASSWD grant",
  password: "stored password",
  none: "none",
};

/**
 * Records written before route/trigger became structured fields carry the same
 * values in the message. Read them for display only; new records never parse.
 */
function helperAudit(entry: SecurityJournalEntry): {
  route?: SecurityJournalEntry["route"];
  trigger?: SecurityJournalEntry["trigger"];
} {
  const match = /^helper install \((manual|automatic), route (root|nopasswd|password|none)\)/.exec(entry.message);
  return {
    route: entry.route ?? (match?.[2] as SecurityJournalEntry["route"] | undefined),
    trigger: entry.trigger ?? (match?.[1] as SecurityJournalEntry["trigger"] | undefined),
  };
}

/** Resident-enforcer records share kind "install" but are not helper installs. */
function isHelperInstall(entry: SecurityJournalEntry): boolean {
  return entry.kind === "install" && !entry.message.startsWith("resident enforcer");
}

/**
 * A key-auth host cannot reuse an SSH password for sudo, and the NOPASSWD
 * grant may only run the helper, not replace it. Any non-ready helper on such
 * a host therefore needs a sudo password typed for this one install.
 */
function helperNeedsSudoPassword(host: SshHostSummary, status: HelperStatus | undefined): boolean {
  return Boolean(
    status &&
      status.state !== "ready" &&
      status.state !== "blocked" &&
      status.route !== "root" &&
      host.authMode !== "password",
  );
}

interface Series {
  label: string;
  color: string;
  data: number[];
}

function LineChart({ series, height = 120, max }: { series: Series[]; height?: number; max?: number }) {
  const width = 640;
  const length = Math.max(2, ...series.map((entry) => entry.data.length));
  const ceiling = Math.max(max ?? 0, ...series.flatMap((entry) => entry.data), 1);
  const point = (value: number, index: number) => ({
    x: (index / (length - 1)) * width,
    y: height - 6 - (value / ceiling) * (height - 16),
  });
  return (
    <div className="line-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={series.map((entry) => entry.label).join(", ")}>
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line key={fraction} x1={0} x2={width} y1={height * fraction} y2={height * fraction} stroke="rgba(255,255,255,.05)" strokeWidth={1} />
        ))}
        {series.map((entry) => {
          if (entry.data.length < 2) return null;
          const path = entry.data.map((value, index) => `${index === 0 ? "M" : "L"} ${point(value, index).x} ${point(value, index).y}`).join(" ");
          return <path key={entry.label} d={path} fill="none" stroke={entry.color} strokeWidth={1.7} strokeLinejoin="round" />;
        })}
      </svg>
      <div className="line-legend">
        {series.map((entry) => (
          <span key={entry.label}>
            <i style={{ background: entry.color }} />
            {entry.label}
            <b className="mono">{(entry.data.at(-1) ?? 0).toFixed(1)}%</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export function LinuxHosts({
  onToast,
  onOpenNetwork,
  canManage = true,
}: {
  onToast: (level: "info" | "warn" | "error" | "ok", title: string, detail?: string) => void;
  onOpenNetwork?: () => void;
  canManage?: boolean;
}) {
  const [hosts, setHosts] = useState<SshHostSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SshSnapshot | null>(null);
  const [statuses, setStatuses] = useState<Record<string, SshRuntimeStatus>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SshHostInput | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SshTestResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const speed = useSpeedHistory();
  const [speeding, setSpeeding] = useState(false);
  const [vncBatch, setVncBatch] = useState<{
    running: boolean;
    done: number;
    total: number;
    ready: number;
    needs: number;
    skipped: number;
  } | null>(null);
  const [unit, setUnit] = useState("nginx");
  const [confirmKind, setConfirmKind] = useState<"reboot" | "shutdown" | "restart-service" | "stop-service" | "start-service" | "backup" | null>(null);
  const [acting, setActing] = useState(false);
  const [helpers, setHelpers] = useState<Record<string, HelperStatus>>({});
  const [helperBusy, setHelperBusy] = useState<string | null>(null);
  const [helperLog, setHelperLog] = useState<{ hostId: string; ok: boolean; text: string } | null>(null);
  const [retry, setRetry] = useState<{
    hostId: string;
    entryKey: string;
    startedAt: number;
    phase: "running" | "ok" | "failed";
    detail?: string;
  } | null>(null);
  const [retryNow, setRetryNow] = useState(() => Date.now());
  const [sudoDraft, setSudoDraft] = useState("");
  const [sudoPrompt, setSudoPrompt] = useState<{ host: SshHostSummary; entry?: SecurityJournalEntry } | null>(null);
  const [sudoPromptDraft, setSudoPromptDraft] = useState("");
  const [journal, setJournal] = useState<SecurityJournalEntry[]>([]);
  const [journalReady, setJournalReady] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({});
  const [consoleTab, setConsoleTab] = useState<"cli" | "vnc">("cli");
  const cancelled = useRef(false);

  const loadHosts = useCallback(async () => {
    const list = await bridge.ssh.hosts();
    setHosts(list);
    setActiveId((current) => (current && list.some((host) => host.id === current) ? current : list[0]?.id ?? null));
    return list;
  }, []);

  const loadJournal = useCallback(async () => {
    try {
      setJournal(await bridge.security.journal(300));
      setJournalReady(true);
    } catch {
      // The helper cards keep working without the journal feed.
    }
  }, []);

  useEffect(() => {
    if (retry?.phase !== "running") return;
    const timer = window.setInterval(() => setRetryNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [retry?.phase, retry?.entryKey]);

  useEffect(() => {
    cancelled.current = false;
    void loadHosts().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled.current = true;
    };
  }, [loadHosts]);

  const refresh = useCallback(async (hostId: string, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const next = await bridge.ssh.snapshot(hostId);
      if (cancelled.current) return;
      setSnapshot(next);
      setStatuses((current) => ({ ...current, [hostId]: next.status }));
      setError(next.status.health === "online" ? null : (next.status.error ?? "unreachable"));
    } catch (err) {
      if (cancelled.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatuses((current) => ({
        ...current,
        [hostId]: { id: hostId, health: "offline", latencyMs: 0, error: message, checkedAt: Date.now() },
      }));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // Card chips describe every host, so liveness is polled for the fleet rather
  // than only recorded for the host whose snapshot happens to be open.
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const report = await bridge.ssh.health();
        if (stopped) return;
        setStatuses((current) => {
          const next = { ...current };
          for (const item of report) {
            next[item.id] = {
              id: item.id,
              health: item.health,
              latencyMs: item.latencyMs,
              error: item.error,
              checkedAt: Date.now(),
            };
          }
          return next;
        });
      } catch {
        /* keep the last known status rather than inventing one */
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  // Helper readiness is per host and cheap (one authenticated command), so the
  // whole fleet is inspected on load instead of only when a card is opened.
  // A host that cannot be inspected keeps its previous value, not a guess.
  useEffect(() => {
    if (hosts.length === 0) return;
    let stopped = false;
    void (async () => {
      const report = await Promise.all(
        hosts.map(async (host) => {
          try {
            return await bridge.ssh.helper(host.id);
          } catch {
            return null;
          }
        }),
      );
      if (stopped) return;
      setHelpers((current) => {
        const next = { ...current };
        for (const status of report) if (status) next[status.hostId] = status;
        return next;
      });
      for (const status of report) if (status) noteHelper(status);
    })();
    return () => {
      stopped = true;
    };
  }, [hosts]);

  // Install records written by the UI, the fleet Fix all or the scheduler all
  // arrive here; poll so background auto-repairs show up without a manual reload.
  useEffect(() => {
    void loadJournal();
    const timer = window.setInterval(() => void loadJournal(), 20_000);
    return () => window.clearInterval(timer);
  }, [loadJournal]);

  useEffect(() => {
    if (!activeId) return;
    setSnapshot(null);
    setSudoDraft("");
    void refresh(activeId);
    const timer = window.setInterval(() => void refresh(activeId, true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeId, refresh]);

  const activeHost = useMemo(() => hosts.find((host) => host.id === activeId) ?? null, [hosts, activeId]);
  const helperStatus = activeHost ? helpers[activeHost.id] : undefined;

  const installHistory = useMemo(() => {
    const byHost = new Map<string, SecurityJournalEntry[]>();
    for (const entry of journal) {
      if (!isHelperInstall(entry)) continue;
      const list = byHost.get(entry.hostId) ?? [];
      list.push(entry);
      byHost.set(entry.hostId, list);
    }
    for (const list of byHost.values()) list.sort((a, b) => b.at - a.at);
    return byHost;
  }, [journal]);

  const startNew = () => {
    setResult(null);
    setFormError(null);
    setEditing({ ...EMPTY });
  };

  const startEdit = (host: SshHostSummary) => {
    setResult(null);
    setFormError(null);
    setEditing({
      id: host.id,
      label: host.label,
      host: host.host,
      port: host.port,
      username: host.username,
      authMode: host.authMode,
      keyPath: host.keyPath ?? "",
      password: "",
      vncPort: host.vncPort,
    });
  };

  const patch = (values: Partial<SshHostInput>) => setEditing((current) => (current ? { ...current, ...values } : current));

  const runTest = async () => {
    if (!editing) return;
    setTesting(true);
    setResult(null);
    setFormError(null);
    try {
      setResult(await bridge.ssh.test(editing));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setFormError(null);
    try {
      const saved = await bridge.ssh.save(editing);
      await loadHosts();
      setActiveId(saved.id);
      setEditing(null);
      onToast("ok", "Linux host saved", `${saved.username}@${saved.host}:${saved.port}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (host: SshHostSummary) => {
    try {
      await bridge.ssh.remove(host.id);
      speedHistory.forget(host.id);
      const list = await loadHosts();
      if (host.id === activeId) setActiveId(list[0]?.id ?? null);
      onToast("ok", "Host removed", host.label);
    } catch (err) {
      onToast("error", "Could not remove host", err instanceof Error ? err.message : String(err));
    }
  };

  const copySsh = (host: SshHostSummary) => {
    const key = host.authMode === "key" && host.keyPath ? `-i ${host.keyPath} ` : "";
    void navigator.clipboard
      .writeText(`ssh ${key}-p ${host.port} ${host.username}@${host.host}`)
      .then(() => onToast("ok", "SSH command copied"));
  };

  const checkHelper = async (hostId: string) => {
    try {
      const status = await bridge.ssh.helper(hostId);
      setHelpers((current) => ({ ...current, [hostId]: status }));
      noteHelper(status);
      return status;
    } catch (err) {
      onToast("error", "Helper check failed", err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const installHelper = async (host: SshHostSummary, sudoPassword?: string, retryEntry?: SecurityJournalEntry) => {
    if (helperBusy) return;
    const retryKey = retryEntry ? `${retryEntry.seq}-${retryEntry.at}` : null;
    if (retryKey) {
      setRetryNow(Date.now());
      setRetry({ hostId: host.id, entryKey: retryKey, startedAt: Date.now(), phase: "running" });
    } else {
      setRetry(null);
    }
    setHelperBusy(host.id);
    setHelperLog(null);
    try {
      const outcome = await bridge.ssh.installHelper(host.id, sudoPassword);
      if (outcome.status) {
        setHelpers((current) => ({ ...current, [host.id]: outcome.status as HelperStatus }));
        noteHelper(outcome.status);
      }
      setHelperLog({ hostId: host.id, ok: outcome.ok, text: outcome.output });
      if (outcome.ok) setSudoDraft("");
      if (retryKey) {
        setRetry({
          hostId: host.id,
          entryKey: retryKey,
          startedAt: Date.now(),
          phase: outcome.ok ? "ok" : "failed",
          detail: outcome.ok
            ? (outcome.status?.detail ?? "helper and sudoers installed")
            : (outcome.error ?? outcome.output).replace(/\s+/g, " ").trim().slice(0, 160),
        });
      }
      onToast(
        outcome.ok ? "ok" : "error",
        outcome.ok ? `Privileged helper ready on ${host.label}` : `Helper install failed on ${host.label}`,
        outcome.ok
          ? "Service, power, backup and guard actions now run without a password prompt."
          : (outcome.error ?? outcome.output).slice(0, 200),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (retryKey) {
        setRetry({ hostId: host.id, entryKey: retryKey, startedAt: Date.now(), phase: "failed", detail: message });
      }
      setHelperLog({ hostId: host.id, ok: false, text: message });
      onToast("error", "Helper install failed", message);
    } finally {
      setHelperBusy(null);
      void loadJournal();
    }
  };

  const requestHelperInstall = (host: SshHostSummary, entry?: SecurityJournalEntry) => {
    if (helperBusy) return;
    if (helperNeedsSudoPassword(host, helpers[host.id])) {
      setSudoPrompt({ host, entry });
      setSudoPromptDraft("");
      return;
    }
    void installHelper(host, undefined, entry);
  };

  const closeSudoPrompt = () => {
    if (helperBusy) return;
    setSudoPrompt(null);
    setSudoPromptDraft("");
  };

  const submitSudoPrompt = () => {
    if (!sudoPrompt || !sudoPromptDraft.trim() || helperBusy) return;
    const { host, entry } = sudoPrompt;
    const password = sudoPromptDraft;
    setSudoPrompt(null);
    setSudoPromptDraft("");
    void installHelper(host, password, entry);
  };

  const copyBootstrap = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => onToast("ok", "Bootstrap commands copied"));
  };

  const runSpeed = async (hostId?: string) => {
    setSpeeding(true);
    try {
      if (hostId) {
        const single = await bridge.ssh.speedtest(hostId);
        speedHistory.record(single);
        if (single.error) onToast("error", "Speed test failed", single.error);
        else onToast("ok", "Speed test complete", `${shortRate(single.downMbps)}b ↓ / ${shortRate(single.upMbps)}b ↑`);
      } else {
        const all = await bridge.ssh.speedtestAll();
        speedHistory.recordMany(all);
        const failed = all.filter((entry) => entry.error);
        onToast(failed.length ? "warn" : "ok", "Fleet speed test", `${all.length - failed.length}/${all.length} endpoints measured`);
      }
    } catch (err) {
      onToast("error", "Speed test failed", err instanceof Error ? err.message : String(err));
    } finally {
      setSpeeding(false);
    }
  };

  const setupAllVnc = async () => {
    if (!canManage || vncBatch?.running || hosts.length === 0) return;
    if (
      !window.confirm(
        `Install the loopback terminal console on ${hosts.length} SSH host${hosts.length === 1 ? "" : "s"}? ` +
          "This may install sway/wayvnc/foot or TigerVNC with root on each host. Existing VNC listeners are left alone.",
      )
    ) {
      return;
    }
    const total = hosts.length;
    let ready = 0;
    let needs = 0;
    let skipped = 0;
    setVncBatch({ running: true, done: 0, total, ready, needs, skipped });
    for (const host of hosts) {
      try {
        const probe = await bridge.vnc.preflight(host.id);
        if (probe.ok) {
          ready += 1;
          skipped += 1;
        } else {
          const outcome = await bridge.vnc.setup(host.id);
          if (outcome.ok) ready += 1;
          else needs += 1;
        }
      } catch {
        needs += 1;
      }
      setVncBatch({ running: true, done: ready + needs + skipped, total, ready, needs, skipped });
    }
    setVncBatch({ running: false, done: total, total, ready, needs, skipped });
    await loadHosts().catch(() => undefined);
    onToast(
      needs > 0 ? "warn" : "ok",
      "VNC fleet setup complete",
      `${ready}/${total} hosts ready${skipped > 0 ? ` (${skipped} already had a listener)` : ""}${
        needs > 0 ? ` · ${needs} need a sudo password or manual attention` : ""
      }`,
    );
  };

  const act = async () => {
    if (!activeId || !confirmKind) return;
    setActing(true);
    try {
      const outcome = await bridge.ssh.action(
        activeId,
        confirmKind,
        confirmKind === "restart-service" || confirmKind === "stop-service" || confirmKind === "start-service" ? unit : undefined,
      );
      onToast(outcome.ok ? "ok" : "error", `${confirmKind.replace("-", " ")} ${outcome.ok ? "sent" : "failed"}`, outcome.output.slice(0, 160));
      setConfirmKind(null);
      if (confirmKind !== "backup") window.setTimeout(() => activeId && void refresh(activeId, true), 1500);
    } catch (err) {
      onToast("error", "Action failed", err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  };

  const cpuSeries = snapshot?.samples.map((sample) => sample.cpu) ?? [];
  const memPct = snapshot ? pct(snapshot.memory.used, snapshot.memory.total) : 0;
  const swapPct = snapshot && snapshot.memory.swapTotal > 0 ? pct(snapshot.memory.swapUsed, snapshot.memory.swapTotal) : 0;
  const diskPct = snapshot?.disks[0] ? pct(snapshot.disks[0].used, snapshot.disks[0].size) : 0;
  const loadPct = snapshot && snapshot.cpu.cores > 0 ? Math.min(100, (snapshot.cpu.load[0] / snapshot.cpu.cores) * 100) : 0;
  const ioPct = Math.min(100, (snapshot?.pressure.io.some10 ?? 0) * 4);
  const failedUnits = snapshot?.services.filter((service) => service.state === "failed") ?? [];
  const runningUnits = snapshot?.services.filter((service) => service.state === "running") ?? [];
  const latest = snapshot?.samples.at(-1);

  const dials: Array<{ value: number; label: string; detail: string; tone: Tone }> = [
    { value: snapshot?.cpu.usage ?? 0, label: "CPU", detail: `${snapshot?.cpu.cores ?? 0} threads`, tone: (snapshot?.cpu.usage ?? 0) > 85 ? "amber" : "cyan" },
    { value: memPct, label: "MEM", detail: bytes(snapshot?.memory.total ?? 0), tone: memPct > 88 ? "red" : "violet" },
    { value: diskPct, label: "ROOT", detail: bytes(snapshot?.disks[0]?.size ?? 0), tone: diskPct > 90 ? "red" : "green" },
    { value: loadPct, label: "LOAD", detail: `1m ${(snapshot?.cpu.load[0] ?? 0).toFixed(2)}`, tone: loadPct > 80 ? "amber" : "cyan" },
  ];

  return (
    <div className="connections">
      <div className="stack">
        <Panel
          eyebrow="SSH FLEET"
          title="Linux hosts"
          actions={
            <div className="inline-actions">
              {canManage ? (
                <button
                  className="btn small ghost"
                  onClick={() => void setupAllVnc()}
                  disabled={Boolean(vncBatch?.running) || hosts.length === 0}
                  title="Install the loopback terminal console on every SSH host, including Proxmox nodes added here. Existing VNC listeners are left alone."
                >
                  <Icon name="terminal" size={13} className={vncBatch?.running ? "spin" : ""} />{" "}
                  {vncBatch?.running ? `VNC ${vncBatch.done}/${vncBatch.total}` : "VNC on all"}
                </button>
              ) : null}
              <button className="btn small ghost" onClick={() => void runSpeed()} disabled={speeding || hosts.length === 0}>
                <Icon name="activity" size={13} className={speeding ? "spin" : ""} /> {speeding ? "Measuring…" : "Speed test all"}
              </button>
              {canManage ? (
                <button className="btn small primary" onClick={startNew}>
                  <Icon name="plus" size={13} /> Add host
                </button>
              ) : null}
            </div>
          }
        >
          <div className="host-cards">
            {hosts.map((host) => {
              const status = statuses[host.id];
              const health = status?.health ?? "connecting";
              const measurement = speed[host.id]?.at(-1);
              const history = installHistory.get(host.id) ?? [];
              const historyExpanded = expandedHistory[host.id] === true;
              const recentHistory = historyExpanded ? history : history.slice(0, 3);
              return (
                <article className={cx("host-card", activeId === host.id && "active")} key={host.id} data-spot>
                  <header>
                    <span className="host-color" style={{ background: host.color }} />
                    <div>
                      <strong>{host.label}</strong>
                      <span className="mono subtle">
                        {host.username}@{host.host}:{host.port}
                      </span>
                    </div>
                    <span className="host-health">
                      <Chip tone={health === "online" ? "ok" : health === "offline" ? "err" : "muted"} dot>
                        {health}
                      </Chip>
                      {status && (status.latencyMs ?? 0) > 0 && health !== "connecting" ? (
                        <span className="host-latency mono" title="authenticated probe round trip">
                          {Math.round(status.latencyMs ?? 0)} ms
                        </span>
                      ) : null}
                    </span>
                  </header>
                  {health === "offline" && status?.error ? (
                    <p className="host-error" title={status.error}>
                      {status.error}
                    </p>
                  ) : null}
                  <div className="host-meta">
                    <span>
                      Auth <b>{host.authMode === "password" ? "password" : "key"}</b>
                    </span>
                    <span>
                      Seen <b>{ago(host.lastSeenAt)}</b>
                    </span>
                    {helpers[host.id] ? (
                      <button
                        type="button"
                        className={cx("helper-chip", `helper-${helpers[host.id].state}`)}
                        title={`${helpers[host.id].detail} · route: ${ROUTE_LABEL[helpers[host.id].route]}`}
                        disabled={helperBusy !== null || helpers[host.id].state === "ready" || helpers[host.id].state === "blocked"}
                        onClick={() => requestHelperInstall(host)}
                      >
                        <Icon name={helpers[host.id].state === "ready" ? "check" : "shield"} size={11} />
                        {helperBusy === host.id
                          ? "Installing…"
                          : helpers[host.id].state === "ready"
                            ? "Helper ready"
                            : helpers[host.id].state === "blocked"
                              ? "No root route"
                              : "Install helper"}
                      </button>
                    ) : null}
                    {measurement ? (
                      <span
                        title={
                          measurement.error
                            ? `Last probe failed: ${measurement.error}`
                            : `${measurement.downMbps} Mbps down · ${measurement.upMbps} Mbps up · via ${measurement.endpoint ?? "mirror"}`
                        }
                      >
                        Net{" "}
                        <b className={cx("mono", measurement.error && "warn-text")}>
                          {measurement.error ? "—" : `${shortRate(measurement.downMbps)}↓`}
                        </b>
                        {measurement.linkMbps && !measurement.error ? (
                          <>
                            {" "}
                            <em className="host-link mono">{linkLabel(measurement.linkMbps)}</em>
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                  <div className="helper-history">
                    <div className="helper-history-head">
                      <Icon name="activity" size={11} />
                      <span>Helper installs</span>
                      <em className="mono">{history.length}</em>
                      {history.length > 3 ? (
                        <button
                          type="button"
                          className="helper-history-more"
                          onClick={() => setExpandedHistory((current) => ({ ...current, [host.id]: !historyExpanded }))}
                        >
                          {historyExpanded ? "less" : `+${history.length - 3} more`}
                        </button>
                      ) : null}
                    </div>
                    {recentHistory.length === 0 ? (
                      <p className="helper-history-empty">{journalReady ? "No installs recorded yet." : "Loading install history…"}</p>
                    ) : (
                      <ol className="helper-history-list">
                        {recentHistory.map((entry) => {
                          const audit = helperAudit(entry);
                          const failed = /,\s*failed\b/.test(entry.message);
                          const detail = entry.message.replace(/^helper install \([^)]*\):\s*/, "");
                          const entryKey = `${entry.seq}-${entry.at}`;
                          const rowRetry = retry?.hostId === host.id && retry.entryKey === entryKey ? retry : null;
                          return (
                            <li key={entryKey} className={cx("helper-history-item", failed && "failed")}>
                              <span className="helper-history-dot" />
                              <span className="helper-history-when mono">{ago(entry.at)}</span>
                              <span className={cx("helper-history-trigger", audit.trigger === "automatic" && "automatic")}>
                                {audit.trigger ?? "—"}
                              </span>
                              <span className={cx("helper-history-route", audit.route ? `route-${audit.route}` : "unknown")}>
                                {audit.route ?? "—"}
                              </span>
                              <span className="helper-history-end">
                                <span className="helper-history-detail" title={entry.message}>
                                  {detail}
                                </span>
                                {failed ? (
                                  <button
                                    type="button"
                                    className="helper-history-retry"
                                    onClick={() => requestHelperInstall(host, entry)}
                                    disabled={
                                      helperBusy !== null ||
                                      helpers[host.id]?.state === "ready" ||
                                      helpers[host.id]?.state === "blocked"
                                    }
                                    title={
                                      helpers[host.id]?.state === "ready"
                                        ? "The helper is already ready"
                                        : helpers[host.id]?.state === "blocked"
                                          ? "No root route — add a sudo password in Host actions or use the bootstrap commands"
                                          : `Reinstall the helper on ${host.label}`
                                    }
                                    aria-label={`Retry helper install on ${host.label}`}
                                  >
                                    {rowRetry?.phase === "running" ? "Retrying" : "Retry"}
                                  </button>
                                ) : null}
                              </span>
                              {rowRetry ? (
                                <div
                                  className={cx("helper-history-retry-status", rowRetry.phase)}
                                  role="status"
                                  aria-live={rowRetry.phase === "running" ? "off" : "polite"}
                                >
                                  {rowRetry.phase === "running" ? (
                                    <>
                                      <span className="helper-history-retry-track" aria-hidden="true">
                                        <i />
                                      </span>
                                      <span className="mono">
                                        retrying · {Math.max(1, Math.round((retryNow - rowRetry.startedAt) / 1000))}s
                                      </span>
                                    </>
                                  ) : (
                                    <>
                                      <Icon name={rowRetry.phase === "ok" ? "check" : "alert"} size={10} />
                                      <span title={rowRetry.detail}>
                                        <b>{rowRetry.phase === "ok" ? "install complete" : "retry failed"}</b>
                                        {rowRetry.detail ? ` · ${rowRetry.detail}` : ""}
                                      </span>
                                    </>
                                  )}
                                </div>
                              ) : null}
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                  <footer>
                    <button className="btn small ghost" onClick={() => setActiveId(host.id)}>
                      {activeId === host.id ? "Live view" : "Open"}
                    </button>
                    {canManage ? (
                      <button className="btn small ghost" onClick={() => startEdit(host)}>
                        Edit
                      </button>
                    ) : null}
                    <button
                      className="btn icon ghost"
                      onClick={() => void runSpeed(host.id)}
                      title="Run the throughput probe"
                      disabled={speeding}
                    >
                      <Icon name="activity" size={12} className={speeding ? "spin" : ""} />
                    </button>
                    <button className="btn icon ghost" onClick={() => copySsh(host)} title="Copy ssh command">
                      <Icon name="copy" size={12} />
                    </button>
                    {canManage ? (
                      <button className="btn icon ghost danger" onClick={() => void remove(host)} title="Remove host">
                        <Icon name="trash" size={12} />
                      </button>
                    ) : null}
                  </footer>
                </article>
              );
            })}
            {hosts.length === 0 ? (
              <div className="empty-inline">
                <Icon name="terminal" size={20} />
                <div>
                  <strong>{canManage ? "No Linux hosts yet" : "No machines linked to you"}</strong>
                  <p>
                    {canManage
                      ? "Add a VPS or bare-metal box. Key or password auth both work; the credential is encrypted on this machine."
                      : "Ask an admin to link an SSH machine to your team account; only linked machines appear here."}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </Panel>

        {activeHost ? (
          <>
            <Panel
              eyebrow="HOST TELEMETRY"
              title={snapshot?.identity.hostname ?? activeHost.label}
              actions={
                <div className="inline-actions">
                  <span className="live-tag">
                    <i /> {POLL_MS / 1000}s
                  </span>
                  <button className="btn icon ghost" onClick={() => activeId && void refresh(activeId)} title="Refresh now">
                    <Icon name="refresh" size={13} className={loading ? "spin" : ""} />
                  </button>
                </div>
              }
            >
              {error ? (
                <div className="error-banner">
                  <Icon name="alert" size={16} />
                  <div>
                    <strong>SSH probe failed</strong>
                    <span>{error}</span>
                  </div>
                  <button className="btn small ghost" onClick={() => activeId && void refresh(activeId)}>
                    Retry
                  </button>
                </div>
              ) : null}

              {!snapshot ? (
                loading || statuses[activeHost.id]?.health === "connecting" ? (
                  <div className="ssh-detail-grid">
                    <Skeleton height={190} />
                    <Skeleton height={190} />
                  </div>
                ) : (
                  <p className="subtle">No telemetry returned.</p>
                )
              ) : (
                <>
                  <div className="ssh-identity">
                    <div>
                      <span className="eyebrow">OPERATING SYSTEM</span>
                      <strong>{snapshot.identity.os}</strong>
                      <em className="mono">
                        {snapshot.identity.kernel} · {snapshot.identity.arch}
                      </em>
                    </div>
                    <div>
                      <span className="eyebrow">UPTIME</span>
                      <strong>{duration(snapshot.identity.uptime)}</strong>
                      <em className="mono">load {snapshot.cpu.load.map((value) => value.toFixed(2)).join(" / ")}</em>
                    </div>
                    <div>
                      <span className="eyebrow">PROCESSOR</span>
                      <strong>
                        {snapshot.cpu.physicalCores
                          ? `${snapshot.cpu.physicalCores} cores / ${snapshot.cpu.cores} threads`
                          : `${snapshot.cpu.cores} threads`}
                      </strong>
                      <em className="mono" title={snapshot.cpu.model}>{snapshot.cpu.model.slice(0, 34) || "unknown"}</em>
                    </div>
                    <div>
                      <span className="eyebrow">SSH</span>
                      <strong className="mono">
                        {activeHost.username}@{activeHost.host}
                      </strong>
                      <em className="mono">
                        {snapshot.status.latencyMs} ms probe · {ago(snapshot.fetchedAt)}
                      </em>
                    </div>
                  </div>

                  <ServerHardware snapshot={snapshot} />

                  <GpuTelemetryPanel
                    gpus={snapshot.gpus ?? []}
                    error={snapshot.gpuError}
                    hostKey={sshGpuAlertHostKey(activeHost.id)}
                    hostLabel={activeHost.label}
                    hostId={activeHost.id}
                  />

                  <div className="dial-row">
                    {dials.map((dial) => (
                      <Gauge key={dial.label} value={dial.value} label={dial.label} detail={dial.detail} tone={dial.tone} size={116} />
                    ))}
                  </div>

                  <div className="ssh-detail-grid">
                    <div className="ssh-meters">
                      <div className="meter-row">
                        <span>CPU</span>
                        <div className="meter">
                          <i style={{ width: `${Math.min(100, snapshot.cpu.usage)}%` }} />
                        </div>
                        <b className="mono">{snapshot.cpu.usage.toFixed(1)}%</b>
                      </div>
                      <div className="meter-row">
                        <span>MEM</span>
                        <div className="meter violet">
                          <i style={{ width: `${memPct}%` }} />
                        </div>
                        <b className="mono">{memPct.toFixed(1)}%</b>
                      </div>
                      <div className="meter-row">
                        <span>SWAP</span>
                        <div className="meter amber">
                          <i style={{ width: `${swapPct}%` }} />
                        </div>
                        <b className="mono">{swapPct.toFixed(1)}%</b>
                      </div>
                      <div className="meter-row">
                        <span>IO PSI</span>
                        <div className={cx("meter", ioPct > 60 && "red")}>
                          <i style={{ width: `${ioPct}%` }} />
                        </div>
                        <b className="mono">{snapshot.pressure.io.some10.toFixed(2)}</b>
                      </div>
                      <div className="ssh-memfacts">
                        <div>
                          <span>USED</span>
                          <strong className="mono">{bytes(snapshot.memory.used)}</strong>
                        </div>
                        <div>
                          <span>TOTAL</span>
                          <strong className="mono">{bytes(snapshot.memory.total)}</strong>
                        </div>
                        <div>
                          <span>AVAILABLE</span>
                          <strong className="mono">{bytes(snapshot.memory.available)}</strong>
                        </div>
                        <div>
                          <span>NET RX</span>
                          <strong className="mono">{rate(latest?.netRx ?? 0)}</strong>
                        </div>
                        <div>
                          <span>NET TX</span>
                          <strong className="mono">{rate(latest?.netTx ?? 0)}</strong>
                        </div>
                        <div>
                          <span>TEMP</span>
                          <strong className="mono">{snapshot.temps[0] ? `${snapshot.temps[0].celsius.toFixed(1)} °C` : "—"}</strong>
                        </div>
                      </div>
                    </div>

                    <div className="ssh-gauges">
                      <Gauge
                        value={snapshot.pressure.memory.some10}
                        label="MEM PSI"
                        detail="stall · 10s"
                        tone={snapshot.pressure.memory.some10 > 20 ? "red" : "violet"}
                        size={122}
                      />
                      <Gauge
                        value={Math.min(100, snapshot.cpu.breakdown.steal * 10)}
                        label="STEAL"
                        detail={`${snapshot.cpu.breakdown.steal.toFixed(1)}% cpu`}
                        tone={snapshot.cpu.breakdown.steal > 5 ? "amber" : "green"}
                        size={122}
                      />
                    </div>
                  </div>

                  <div className="ssh-spark">
                    <div className="chart-grid" />
                    <Sparkline data={cpuSeries.length > 1 ? cpuSeries : [0, 0]} width={760} height={74} tone="cyan" />
                    <div className="chart-axis mono">
                      <span>CPU · last {cpuSeries.length} samples</span>
                      <span>now</span>
                    </div>
                  </div>

                  <div className="ssh-charts">
                    <div>
                      <span className="eyebrow">CPU BREAKDOWN</span>
                      <LineChart
                        max={100}
                        series={[
                          { label: "user", color: "#3ef2ff", data: snapshot.samples.map((sample) => sample.user ?? 0) },
                          { label: "system", color: "#8b6cff", data: snapshot.samples.map((sample) => sample.system ?? 0) },
                          { label: "iowait", color: "#ffbe5c", data: snapshot.samples.map((sample) => sample.iowait ?? 0) },
                          { label: "steal", color: "#ff5c7a", data: snapshot.samples.map((sample) => sample.steal ?? 0) },
                        ]}
                      />
                    </div>
                    <div>
                      <span className="eyebrow">PRESSURE STALL (PSI · 10s)</span>
                      <LineChart
                        max={Math.max(10, snapshot.pressure.memory.some10, snapshot.pressure.io.some10, snapshot.pressure.cpu.some10) * 1.4}
                        series={[
                          { label: "memory", color: "#8b6cff", data: snapshot.samples.map((sample) => sample.memPressure ?? 0) },
                          { label: "io", color: "#ffbe5c", data: snapshot.samples.map((sample) => sample.ioPressure ?? 0) },
                        ]}
                      />
                    </div>
                    <div>
                      <span className="eyebrow">MEMORY USED · LOAD 1M</span>
                      <LineChart
                        max={100}
                        series={[
                          { label: "mem %", color: "#3ef2ff", data: snapshot.samples.map((sample) => sample.mem) },
                          { label: "swap %", color: "#ff5c7a", data: snapshot.samples.map((sample) => (sample.swap ?? 0)) },
                        ]}
                      />
                    </div>
                  </div>
                </>
              )}
            </Panel>

            {activeHost ? (
              <Panel eyebrow="CONSOLE" title="Host console" flush>
                <div className="console-tabs" role="tablist" aria-label="Console type">
                  <button
                    role="tab"
                    aria-selected={consoleTab === "cli"}
                    className={cx("console-tab", consoleTab === "cli" && "active")}
                    onClick={() => setConsoleTab("cli")}
                  >
                    <Icon name="terminal" size={13} /> SSH terminal
                  </button>
                  <button
                    role="tab"
                    aria-selected={consoleTab === "vnc"}
                    className={cx("console-tab", consoleTab === "vnc" && "active")}
                    onClick={() => setConsoleTab("vnc")}
                  >
                    <Icon name="activity" size={13} /> VNC
                  </button>
                  <span className="mono subtle small">{activeHost.label}</span>
                </div>
                {consoleTab === "cli" ? (
                  <SshTerminal host={activeHost} onToast={onToast} />
                ) : (
                  <VncConsole host={activeHost} onToast={onToast} canSetup={canManage} />
                )}
              </Panel>
            ) : null}

            {snapshot ? (
              <div className="ssh-columns">
                <Panel eyebrow="STORAGE" title="Filesystems">
                  <table className="disk-table">
                    <thead>
                      <tr>
                        <th>Mount</th>
                        <th>Device</th>
                        <th className="right">Used</th>
                        <th className="right">Size</th>
                        <th>Fill</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.disks.map((disk) => {
                        const fill = pct(disk.used, disk.size);
                        return (
                          <tr key={`${disk.fs}-${disk.mount}`}>
                            <td className="mono">{disk.mount}</td>
                            <td className="mono subtle">{disk.fs}</td>
                            <td className="right mono">{bytes(disk.used)}</td>
                            <td className="right mono subtle">{bytes(disk.size)}</td>
                            <td>
                              <div className={cx("meter small", fill > 88 && "red", fill > 72 && fill <= 88 && "amber")}>
                                <i style={{ width: `${fill}%` }} />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {snapshot.disks.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="subtle small">
                            df returned no filesystems.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                  {snapshot.blockDevices.length > 0 ? (
                    <div className="block-list">
                      {snapshot.blockDevices.map((device) => (
                        <div key={device.name}>
                          <span className="mono">{device.name}</span>
                          <span className="subtle small">{device.model}</span>
                          <span className="mono small">{bytes(device.size)}</span>
                          <span className="chip chip-muted">{device.rotational ? "hdd" : "ssd"}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </Panel>

                <Panel eyebrow="NETWORK" title="Interfaces">
                  <div className="nic-list">
                    {snapshot.nics.map((nic) => (
                      <div key={nic.name}>
                        <span className="mono">{nic.name}</span>
                        <span className="mono small">↓ {bytes(nic.rx)}</span>
                        <span className="mono small">↑ {bytes(nic.tx)}</span>
                      </div>
                    ))}
                    {snapshot.nics.length === 0 ? <p className="subtle small">No counters readable.</p> : null}
                  </div>
                  <div className="security-facts">
                    <div>
                      <span>FAILED SSH · 24H</span>
                      <strong className={cx("mono", (snapshot.security.failedLogins ?? 0) > 50 && "warn-text")}>
                        {snapshot.security.failedLogins ?? 0}
                      </strong>
                    </div>
                    <div>
                      <span>PASSWORD AUTH</span>
                      <strong className="mono small">{snapshot.security.passwordAuth ?? "—"}</strong>
                    </div>
                    <div>
                      <span>ROOT LOGIN</span>
                      <strong className="mono small">{snapshot.security.permitRootLogin ?? "—"}</strong>
                    </div>
                    <div>
                      <span>FIREWALL</span>
                      <strong className="mono small">{snapshot.security.firewall ?? "not detected"}</strong>
                    </div>
                  </div>
                </Panel>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="stack">
        <Panel eyebrow="CONTROL" title="Host actions">
          {activeHost ? (
            <>
              {helperStatus ? (
                <div className={cx("helper-block", `helper-${helperStatus.state}`)}>
                  <div className="helper-head">
                    <Chip tone={HELPER_TONE[helperStatus.state]} dot>
                      {HELPER_LABEL[helperStatus.state]}
                    </Chip>
                    <span className="mono small subtle">
                      {helperStatus.files.helper ? "helper" : "no helper"} · {helperStatus.files.sudoers ? "drop-in" : "no drop-in"} · route{" "}
                      {ROUTE_LABEL[helperStatus.route]}
                    </span>
                  </div>
                  <p className="hint">{helperStatus.detail}</p>
                  {helperStatus.state !== "ready" && helperStatus.route !== "root" ? (
                    <label className="field wide helper-sudo">
                      <span>sudo password · used once</span>
                      <input
                        type="password"
                        value={sudoDraft}
                        onChange={(event) => setSudoDraft(event.target.value)}
                        placeholder={helperStatus.route === "password" ? "blank uses the stored password" : "needed once to replace the helper on a key-auth host"}
                      />
                      <em className="hint">
                        Only read to answer sudo&apos;s prompt for this install. It is never saved, logged or sent anywhere else.
                      </em>
                    </label>
                  ) : null}
                  <div className="action-row">
                    <button
                      className="btn small primary"
                      onClick={() => {
                        const typed = sudoDraft.trim();
                        if (typed) void installHelper(activeHost, typed);
                        else requestHelperInstall(activeHost);
                      }}
                      disabled={helperBusy !== null || helperStatus.state === "ready" || (helperStatus.state === "blocked" && !sudoDraft.trim())}
                    >
                      <Icon name="shield" size={13} className={helperBusy === activeHost.id ? "spin" : ""} />
                      {helperBusy === activeHost.id
                        ? "Installing…"
                        : helperStatus.state === "ready"
                          ? "Installed"
                          : "Install privileged helper"}
                    </button>
                    <button className="btn small ghost" onClick={() => void checkHelper(activeHost.id)} disabled={helperBusy !== null}>
                      <Icon name="refresh" size={13} /> Recheck
                    </button>
                    {helperStatus.bootstrap ? (
                      <button className="btn small ghost" onClick={() => copyBootstrap(helperStatus.bootstrap ?? "")}>
                        <Icon name="copy" size={13} /> Copy bootstrap
                      </button>
                    ) : null}
                  </div>
                  {helperStatus.bootstrap ? <pre className="helper-script mono">{helperStatus.bootstrap}</pre> : null}
                  {helperLog?.hostId === activeHost.id ? (
                    <pre className={cx("helper-script mono", helperLog.ok ? "ok" : "err")}>{helperLog.text}</pre>
                  ) : null}
                </div>
              ) : (
                <p className="hint">
                  Privileged helper readiness is unknown for this host.{" "}
                  <button className="btn small ghost" onClick={() => void checkHelper(activeHost.id)}>
                    Check now
                  </button>
                </p>
              )}
              <div className="form-grid">
                <label className="field wide">
                  <span>systemd unit</span>
                  <input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="nginx" />
                </label>
              </div>
              <div className="action-row">
                <button className="btn small ghost" onClick={() => setConfirmKind("start-service")} disabled={!unit.trim()}>
                  <Icon name="play" size={13} /> Start unit
                </button>
                <button className="btn small ghost" onClick={() => setConfirmKind("stop-service")} disabled={!unit.trim()}>
                  <Icon name="stop" size={13} /> Stop unit
                </button>
                <button className="btn small ghost" onClick={() => setConfirmKind("restart-service")} disabled={!unit.trim()}>
                  <Icon name="reboot" size={13} /> Restart unit
                </button>
                <button className="btn small ghost" onClick={() => setConfirmKind("backup")}>
                  <Icon name="download" size={13} /> Backup /etc + /home
                </button>
                <button className="btn small ghost danger" onClick={() => setConfirmKind("reboot")}>
                  <Icon name="power" size={13} /> Reboot host
                </button>
                <button className="btn small ghost danger" onClick={() => setConfirmKind("shutdown")}>
                  <Icon name="stop" size={13} /> Shut down
                </button>
              </div>
              <p className="hint">
                Actions run through sudo on the remote side. The helper installs the narrow NOPASSWD grant above, so non-root logins stop
                needing a password without handing out a shell.
              </p>
            </>
          ) : (
            <p className="subtle small">Select a host first.</p>
          )}
        </Panel>

        <Panel
          eyebrow="THROUGHPUT"
          title="Endpoint speed"
          actions={
            onOpenNetwork ? (
              <button className="btn small ghost" onClick={onOpenNetwork}>
                <Icon name="activity" size={13} /> Open network tab
              </button>
            ) : undefined
          }
        >
          <p className="subtle small">
            Download, upload, RTT and the negotiated link rate live in the Network tab, one card per endpoint. Runs move up to ~500 MB down
            and ~64 MB up; stalled streams are excluded instead of averaged in. Only curl is needed on the target.
          </p>
        </Panel>

        {editing ? (
          <Panel
            eyebrow={editing.id ? "EDIT LINUX HOST" : "NEW LINUX HOST"}
            title={editing.label || "Add an SSH endpoint"}
            actions={
              <button className="btn icon ghost" onClick={() => setEditing(null)} title="Close form">
                <Icon name="close" size={13} />
              </button>
            }
          >
            <div className="form-grid">
              <label className="field">
                <span>Display name</span>
                <input value={editing.label} onChange={(event) => patch({ label: event.target.value })} placeholder="demo-dedicated" />
              </label>
              <label className="field">
                <span>Host or IP</span>
                <input value={editing.host} onChange={(event) => patch({ host: event.target.value })} placeholder="203.0.113.20" />
              </label>
              <label className="field">
                <span>Username</span>
                <input value={editing.username} onChange={(event) => patch({ username: event.target.value })} placeholder="user" />
              </label>
              <label className="field">
                <span>Port</span>
                <input type="number" value={editing.port ?? 22} onChange={(event) => patch({ port: Number(event.target.value) })} />
              </label>
              <label className="field">
                <span>VNC port</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={editing.vncPort ?? ""}
                  onChange={(event) => patch({ vncPort: event.target.value ? Number(event.target.value) : undefined })}
                  placeholder="auto"
                />
                <em className="hint">Pins the console to a loopback RFB port. Blank keeps the current setting; new hosts auto-detect.</em>
              </label>
              <label className="field wide">
                <span>Authentication</span>
                <div className="segmented">
                  <button
                    type="button"
                    className={cx("seg", (editing.authMode ?? "key") === "key" && "active")}
                    onClick={() => patch({ authMode: "key" as SshAuthMode })}
                  >
                    Private key / agent
                  </button>
                  <button
                    type="button"
                    className={cx("seg", editing.authMode === "password" && "active")}
                    onClick={() => patch({ authMode: "password" as SshAuthMode })}
                  >
                    Password
                  </button>
                </div>
              </label>
              {(editing.authMode ?? "key") === "key" ? (
                <label className="field wide">
                  <span>Private key path</span>
                  <input value={editing.keyPath ?? ""} onChange={(event) => patch({ keyPath: event.target.value })} placeholder="~/.ssh/id_ed25519" />
                  <em className="hint">Blank uses your ssh agent and default keys. The key never leaves this machine.</em>
                </label>
              ) : (
                <label className="field wide">
                  <span>Password</span>
                  <input
                    type="password"
                    value={editing.password ?? ""}
                    onChange={(event) => patch({ password: event.target.value })}
                    placeholder={editing.id ? "leave blank to keep the stored password" : "••••••••"}
                  />
                  <em className="hint">Encrypted with AES-256-GCM under the same vault as your Proxmox token.</em>
                </label>
              )}
            </div>

            {formError ? <p className="inline-error">{formError}</p> : null}
            {result ? (
              <div className={cx("test-result", result.ok ? "ok" : "err")}>
                <strong>{result.ok ? "SSH handshake successful" : "SSH connection failed"}</strong>
                {result.ok ? (
                  <span className="mono">
                    {result.hostname} · {result.os} · {result.kernel} · {result.cores} threads · {result.latencyMs} ms
                  </span>
                ) : (
                  <span>{result.error}</span>
                )}
              </div>
            ) : null}

            <div className="form-actions">
              <button className="btn ghost" onClick={() => void runTest()} disabled={testing || !editing.host || !editing.username}>
                {testing ? "Testing…" : "Test SSH"}
              </button>
              <button className="btn primary" onClick={() => void save()} disabled={saving || !editing.host || !editing.username}>
                {saving ? "Saving…" : editing.id ? "Save changes" : "Add host"}
              </button>
            </div>
            {isMockBridge ? <p className="hint">Mock bridge — values are simulated outside the desktop app.</p> : null}
          </Panel>
        ) : (
          <Panel eyebrow="AGENT ACCESS" title="SSH tools over MCP">
            <ul className="security-list">
              <li>
                <Icon name="agent" size={14} /> <code>ssh.status</code>, <code>ssh.speedtest</code>, <code>ssh.journal</code> and{" "}
                <code>ssh.exec</code> give an agent the same reach the console has.
              </li>
              <li>
                <Icon name="terminal" size={14} /> <code>ssh.power</code> and <code>ssh.service</code> are gated: MCP calls need{" "}
                <code>confirm:true</code>, pipelines pause for a human.
              </li>
              <li>
                <Icon name="shield" size={14} /> Passwords live in the vault; key logins stay with your OpenSSH agent and known_hosts.
              </li>
            </ul>
          </Panel>
        )}

        {snapshot ? (
          <Panel eyebrow="SERVICES" title="Units" actions={<span className="mono subtle">{runningUnits.length} running</span>}>
            <div className="unit-list">
              {failedUnits.map((entry) => (
                <div key={`failed-${entry.name}`} className="unit failed">
                  <StatusDot state="offline" />
                  <span className="mono">{entry.name}</span>
                  <span className="chip chip-err">failed</span>
                </div>
              ))}
              {runningUnits.slice(0, 12).map((entry) => (
                <div key={entry.name} className="unit">
                  <StatusDot state="online" />
                  <span className="mono">{entry.name}</span>
                  <span className="chip chip-ok">running</span>
                </div>
              ))}
            </div>
          </Panel>
        ) : null}

        {snapshot ? (
          <Panel eyebrow="WORKLOAD" title={snapshot.containers.length > 0 ? "Containers" : "Top processes"}>
            {snapshot.containers.length > 0 ? (
              <div className="unit-list">
                {snapshot.containers.map((container) => (
                  <div key={container.name} className="unit">
                    <Icon name="layers" size={13} />
                    <span className="mono">{container.name}</span>
                    <span className="subtle small">{container.status}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="proc-list">
                <div className="proc-head">
                  <span>PROCESS</span>
                  <span>CPU</span>
                  <span>MEM</span>
                  <span>RSS</span>
                </div>
                {snapshot.processes.map((process) => (
                  <div key={process.command} className="proc-row">
                    <span className="mono">{process.command}</span>
                    <span className="mono">{process.cpu.toFixed(1)}%</span>
                    <span className="mono">{process.mem.toFixed(1)}%</span>
                    <span className="mono">{bytes(process.rss)}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        ) : null}
      </div>

      {sudoPrompt ? (
        <Modal
          title={`Sudo password for ${sudoPrompt.host.label}`}
          subtitle={`${sudoPrompt.host.username}@${sudoPrompt.host.host}:${sudoPrompt.host.port}`}
          onClose={closeSudoPrompt}
          width={500}
          footer={
            <>
              <button className="btn ghost" onClick={closeSudoPrompt} disabled={Boolean(helperBusy)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={submitSudoPrompt}
                disabled={Boolean(helperBusy) || !sudoPromptDraft.trim()}
              >
                <Icon name="shield" size={13} /> Install helper
              </button>
            </>
          }
        >
          <p className="confirm-body">
            Replacing the helper needs a real sudo elevation. The existing NOPASSWD grant can run the helper, but it cannot
            replace the helper binary. Enter the sudo password for <b>{sudoPrompt.host.username}</b> once for this
            reinstall.
          </p>
          <p className="hint">{helpers[sudoPrompt.host.id]?.detail}</p>
          <label className="field wide">
            <span>sudo password · used once</span>
            <input
              type="password"
              value={sudoPromptDraft}
              onChange={(event) => setSudoPromptDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitSudoPrompt();
                }
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder={`sudo password for ${sudoPrompt.host.username}`}
            />
            <em className="hint">
              Sent over SSH only for <code>sudo -S</code>. It is never saved, logged, or exposed to the host after this install.
            </em>
          </label>
        </Modal>
      ) : null}

      {confirmKind ? (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !acting && setConfirmKind(null)}>
          <div className="modal" role="dialog" aria-modal="true" style={{ width: 460 }}>
            <header>
              <div>
                <h2>
                  {confirmKind === "reboot"
                    ? `Reboot ${activeHost?.label}?`
                    : confirmKind === "shutdown"
                      ? `Shut down ${activeHost?.label}?`
                      : confirmKind === "backup"
                        ? `Back up ${activeHost?.label}?`
                        : `${confirmKind === "start-service" ? "Start" : confirmKind === "stop-service" ? "Stop" : "Restart"} ${unit} on ${activeHost?.label}?`}
                </h2>
                <p className="mono">{activeHost?.username}@{activeHost?.host}</p>
              </div>
            </header>
            <div className="modal-content">
              <p className="confirm-body">
                {confirmKind === "backup" ? (
                  <>
                    <span className="mono">tar -czf /var/backups/nexus/{activeHost?.label}-&lt;timestamp&gt;.tar.gz /etc /home</span>
                    <br />
                    Runs on the host with sudo, keeps the three newest archives, and can take minutes on a full /home.
                  </>
                ) : confirmKind === "restart-service" || confirmKind === "stop-service" || confirmKind === "start-service" ? (
                  "The unit changes state now. Anything using it briefly loses the service."
                ) : (
                  "The host drops off the network and every workload on it stops. You need console access to bring it back."
                )}
              </p>
            </div>
            <footer>
              <button className="btn ghost" onClick={() => setConfirmKind(null)} disabled={acting}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void act()} disabled={acting}>
                {acting
                  ? "Working…"
                  : confirmKind === "backup"
                    ? "Run backup"
                    : confirmKind === "restart-service"
                      ? "Restart"
                      : confirmKind === "stop-service"
                        ? "Stop"
                        : confirmKind === "start-service"
                          ? "Start"
                          : confirmKind === "reboot"
                            ? "Reboot"
                            : "Shut down"}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
