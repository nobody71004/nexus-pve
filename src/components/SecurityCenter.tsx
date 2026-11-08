import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  HelperRoute,
  SecurityCheck,
  SecurityJournalEntry,
  SecurityLayer,
  SecurityOverview,
  SecurityPolicy,
} from "../../shared/types";
import { bridge } from "../lib/bridge";
import { ago } from "../lib/format";
import { Icon } from "./Icon";
import { Chip, Panel, Skeleton } from "./ui";

const LAYER_LABEL: Record<SecurityLayer, string> = {
  access: "Access control",
  network: "Network",
  patch: "Patch state",
  kernel: "Kernel",
  integrity: "Integrity",
  persistence: "Persistence",
};

const LAYERS: SecurityLayer[] = ["access", "network", "patch", "kernel", "integrity", "persistence"];

const MODES: Array<{ id: SecurityPolicy["mode"]; label: string; hint: string }> = [
  { id: "observe", label: "Observe", hint: "Audit only. Nothing is changed." },
  { id: "defend", label: "Defend", hint: "Auto-apply safe fixes when enforcement is on." },
  { id: "lockdown", label: "Lockdown", hint: "Defend plus guarded fixes and 24h bans." },
];

const SEVERITY_TONE: Record<SecurityCheck["severity"], "err" | "warn" | "info" | "muted"> = {
  critical: "err",
  high: "err",
  medium: "warn",
  low: "info",
  info: "muted",
};

const HELPER_ROUTES: HelperRoute[] = ["root", "nopasswd", "password", "none"];

const JOURNAL_TONE: Record<string, "ok" | "warn" | "err" | "info" | "muted" | "violet"> = {
  scan: "info",
  action: "ok",
  contain: "warn",
  install: "violet",
  policy: "muted",
  boot: "muted",
  error: "err",
  tamper: "err",
};

export function SecurityCenter({
  onToast,
}: {
  onToast: (level: "info" | "warn" | "error" | "ok", title: string, detail?: string) => void;
}) {
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [journalKind, setJournalKind] = useState<"all" | SecurityJournalEntry["kind"]>("all");
  const [journalRoute, setJournalRoute] = useState<"all" | HelperRoute>("all");

  const load = useCallback(async () => {
    try {
      const next = await bridge.security.overview();
      setOverview(next);
      setError(null);
      setSelected((current) => current ?? next.hosts[0]?.hostId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    const off = bridge.security.onScan((scan) => {
      setOverview((current) =>
        current
          ? {
              ...current,
              hosts: current.hosts.map((host) => (host.hostId === scan.hostId ? { ...host, scan, running: false } : host)),
            }
          : current,
      );
    });
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [load]);

  const host = useMemo(
    () => overview?.hosts.find((entry) => entry.hostId === selected) ?? overview?.hosts[0],
    [overview, selected],
  );
  const scan = host?.scan;

  const patchPolicy = async (patch: Partial<SecurityPolicy>) => {
    setBusy("policy");
    try {
      const next = await bridge.security.policy(patch);
      setOverview((current) => (current ? { ...current, policy: next } : current));
      onToast("ok", "Guard policy updated", `mode ${next.mode} · every ${Math.round(next.intervalSec / 60)} min`);
    } catch (err) {
      onToast("error", "Policy rejected", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const runScan = async (hostId: string) => {
    setBusy(`scan:${hostId}`);
    try {
      const result = await bridge.security.scan(hostId);
      setOverview((current) =>
        current
          ? { ...current, hosts: current.hosts.map((entry) => (entry.hostId === hostId ? { ...entry, scan: result, running: false } : entry)) }
          : current,
      );
      onToast(result.grade === "A" || result.grade === "B" ? "ok" : "warn", `${result.label}: ${result.grade} ${result.score}/100`, `${result.checks.filter((c) => c.status === "fail").length} failing · ${result.actions.filter((a) => a.ok).length} fixed`);
    } catch (err) {
      onToast("error", "Scan failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const apply = async (action: string, label: string) => {
    if (!host) return;
    setBusy(action);
    setPending(null);
    try {
      const result = await bridge.security.enforce(host.hostId, action, { confirm: true });
      setOverview((current) =>
        current ? { ...current, hosts: current.hosts.map((entry) => (entry.hostId === host.hostId ? { ...entry, scan: result } : entry)) } : current,
      );
      onToast("ok", "Remediation applied", label);
    } catch (err) {
      onToast("error", "Remediation failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const fix = (check: SecurityCheck) => {
    if (!check.remediation) return;
    if (check.guarded) {
      setPending({ action: check.remediation, label: check.title });
      return;
    }
    void apply(check.remediation, check.title);
  };

  const toggleResident = async () => {
    if (!host) return;
    setBusy("resident");
    try {
      const state = await bridge.security.resident(host.hostId, !(overview?.policy.resident ?? false));
      onToast(state.active ? "ok" : "warn", state.active ? "Resident enforcer active" : "Resident enforcer installed, timer not active", state.output.split("\n")[0]);
      await load();
    } catch (err) {
      onToast("error", "Resident enforcer failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const acceptBaseline = async () => {
    if (!host) return;
    setBusy("baseline");
    try {
      const next = await bridge.security.acceptBaseline(host.hostId);
      setOverview(next);
      onToast("ok", "Baseline accepted", "the current fingerprints are the new reference");
    } catch (err) {
      onToast("error", "Baseline not accepted", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const verifyChain = async () => {
    setBusy("verify");
    try {
      const result = await bridge.security.verify();
      onToast(result.ok ? "ok" : "error", result.ok ? "Journal chain intact" : "Journal chain broken", result.detail);
    } catch (err) {
      onToast("error", "Verification failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const findings = (scan?.checks ?? []).filter((check) => check.status === "fail" || check.status === "warn");
  const passes = (scan?.checks ?? []).filter((check) => check.status === "pass");
  const visible = showAll ? scan?.checks ?? [] : findings;

  // Helper-install route and trigger are structured journal fields; filter on
  // them directly rather than parsing the formatted message.
  const journalRows = useMemo(() => {
    return (overview?.journal ?? [])
      .slice()
      .reverse()
      .filter((entry) => {
        if (journalKind !== "all" && entry.kind !== journalKind) return false;
        if (journalRoute !== "all" && entry.route !== journalRoute) return false;
        return true;
      });
  }, [overview, journalKind, journalRoute]);

  if (!overview) {
    return (
      <div className="stack">
        {error ? (
          <div className="error-banner">
            <Icon name="alert" size={16} />
            <div>
              <strong>Guard unavailable</strong>
              <span>{error}</span>
            </div>
          </div>
        ) : (
          <Skeleton height={220} />
        )}
      </div>
    );
  }

  return (
    <div className="stack guard">
      <Panel
        eyebrow="24/7 GUARDIAN"
        title="Security bot"
        actions={
          <div className="guard-actions">
            <button className="btn ghost small" onClick={() => void verifyChain()} disabled={busy === "verify"}>
              <Icon name="shield" size={13} /> {overview.chain.ok ? `${overview.chain.length} records intact` : "Chain broken"}
            </button>
            <button className="btn primary small" onClick={() => host && void runScan(host.hostId)} disabled={!host || busy === `scan:${host?.hostId ?? ""}`}>
              <Icon name="refresh" size={13} className={busy === `scan:${host?.hostId ?? ""}` ? "spin" : ""} /> Scan now
            </button>
          </div>
        }
      >
        <div className="guard-strip">
          <div className="guard-strip-item">
            <span className="eyebrow">Watcher</span>
            <strong>
              <span className={`guard-live ${overview.policy.enabled ? "on" : "off"}`} />
              {overview.policy.enabled ? "continuous" : "paused"}
            </strong>
            <em>every {Math.round(overview.policy.intervalSec / 60)} min · jittered</em>
          </div>
          <div className="guard-strip-item">
            <span className="eyebrow">Enforcement</span>
            <strong>{overview.policy.autoRemediate ? "auto-apply safe fixes" : "report only"}</strong>
            <em>{overview.policy.mode === "lockdown" ? "guarded fixes + bans enabled" : overview.policy.mode === "defend" ? "safe fixes only" : "observation mode"}</em>
          </div>
          <div className="guard-strip-item">
            <span className="eyebrow">Hosts watched</span>
            <strong>{overview.hosts.length}</strong>
            <em>{overview.hosts.filter((entry) => entry.scan).length} with a verdict</em>
          </div>
          <div className="guard-strip-item">
            <span className="eyebrow">Journal</span>
            <strong>{overview.chain.ok ? "tamper-evident" : "broken chain"}</strong>
            <em>{overview.chain.length} hash-linked records</em>
          </div>
        </div>

        <div className="guard-controls">
          <div className="guard-modes">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                className={`guard-mode ${overview.policy.mode === mode.id ? "active" : ""} ${mode.id}`}
                onClick={() => void patchPolicy({ mode: mode.id })}
                disabled={busy === "policy"}
                title={mode.hint}
              >
                <strong>{mode.label}</strong>
                <span>{mode.hint}</span>
              </button>
            ))}
          </div>
          <div className="guard-switches">
            <button
              className={`guard-switch ${overview.policy.autoRemediate ? "on" : ""}`}
              onClick={() => void patchPolicy({ autoRemediate: !overview.policy.autoRemediate })}
              disabled={busy === "policy"}
            >
              <i />
              <div>
                <strong>Auto-enforce</strong>
                <span>apply safe fixes without asking</span>
              </div>
            </button>
            <button className={`guard-switch ${overview.policy.enabled ? "on" : ""}`} onClick={() => void patchPolicy({ enabled: !overview.policy.enabled })} disabled={busy === "policy"}>
              <i />
              <div>
                <strong>24/7 loop</strong>
                <span>pause the scheduler</span>
              </div>
            </button>
            <button className={`guard-switch ${overview.policy.resident ? "on" : ""}`} onClick={() => void toggleResident()} disabled={!host || busy === "resident"}>
              <i />
              <div>
                <strong>Resident enforcer</strong>
                <span>systemd timer on the guest</span>
              </div>
            </button>
          </div>
        </div>
      </Panel>

      {overview.hosts.length === 0 ? (
        <Panel eyebrow="NO TARGETS" title="Add a Linux host">
          <p className="guard-empty">The guardian audits the Linux hosts listed under “Linux hosts”. Add one and it is picked up automatically.</p>
        </Panel>
      ) : (
        <div className="guard-hosts">
          {overview.hosts.map((entry) => {
            const grade = entry.scan?.grade ?? "?";
            const score = entry.scan?.score ?? 0;
            return (
              <button
                key={entry.hostId}
                className={`guard-host ${host?.hostId === entry.hostId ? "active" : ""}`}
                onClick={() => setSelected(entry.hostId)}
              >
                <span className={`guard-grade grade-${grade}`}>{grade}</span>
                <div>
                  <strong>{entry.label}</strong>
                  <span className="mono">{entry.scan ? `${score}/100 · ${ago(entry.scan.at)}` : "not scanned yet"}</span>
                </div>
                <span className={`guard-verdict ${entry.scan && entry.scan.checks.some((c) => c.status === "fail") ? "bad" : "good"}`}>
                  {entry.running ? "scanning" : entry.lastError ? "error" : entry.scan ? (entry.scan.checks.filter((c) => c.status === "fail").length > 0 ? "action needed" : "hardened") : "pending"}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {host?.lastError ? (
        <div className="warn-banner">
          <Icon name="alert" size={14} />
          <span>
            {host.label}: {host.lastError}
          </span>
        </div>
      ) : null}

      {scan && !scan.privileged ? (
        <div className="warn-banner">
          <Icon name="alert" size={14} />
          <span>
            {scan.label} is audited read-only — the root helper is missing, so deep checks, containment and fixes are disabled. Install
            <code>resources/nexus-priv.sh</code> as <code>/usr/local/sbin/nexus-priv</code> and <code>resources/nexus-priv.sudoers</code> as
            <code>/etc/sudoers.d/nexus-actions</code> (root, 0755/0440), then scan again.
          </span>
        </div>
      ) : null}

      {scan ? (
        <div className="guard-columns">
          <Panel eyebrow={`LAYERS · ${scan.label}`} title="Protection matrix">
            <div className="guard-layers">
              {LAYERS.map((layer) => {
                const row = scan.layers.find((entry) => entry.layer === layer);
                const value = row?.score ?? 100;
                return (
                  <div key={layer} className="guard-layer">
                    <span>{LAYER_LABEL[layer]}</span>
                    <div className="guard-layer-bar">
                      <i className={value >= 90 ? "ok" : value >= 60 ? "warn" : "err"} style={{ width: `${Math.max(3, value)}%` }} />
                    </div>
                    <strong className="mono">{value}%</strong>
                    <em>
                      {row ? `${row.pass}✓ ${row.warn}! ${row.fail}✕` : "—"}
                    </em>
                  </div>
                );
              })}
            </div>
            <div className="guard-summary">
              <span>
                <strong>{passes.length}</strong> controls passing
              </span>
              <span>
                <strong>{findings.length}</strong> need attention
              </span>
              <span>
                last scan {scan.durationMs} ms · {scan.privileged ? "root helper connected" : "read-only"}
              </span>
            </div>
            {scan.drift.length > 0 ? (
              <div className="guard-drift">
                <div className="guard-drift-head">
                  <strong>Baseline drift</strong>
                  <button className="btn small" onClick={() => void acceptBaseline()} disabled={busy === "baseline"}>
                    Accept as baseline
                  </button>
                </div>
                {scan.drift.map((entry) => (
                  <div key={entry.key} className="guard-drift-row mono">
                    <span>{entry.key.replace(/^fim:/, "")}</span>
                    <em>
                      {entry.before.slice(0, 10)} → {entry.after.slice(0, 10)}
                    </em>
                  </div>
                ))}
              </div>
            ) : null}
            {scan.bans.length > 0 ? (
              <div className="guard-bans">
                <strong>Contained this run</strong>
                {scan.bans.map((address) => (
                  <Chip key={address} tone="warn">
                    {address} · 24h
                  </Chip>
                ))}
              </div>
            ) : null}
          </Panel>

          <Panel
            eyebrow="FINDINGS"
            title={findings.length === 0 ? "Nothing outstanding" : `${findings.length} to review`}
            actions={
              <button className="btn small ghost" onClick={() => setShowAll((value) => !value)}>
                {showAll ? "Only findings" : "All checks"}
              </button>
            }
          >
            <div className="guard-findings">
              {visible.length === 0 ? <p className="guard-empty">Every control passed on the last scan.</p> : null}
              {visible.map((check) => (
                <div key={check.id} className={`guard-finding status-${check.status}`}>
                  <div className="guard-finding-head">
                    <Chip tone={check.status === "pass" ? "ok" : check.status === "unknown" ? "muted" : SEVERITY_TONE[check.severity]}>{check.status}</Chip>
                    <strong>{check.title}</strong>
                    <span className="guard-layer-tag">{LAYER_LABEL[check.layer]}</span>
                    {check.remediation && check.status !== "pass" ? (
                      <button className="btn small" onClick={() => fix(check)} disabled={busy === check.remediation}>
                        {busy === check.remediation ? "Applying…" : "Fix"}
                      </button>
                    ) : null}
                  </div>
                  <p>{check.detail}</p>
                  {check.evidence ? <code>{check.evidence}</code> : null}
                  {pending && pending.action === check.remediation ? (
                    <div className="guard-confirm">
                      <strong>{pending.label} can lock you out.</strong>
                      <span>The helper validates the config and reloads sshd, but verify you still have key access.</span>
                      <div>
                        <button className="btn small primary" onClick={() => void apply(pending.action, pending.label)}>
                          Apply anyway
                        </button>
                        <button className="btn small ghost" onClick={() => setPending(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </Panel>
        </div>
      ) : null}

      <Panel
        eyebrow="TAMPER-EVIDENT LOG"
        title="Guard journal"
        actions={
          <div className="guard-journal-tools">
            <div className="guard-journal-tabs">
              <button className={`btn small ghost ${journalKind === "all" ? "active" : ""}`} onClick={() => setJournalKind("all")}>
                All
              </button>
              <button
                className={`btn small ghost ${journalKind === "install" ? "active" : ""}`}
                onClick={() => setJournalKind("install")}
              >
                Installs
              </button>
            </div>
            <select
              className="guard-journal-route-filter"
              aria-label="Filter journal by helper install route"
              value={journalRoute}
              onChange={(event) => setJournalRoute(event.target.value as "all" | HelperRoute)}
            >
              <option value="all">Any route</option>
              {HELPER_ROUTES.map((route) => (
                <option key={route} value={route}>
                  {route}
                </option>
              ))}
            </select>
            <span className="guard-journal-count mono">
              {journalRows.length}/{overview.journal.length}
            </span>
            <span className="guard-chain mono">{overview.chain.ok ? "chain ok" : "chain broken"}</span>
          </div>
        }
      >
        <div className="guard-journal">
          <div className="guard-journal-head" aria-hidden="true">
            <span>Time</span>
            <span>Kind</span>
            <span>Trigger</span>
            <span>Route</span>
            <span>Host</span>
            <span>Record</span>
            <span>Hash</span>
          </div>
          {journalRows.map((entry) => (
            <div key={`${entry.seq}-${entry.at}`} className="guard-journal-row">
              <span className="mono">{new Date(entry.at).toLocaleTimeString()}</span>
              <Chip tone={JOURNAL_TONE[entry.kind] ?? "muted"}>{entry.kind}</Chip>
              <span className={`guard-journal-trigger ${entry.trigger ? `trigger-${entry.trigger}` : "empty"}`}>
                {entry.trigger ?? "—"}
              </span>
              <span className={`guard-journal-route ${entry.route ? `route-${entry.route}` : "empty"}`}>{entry.route ?? "—"}</span>
              <span className="guard-journal-host">{entry.label}</span>
              <span className="guard-journal-message">{entry.message}</span>
              <span className="mono guard-journal-hash">{entry.hash.slice(0, 8)}</span>
            </div>
          ))}
          {overview.journal.length === 0 ? <p className="guard-empty">No records yet.</p> : null}
          {overview.journal.length > 0 && journalRows.length === 0 ? (
            <p className="guard-empty">No records match the current filter.</p>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
