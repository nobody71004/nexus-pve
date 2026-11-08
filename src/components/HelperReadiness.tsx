import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { HelperState, HelperStatus } from "../../shared/types";
import { bridge } from "../lib/bridge";
import { cx } from "../lib/format";
import { helperFleet, noteHelper, refreshHelpers, subscribeHelpers } from "../lib/helperFleet";
import { Icon } from "./Icon";
import { Chip, Panel } from "./ui";

/**
 * Fleet-wide view of the privileged helper.
 *
 * The Linux hosts tab owns the per-host detail; this is the "is the fleet ready
 * for privileged actions?" summary that belongs on the command deck. It reads
 * the shared readiness store, so the rail badge always agrees with these
 * counts, and its Fix all runs the same installer the host cards use — only on
 * hosts that expose a root route.
 */

const TONE: Record<HelperState, "ok" | "warn" | "err"> = {
  ready: "ok",
  missing: "warn",
  partial: "warn",
  outdated: "warn",
  blocked: "err",
};

const LABEL: Record<HelperState, string> = {
  ready: "ready",
  missing: "missing",
  partial: "partial",
  outdated: "outdated",
  blocked: "no route",
};

const ROUTE: Record<HelperStatus["route"], string> = {
  root: "root account",
  nopasswd: "NOPASSWD grant",
  password: "stored password",
  none: "none",
};

export function HelperReadiness({
  onToast,
  onOpenHosts,
}: {
  onToast: (level: "info" | "warn" | "error" | "ok", title: string, detail?: string) => void;
  onOpenHosts?: () => void;
}) {
  const { hosts, statuses, loading } = useSyncExternalStore(subscribeHelpers, helperFleet);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const cancelled = useRef(false);
  const toast = useRef(onToast);
  toast.current = onToast;

  const check = useCallback(async () => {
    await refreshHelpers({ force: true });
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void refreshHelpers({ force: true });
    return () => {
      cancelled.current = true;
    };
  }, []);

  const ready = statuses.filter((status) => status.state === "ready").length;
  const outdated = statuses.filter((status) => status.state === "outdated").length;
  const missing = statuses.filter((status) => status.state === "missing" || status.state === "partial").length;
  const blocked = statuses.filter((status) => status.state === "blocked").length;
  // A live NOPASSWD grant can run the helper but not replace it. Fix all calls
  // the installer without a one-time password, so only a host whose stored
  // secret `runElevated` may reuse (password auth) stays installable behind
  // that grant; a key-auth host needs the prompt in Linux hosts.
  const hostsById = new Map(hosts.map((host) => [host.id, host]));
  const installable = (status: HelperStatus) =>
    status.state !== "blocked" &&
    (status.route === "root" ||
      status.route === "password" ||
      (status.route === "nopasswd" && hostsById.get(status.hostId)?.authMode === "password"));
  const grantOnly = statuses.filter(
    (status) => status.state !== "ready" && status.state !== "blocked" && !installable(status),
  ).length;
  const unreadable = hosts.length - statuses.length;
  const readyPct = statuses.length > 0 ? Math.round((ready / statuses.length) * 100) : 0;
  const attention = statuses.filter((status) => status.state !== "ready");
  const targets = statuses.filter((status) => status.state !== "ready" && installable(status));

  const fixAll = async () => {
    if (busy || targets.length === 0) return;
    let installed = 0;
    let failed = 0;
    setBusy({ done: 0, total: targets.length });
    for (const [index, target] of targets.entries()) {
      if (cancelled.current) return;
      setBusy({ done: index, total: targets.length });
      try {
        const result = await bridge.ssh.installHelper(target.hostId);
        if (result.status) noteHelper(result.status);
        if (result.ok) installed += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    if (cancelled.current) return;
    setBusy(null);
    const leftOut = blocked > 0 ? ` · ${blocked} need a root route` : "";
    toast.current(
      failed === 0 ? "ok" : installed > 0 ? "warn" : "error",
      failed === 0 ? "Privileged helpers installed" : "Helper install incomplete",
      `${installed}/${targets.length} installed${failed > 0 ? ` · ${failed} failed` : ""}${leftOut}`,
    );
    await check();
  };

  // No Linux hosts means privileged helper onboarding does not apply yet.
  if (!loading && hosts.length === 0) return null;

  return (
    <Panel
      eyebrow="HARDENING"
      title="Privileged helpers"
      actions={
        <div className="inline-actions">
          <button className="btn small ghost" onClick={() => void check()} disabled={loading || busy !== null}>
            <Icon name="refresh" size={13} className={loading ? "spin" : ""} /> Recheck
          </button>
          <button
            className="btn small primary"
            onClick={() => void fixAll()}
            disabled={loading || busy !== null || targets.length === 0}
            title={
              targets.length === 0
                ? "Nothing to install: every host is ready or has no root route"
                : `Install the helper on ${targets.length} host${targets.length === 1 ? "" : "s"}`
            }
          >
            <Icon name="shield" size={13} className={busy ? "spin" : ""} />
            {busy ? `Installing ${Math.min(busy.done + 1, busy.total)}/${busy.total}` : "Fix all"}
          </button>
        </div>
      }
    >
      {statuses.length === 0 ? (
        <p className="hint">{loading ? "Checking each host over SSH…" : "No helper status reported — press Recheck."}</p>
      ) : (
        <>
      <div className="coverage">
        <div
          className="coverage-ring"
          style={{
            background: `radial-gradient(circle at 50% 50%, rgba(8, 12, 20, 1) 56%, transparent 57%), conic-gradient(${
              statuses.length > 0 && ready === statuses.length ? "var(--green)" : "var(--amber)"
            } 0 ${readyPct}%, rgba(255, 255, 255, 0.06) ${readyPct}% 100%)`,
          }}
        >
          <strong>
            {readyPct}
            <small>%</small>
          </strong>
          <span>READY</span>
        </div>
        <div className="coverage-facts">
          <div>
            <span>Helpers ready</span>
            <strong className="mono">
              {ready}/{statuses.length}
            </strong>
          </div>
          <div>
            <span>Missing</span>
            <strong className={cx("mono", missing > 0 && "warn-text")}>{missing}</strong>
          </div>
          <div>
            <span>Outdated</span>
            <strong className={cx("mono", outdated > 0 && "warn-text")}>{outdated}</strong>
          </div>
          <div>
            <span>No root route</span>
            <strong className={cx("mono", blocked > 0 && "danger-text")}>{blocked}</strong>
          </div>
          {unreadable > 0 ? (
            <div>
              <span>Unreadable</span>
              <strong className="mono subtle">{unreadable}</strong>
            </div>
          ) : null}
        </div>
      </div>

      {attention.length > 0 ? (
        <div className="helper-attention">
          {attention.slice(0, 4).map((status) => (
            <div className="helper-attention-row" key={status.hostId}>
              <span className="mono">{hosts.find((host) => host.id === status.hostId)?.label ?? status.user}</span>
              <Chip tone={TONE[status.state]}>{LABEL[status.state]}</Chip>
              <span className="subtle small">{status.route === "none" ? "no root route" : ROUTE[status.route]}</span>
            </div>
          ))}
          {attention.length > 4 ? <p className="subtle small">+{attention.length - 4} more in Linux hosts</p> : null}
        </div>
      ) : (
        <p className="hint">Every host can run service, power, backup and guard actions without a password prompt.</p>
      )}

      {blocked > 0 || grantOnly > 0 ? (
        <p className="hint">
          {blocked > 0 ? "Hosts with no root route" : "Grant-only key hosts"} need a sudo password once, or the bootstrap
          commands, before Fix all can reach them.{" "}
          {onOpenHosts ? (
            <button className="btn small ghost" onClick={onOpenHosts}>
              Open Linux hosts
            </button>
          ) : null}
        </p>
      ) : null}
        </>
      )}
    </Panel>
  );
}
