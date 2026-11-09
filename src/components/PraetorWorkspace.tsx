import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  PraetorHostStatus,
  PraetorInstallResult,
  PraetorOverview,
  PraetorProfile,
  PraetorRotateResult,
} from "../../shared/types";
import { bridge } from "../lib/bridge";
import { cx } from "../lib/format";
import { Icon } from "./Icon";
import { Chip, Panel, StatTile, type ToastItem } from "./ui";

export interface PveNodeRef {
  endpoint: string;
  node: string;
}

function stateTone(state: PraetorHostStatus["state"]): "ok" | "warn" | "err" | "muted" {
  if (state === "ready") return "ok";
  if (state === "outdated") return "warn";
  if (state === "error") return "err";
  return "muted";
}

function stateLabel(state: PraetorHostStatus["state"]): string {
  if (state === "ready") return "Egress ready";
  if (state === "outdated") return "Update available";
  if (state === "error") return "Needs attention";
  return "Not installed";
}

function shortKey(value?: string): string {
  if (!value) return "no public key";
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function historyTitle(check: PraetorHostStatus["history"][number]): string {
  const tcp = check.tcpReachable
    ? `TCP 9443 reachable${check.tcpLatencyMs !== undefined ? ` · ${check.tcpLatencyMs} ms` : ""}`
    : `TCP 9443 unreachable${check.tcpError ? ` · ${check.tcpError}` : ""}`;
  const firewall = check.firewallBlocked
    ? "blocked by the Proxmox firewall"
    : check.firewallActive
      ? check.firewallAllow === true
        ? "firewall allows TCP 9443"
        : check.firewallAllow === false
          ? "firewall has no TCP 9443 allow rule"
          : "firewall rule state unknown"
      : "Proxmox firewall is not active";
  return `${new Date(check.checkedAt).toLocaleString()}\n${tcp}\n${firewall}\n${check.firewallDetail}`;
}

function historySummary(history: PraetorHostStatus["history"]): string {
  if (history.length === 0) return "no checks recorded";
  const reachable = history.filter((check) => check.tcpReachable).length;
  const blocked = history.filter((check) => check.firewallBlocked).length;
  return `${reachable}/${history.length} reachable${blocked > 0 ? ` · ${blocked} blocked` : ""}`;
}

function normalizeNode(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function profilesForCopy(profiles: PraetorProfile[]): string {
  return JSON.stringify(profiles, null, 2);
}

export function PraetorWorkspace({
  onToast,
  onOpenHosts,
  pveNodes,
  canManage,
}: {
  onToast: (level: ToastItem["level"], title: string, detail?: string) => void;
  onOpenHosts: () => void;
  pveNodes: PveNodeRef[];
  canManage: boolean;
}) {
  const [overview, setOverview] = useState<PraetorOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [installingAll, setInstallingAll] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, PraetorRotateResult>>({});

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await bridge.praetor.overview();
      setOverview(next);
      setError(null);
      setSelectedId((current) =>
        current && next.hosts.some((host) => host.hostId === current) ? current : next.hosts[0]?.hostId ?? null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyResult = useCallback((result: PraetorInstallResult) => {
    setResults((current) => ({ ...current, [result.hostId]: result }));
    setOverview((current) => {
      if (!current) return current;
      return {
        ...current,
        hosts: current.hosts.map((host) =>
          host.hostId !== result.hostId
            ? host
            : {
                ...host,
                state: result.state,
                detail: result.ok ? "Egress active and TCP 9443 reachable" : result.error || host.detail,
                endpoint: result.endpoint,
                publicKey: result.publicKey ?? host.publicKey,
                profiles: result.profiles.length > 0 ? result.profiles : host.profiles,
                checkedAt: Date.now(),
                error: result.error,
              },
        ),
      };
    });
  }, []);

  const runInstall = useCallback(
    async (hostId: string, quiet = false): Promise<PraetorInstallResult | null> => {
      setBusy(hostId);
      try {
        const result = await bridge.praetor.install(hostId);
        applyResult(result);
        if (!quiet) {
          if (result.ok) {
            onToast(
              result.warning ? "warn" : "ok",
              `PRAETOR ready on ${result.label}`,
              result.warning || `${result.profiles.length} profiles · ${result.endpoint}`,
            );
          } else {
            onToast("error", `PRAETOR failed on ${result.label}`, result.error || result.output.slice(-300));
          }
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setResults((current) => ({
          ...current,
          [hostId]: {
            hostId,
            label: overview?.hosts.find((host) => host.hostId === hostId)?.label ?? hostId,
            ok: false,
            state: "error",
            route: "none",
            endpoint: "",
            profiles: [],
            output: message,
            latencyMs: 0,
            error: message,
          },
        }));
        if (!quiet) onToast("error", "PRAETOR install failed", message);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [applyResult, onToast, overview?.hosts],
  );

  const runRotate = useCallback(
    async (hostId: string) => {
      const label = overview?.hosts.find((host) => host.hostId === hostId)?.label ?? hostId;
      const confirmed = window.confirm(
        `Rotate the PRAETOR keypair on ${label}?\n\n` +
          "The egress restarts with a new X-Wing key. All four pinned client profiles are regenerated on the host and saved locally. Any client still holding the old pin must re-import the profiles. The previous keypair and pins are restored automatically if the egress does not come back.",
      );
      if (!confirmed) return;
      setBusy(hostId);
      try {
        const result = await bridge.praetor.rotate(hostId);
        applyResult(result);
        if (result.ok) {
          onToast("ok", `PRAETOR key rotated on ${result.label}`, `${result.profiles.length} pins updated · ${result.endpoint}`);
        } else {
          onToast("error", `PRAETOR key rotation failed on ${result.label}`, result.error || result.output.slice(-300));
        }
        await refresh(true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setResults((current) => ({
          ...current,
          [hostId]: {
            hostId,
            label,
            ok: false,
            state: "error",
            route: "none",
            endpoint: "",
            profiles: [],
            output: message,
            latencyMs: 0,
            error: message,
          },
        }));
        onToast("error", "PRAETOR key rotation failed", message);
      } finally {
        setBusy(null);
      }
    },
    [applyResult, onToast, overview?.hosts, refresh],
  );

  const hosts = overview?.hosts ?? [];
  const ready = hosts.filter((host) => host.state === "ready").length;
  const profileCount = hosts.reduce((sum, host) => sum + host.profiles.length, 0);
  const allProfiles = hosts.flatMap((host) => host.profiles);
  const selected = hosts.find((host) => host.hostId === selectedId) ?? hosts[0];
  const needsInstall = hosts.filter((host) => host.state !== "ready" || !host.profilesOnHost || host.profiles.length === 0);

  const coverage = useMemo(() => {
    const keys = new Set(hosts.flatMap((host) => [normalizeNode(host.label), normalizeNode(host.host)]));
    const missing = pveNodes.filter((node) => !keys.has(normalizeNode(node.node)));
    return { total: pveNodes.length, covered: pveNodes.length - missing.length, missing };
  }, [hosts, pveNodes]);

  const copy = useCallback(
    async (profiles: PraetorProfile[], title: string) => {
      if (profiles.length === 0) return;
      try {
        await navigator.clipboard.writeText(profilesForCopy(profiles));
        onToast("ok", title, `${profiles.length} PRAETOR/1 profile${profiles.length === 1 ? "" : "s"} copied`);
      } catch {
        onToast("error", "Clipboard unavailable", "The profiles remain saved under the path shown below.");
      }
    },
    [onToast],
  );

  const installAll = useCallback(async () => {
    if (!canManage || needsInstall.length === 0) return;
    const pveWarning =
      coverage.missing.length > 0
        ? `\n\n${coverage.missing.length} Proxmox node${coverage.missing.length === 1 ? "" : "s"} are not in the SSH inventory and cannot be installed: ${coverage.missing
            .map((node) => node.node)
            .slice(0, 6)
            .join(", ")}.`
        : "";
    const confirmed = window.confirm(
      `Install PRAETOR/1 on ${needsInstall.length} SSH host${needsInstall.length === 1 ? "" : "s"}?\n\n` +
        "This adds a root systemd service on TCP 9443, writes four client profiles on each host, and downloads a private Node 22 runtime only when the host has no Node 20+. Proxmox hosts also get an idempotent host firewall rule; an active firewall that still blocks TCP 9443 fails that host's rollout." +
        pveWarning,
    );
    if (!confirmed) return;

    setInstallingAll(true);
    let ok = 0;
    let failed = 0;
    for (const host of needsInstall) {
      const result = await runInstall(host.hostId, true);
      if (result?.ok) ok += 1;
      else failed += 1;
    }
    setInstallingAll(false);
    onToast(
      failed === 0 ? "ok" : "warn",
      failed === 0 ? "PRAETOR rollout complete" : "PRAETOR rollout finished with errors",
      `${ok} installed · ${failed} failed${failed === 0 ? " · profiles refreshed" : ""}`,
    );
    await refresh(true);
  }, [canManage, coverage.missing, needsInstall, onToast, profileCount, refresh, runInstall]);

  return (
    <div className="praetor">
      <section className="praetor-hero" data-spot>
        <div className="praetor-hero-copy">
          <span className="eyebrow">PRAETOR/1 · SEALED EGRESS</span>
          <h2>Every server gets a Praetor exit.</h2>
          <p>
            One rollout writes the egress bundle, per-host X-Wing key, systemd units, firewall allowance and four PRAETOR
            Command profiles to every configured SSH host. Proxmox host rules are added or validated, and a blocked TCP 9443
            endpoint fails the rollout. Private keys never leave the server.
          </p>
          <div className="praetor-hero-tags">
            <Chip tone="violet">X-WING</Chip>
            <Chip tone="info">SIV + COMMITMENT</Chip>
            <Chip tone="muted">TCP 9443</Chip>
          </div>
        </div>
        <div className="praetor-hero-actions">
          <button className="btn small ghost" onClick={() => void refresh()} disabled={loading || installingAll}>
            <Icon name="refresh" size={13} /> {loading ? "Checking…" : "Refresh fleet"}
          </button>
          <button
            className="btn primary"
            onClick={() => void installAll()}
            disabled={!canManage || installingAll || busy !== null || needsInstall.length === 0}
          >
            <Icon name="key" size={14} />
            {installingAll ? "Installing fleet…" : `Install on all ${needsInstall.length || ""}`.trim()}
          </button>
        </div>
      </section>

      <div className="stat-strip praetor-stats">
        <StatTile label="SSH rollout" value={hosts.length} hint="servers, nodes and Proxmox hosts" icon="terminal" tone="cyan" />
        <StatTile
          label="Egress ready"
          value={`${ready}/${hosts.length}`}
          hint={hosts.length === 0 ? "no SSH inventory" : ready === hosts.length ? "all hosts sealed" : "rollout still needed"}
          icon="shield"
          tone={ready === hosts.length && hosts.length > 0 ? "green" : "amber"}
        />
        <StatTile label="Client profiles" value={profileCount} hint="PRAETOR Command imports" icon="key" tone="violet" />
        <StatTile
          label="PVE coverage"
          value={coverage.total > 0 ? `${coverage.covered}/${coverage.total}` : "—"}
          hint={coverage.total === 0 ? "no Proxmox nodes loaded" : `${coverage.missing.length} node${coverage.missing.length === 1 ? "" : "s"} missing SSH`}
          icon="server"
          tone={coverage.total > 0 && coverage.missing.length > 0 ? "amber" : "green"}
        />
      </div>

      {error ? (
        <div className="error-banner">
          <Icon name="alert" size={16} />
          <div>
            <strong>PRAETOR inventory unavailable</strong>
            <span>{error}</span>
          </div>
          <button className="btn small ghost" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : null}

      {coverage.total > 0 && coverage.missing.length > 0 ? (
        <div className="warn-banner">
          <Icon name="alert" size={14} />
          <span>
            {coverage.missing.length} Proxmox node{coverage.missing.length === 1 ? "" : "s"} have no matching SSH host:{" "}
            {coverage.missing.map((node) => node.node).slice(0, 5).join(", ")}
            {coverage.missing.length > 5 ? "…" : ""}. Add them under Linux hosts to include them in the rollout.
          </span>
        </div>
      ) : null}

      <Panel
        eyebrow="ROLLOUT TARGETS"
        title="SSH fleet"
        actions={
          <span className="praetor-panel-note">
            <Icon name="lock" size={12} /> root service · per-host key
          </span>
        }
      >
        {loading && hosts.length === 0 ? (
          <div className="praetor-skeletons">
            {[0, 1, 2].map((item) => (
              <div className="praetor-skeleton" key={item} />
            ))}
          </div>
        ) : hosts.length === 0 ? (
          <div className="praetor-empty">
            <span className="praetor-empty-glyph">
              <Icon name="terminal" size={22} />
            </span>
            <div>
              <h3>No SSH hosts configured</h3>
              <p>
                PRAETOR installs over SSH, not the Proxmox API. Add every server and Proxmox node under Linux hosts, then
                return here for a fleet rollout.
              </p>
              <button className="btn primary" onClick={onOpenHosts}>
                <Icon name="plus" size={13} /> Open Linux hosts
              </button>
            </div>
          </div>
        ) : (
          <div className="praetor-grid">
            {hosts.map((host) => {
              const result = results[host.hostId];
              const history = host.history ?? [];
              const recentChecks = history.slice(-24);
              const cardBusy = busy === host.hostId;
              const canInstall = host.state !== "ready" || !host.profilesOnHost || host.profiles.length === 0;
              return (
                <article
                  className={cx("praetor-card", selected?.hostId === host.hostId && "active")}
                  key={host.hostId}
                  onClick={() => setSelectedId(host.hostId)}
                  data-spot
                >
                  <header>
                    <div className="praetor-card-id">
                      <span className={cx("praetor-orb", host.state === "ready" && "ready")}>
                        <Icon name="key" size={14} />
                      </span>
                      <div>
                        <strong>{host.label}</strong>
                        <span className="mono">
                          {host.username}@{host.host}:{host.port}
                        </span>
                      </div>
                    </div>
                    <Chip tone={stateTone(host.state)} dot>
                      {stateLabel(host.state)}
                    </Chip>
                  </header>

                  <div className="praetor-endpoint">
                    <span>PUBLIC EGRESS</span>
                    <code title={host.endpoint}>{host.endpoint}</code>
                  </div>

                  <dl className="praetor-facts">
                    <div>
                      <dt>Profiles</dt>
                      <dd>{host.profiles.length ? `${host.profiles.length} ready` : "none yet"}</dd>
                    </div>
                    <div>
                      <dt>Public key</dt>
                      <dd className="mono" title={host.publicKey}>
                        {shortKey(host.publicKey)}
                      </dd>
                    </div>
                    <div>
                      <dt>Runtime</dt>
                      <dd>{host.nodeVersion || "—"}</dd>
                    </div>
                    <div>
                      <dt>TCP 9443</dt>
                      <dd>
                        {host.tcpReachable
                          ? `reachable · ${host.tcpLatencyMs ?? "?"} ms`
                          : host.portListening === false
                            ? "not listening"
                            : "unreachable"}
                      </dd>
                    </div>
                  </dl>

                  <div className="praetor-history">
                    <div className="praetor-history-head">
                      <span>Recent checks</span>
                      <span>{historySummary(recentChecks)}</span>
                    </div>
                    {recentChecks.length > 0 ? (
                      <div
                        className="praetor-history-strip"
                        aria-label={`${host.label} recent TCP 9443 and Proxmox firewall checks`}
                      >
                        {recentChecks.map((check, index) => (
                          <span
                            key={`${check.checkedAt}-${index}`}
                            className={cx(
                              "praetor-history-cell",
                              check.firewallBlocked ? "blocked" : check.tcpReachable ? "reachable" : "failed",
                            )}
                            title={historyTitle(check)}
                          />
                        ))}
                      </div>
                    ) : (
                      <span className="praetor-history-empty">No checks recorded yet</span>
                    )}
                  </div>

                  {host.error && host.state !== "ready" ? (
                    <p className="praetor-error">{host.firewallBlocked ? host.detail : host.error}</p>
                  ) : null}
                  {result?.warning ? <p className="praetor-warning">{result.warning}</p> : null}

                  <footer>
                    <span className="praetor-detail">{host.detail}</span>
                    <div className="praetor-card-actions">
                      {canManage && host.state === "ready" ? (
                        <button
                          className="btn small ghost"
                          disabled={installingAll || busy !== null}
                          onClick={(event) => {
                            event.stopPropagation();
                            void runRotate(host.hostId);
                          }}
                        >
                          <Icon name="key" size={12} /> {cardBusy ? "Rotating…" : "Rotate key"}
                        </button>
                      ) : null}
                      {canManage && canInstall ? (
                        <button
                          className="btn small ghost"
                          disabled={installingAll || busy !== null}
                          onClick={(event) => {
                            event.stopPropagation();
                            void runInstall(host.hostId);
                          }}
                        >
                          {cardBusy ? "Installing…" : host.state === "outdated" ? "Update" : host.state === "error" ? "Retry" : "Install"}
                        </button>
                      ) : null}
                      {!canManage ? (
                        <span className="praetor-ready-mark">
                          <Icon name="check" size={12} /> {host.state === "ready" ? "ready" : "read-only"}
                        </span>
                      ) : null}
                    </div>
                  </footer>

                  {result && (result.error || result.warning || result.oldPublicKey) ? (
                    <details className="praetor-output">
                      <summary>{result.oldPublicKey ? "Rotation output" : "Installer output"}</summary>
                      {result.oldPublicKey ? (
                        <p className="praetor-warning">
                          Pin rotated: {shortKey(result.oldPublicKey)} → {shortKey(result.publicKey)}
                        </p>
                      ) : null}
                      <pre>{result.output}</pre>
                    </details>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </Panel>

      <div className="praetor-lower">
        <Panel
          eyebrow="PRAETOR COMMAND"
          title={selected ? `${selected.label} profiles` : "Client profiles"}
          actions={
            <div className="praetor-panel-actions">
              <button
                className="btn small ghost"
                disabled={!selected || selected.profiles.length === 0}
                onClick={() => selected && void copy(selected.profiles, "Profiles copied")}
              >
                <Icon name="download" size={12} /> Copy
              </button>
              <button
                className="btn small ghost"
                disabled={allProfiles.length === 0}
                onClick={() => void copy(allProfiles, "Fleet profiles copied")}
              >
                Copy all
              </button>
            </div>
          }
        >
          <p className="praetor-panel-copy">
            Four PRAETOR/1 profiles are generated for each host from its own public key. PSEAL auto-connects; FAST, BOLT and
            PMARINE are opt-in routing presets.
          </p>
          {selected && selected.profiles.length > 0 ? (
            <div className="praetor-profiles">
              {selected.profiles.map((profile) => (
                <div className="praetor-profile" key={profile.id}>
                  <span className={cx("praetor-profile-mark", profile.color)} />
                  <div>
                    <strong>{profile.suite}</strong>
                    <span className="mono">{profile.endpoint}</span>
                  </div>
                  <Chip tone={profile.autoConnect ? "ok" : "muted"}>{profile.autoConnect ? "AUTO" : "OPT-IN"}</Chip>
                </div>
              ))}
            </div>
          ) : (
            <div className="praetor-profile-empty">
              <Icon name="key" size={16} />
              <span>Install the egress on {selected?.label ?? "a host"} to generate its profiles.</span>
            </div>
          )}
          <div className="praetor-path" title={overview?.profilesPath ?? ""}>
            <span>Saved locally</span>
            <code>{overview?.profilesPath ?? "—"}</code>
          </div>
          <div className="praetor-path" title={overview?.historyPath ?? ""}>
            <span>Check history</span>
            <code>{overview?.historyPath ?? "—"}</code>
          </div>
        </Panel>

        <Panel eyebrow="INVENTORY CHECK" title="Proxmox coverage">
          <div className="praetor-coverage-head">
            <strong>
              {coverage.total > 0 ? `${coverage.covered} of ${coverage.total}` : "No PVE nodes"}
            </strong>
            <Chip tone={coverage.total === 0 ? "muted" : coverage.missing.length > 0 ? "warn" : "ok"} dot>
              {coverage.total === 0 ? "waiting for telemetry" : coverage.missing.length > 0 ? "SSH route needed" : "all matched"}
            </Chip>
          </div>
          <p className="praetor-panel-copy">
            Proxmox API access cannot install packages. Every node needs an SSH entry whose label or address matches the
            node name. The rollout covers every SSH host, so this check prevents a silent gap.
          </p>
          {coverage.missing.length > 0 ? (
            <ul className="praetor-missing">
              {coverage.missing.slice(0, 8).map((node) => (
                <li key={`${node.endpoint}:${node.node}`}>
                  <span>{node.node}</span>
                  <span className="mono">{node.endpoint}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="praetor-ok-text">
              {coverage.total > 0 ? "Every discovered Proxmox node has an SSH route." : "Add a Proxmox endpoint to compare node inventory."}
            </p>
          )}
          <button className="btn small ghost" onClick={onOpenHosts}>
            <Icon name="terminal" size={12} /> Manage SSH hosts
          </button>
        </Panel>
      </div>
    </div>
  );
}
