import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { HelperState, HelperStatus } from "../../shared/types";
import { bridge } from "../lib/bridge";
import { cx } from "../lib/format";
import { helperFleet, noteHelper, refreshHelpers, subscribeHelpers } from "../lib/helperFleet";
import { Icon } from "./Icon";
import { Chip, Modal, Panel } from "./ui";

/**
 * Fleet-wide view of the privileged helper.
 *
 * The Linux hosts tab owns the per-host detail; this is the "is the fleet ready
 * for privileged actions?" summary that belongs on the command deck. It reads
 * the shared readiness store, so the rail badge always agrees with these
 * counts, and its Fix all runs the same installer the host cards use — including
 * a one-time sudo prompt for key-auth hosts behind a NOPASSWD grant.
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
  const [sudoPrompt, setSudoPrompt] = useState<{
    queue: HelperStatus[];
    index: number;
    targets: HelperStatus[];
  } | null>(null);
  const [sudoDraft, setSudoDraft] = useState("");
  const cancelled = useRef(false);
  // Passwords live only for the current Fix all run. They are never written to
  // the fleet store, the host record, or the render state.
  const fixPasswords = useRef(new Map<string, string>());
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
      fixPasswords.current.clear();
    };
  }, []);

  const ready = statuses.filter((status) => status.state === "ready").length;
  const outdated = statuses.filter((status) => status.state === "outdated").length;
  const missing = statuses.filter((status) => status.state === "missing" || status.state === "partial").length;
  const blocked = statuses.filter((status) => status.state === "blocked").length;
  const hostsById = new Map(hosts.map((host) => [host.id, host]));
  /**
   * A key-auth host cannot reuse an SSH password for sudo, and the NOPASSWD
   * grant may only run the helper, not replace it. Any non-ready helper on such
   * a host therefore needs a sudo password typed for this one install.
   */
  const needsSudoPassword = (status: HelperStatus) =>
    status.state !== "ready" &&
    status.state !== "blocked" &&
    status.route !== "root" &&
    hostsById.get(status.hostId)?.authMode !== "password";
  const unreadable = hosts.length - statuses.length;
  const readyPct = statuses.length > 0 ? Math.round((ready / statuses.length) * 100) : 0;
  const attention = statuses.filter((status) => status.state !== "ready");
  const targets = statuses.filter((status) => status.state !== "ready" && status.state !== "blocked");
  const keyTargets = targets.filter(needsSudoPassword);
  const firstKey = keyTargets[0];
  const keyHostLabel = firstKey ? (hostsById.get(firstKey.hostId)?.label ?? firstKey.user) : "";
  const promptStatus = sudoPrompt ? sudoPrompt.queue[sudoPrompt.index] : null;
  const promptHost = promptStatus ? hostsById.get(promptStatus.hostId) : undefined;

  const installTargets = async (batch: HelperStatus[], passwords: Map<string, string>) => {
    if (busy || batch.length === 0) return;
    let installed = 0;
    let failed = 0;
    setBusy({ done: 0, total: batch.length });
    for (const [index, target] of batch.entries()) {
      if (cancelled.current) {
        fixPasswords.current.clear();
        return;
      }
      setBusy({ done: index, total: batch.length });
      try {
        const result = await bridge.ssh.installHelper(target.hostId, passwords.get(target.hostId));
        if (result.status) noteHelper(result.status);
        if (result.ok) installed += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    fixPasswords.current.clear();
    if (cancelled.current) return;
    setBusy(null);
    const leftOut = blocked > 0 ? ` · ${blocked} need bootstrap commands` : "";
    toast.current(
      failed === 0 ? "ok" : installed > 0 ? "warn" : "error",
      failed === 0 ? "Privileged helpers installed" : "Helper install incomplete",
      `${installed}/${batch.length} installed${failed > 0 ? ` · ${failed} failed` : ""}${leftOut}`,
    );
    await check();
  };

  const fixAll = () => {
    if (busy || targets.length === 0) return;
    const promptTargets = targets.filter(needsSudoPassword);
    fixPasswords.current = new Map();
    if (promptTargets.length > 0) {
      setSudoDraft("");
      setSudoPrompt({ queue: promptTargets, index: 0, targets });
      return;
    }
    void installTargets(targets, fixPasswords.current);
  };

  const closeSudoPrompt = useCallback(() => {
    if (busy) return;
    setSudoPrompt(null);
    setSudoDraft("");
    fixPasswords.current.clear();
  }, [busy]);

  const submitSudoPrompt = () => {
    if (!sudoPrompt || !sudoDraft.trim() || busy) return;
    const current = sudoPrompt.queue[sudoPrompt.index];
    fixPasswords.current.set(current.hostId, sudoDraft);
    if (sudoPrompt.index + 1 < sudoPrompt.queue.length) {
      setSudoPrompt({ ...sudoPrompt, index: sudoPrompt.index + 1 });
      setSudoDraft("");
      return;
    }
    const batch = sudoPrompt.targets;
    setSudoPrompt(null);
    setSudoDraft("");
    void installTargets(batch, fixPasswords.current);
  };

  // No Linux hosts means privileged helper onboarding does not apply yet.
  if (!loading && hosts.length === 0) return null;

  return (
    <>
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
              onClick={fixAll}
              disabled={loading || busy !== null || targets.length === 0}
              title={
                targets.length === 0
                  ? "Nothing to install: every host is ready or needs bootstrap commands"
                  : keyTargets.length > 0
                    ? `Install the helper on ${targets.length} host${targets.length === 1 ? "" : "s"}; asks for a sudo password on ${keyTargets.length === 1 ? "the key-only host" : "each key-only host"}`
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

        {keyTargets.length > 0 && firstKey ? (
          <p className="hint">
            {keyTargets.length === 1 ? (
              <>
                <b>{keyHostLabel}</b> needs its sudo password once to replace the {LABEL[firstKey.state]} helper. Fix
                all asks for it and never stores it.
              </>
            ) : (
              <>
                {keyTargets.length} key-auth hosts need their sudo passwords once. Fix all asks for each and never
                stores them.
              </>
            )}
          </p>
        ) : null}

        {blocked > 0 ? (
          <p className="hint">
            {blocked === 1 ? "One host has" : `${blocked} hosts have`} no root route. Use the bootstrap commands in
            Linux hosts.{" "}
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

      {sudoPrompt && promptStatus && promptHost ? (
        <Modal
          title={`Sudo password for ${promptHost.label}`}
          subtitle={`${promptHost.username}@${promptHost.host}:${promptHost.port}${
            sudoPrompt.queue.length > 1 ? ` · host ${sudoPrompt.index + 1} of ${sudoPrompt.queue.length}` : ""
          }`}
          onClose={closeSudoPrompt}
          width={500}
          footer={
            <>
              <button className="btn ghost" onClick={closeSudoPrompt} disabled={busy !== null}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={submitSudoPrompt}
                disabled={busy !== null || !sudoDraft.trim()}
              >
                <Icon name="shield" size={13} /> Install helper
              </button>
            </>
          }
        >
          <p className="confirm-body">
            {promptHost.label} is <b>{LABEL[promptStatus.state]}</b>. Replacing the helper needs a real sudo
            elevation. The existing NOPASSWD grant can run the helper, but it cannot replace the helper binary. Enter
            the sudo password for <b>{promptHost.username}</b> once for this install.
          </p>
          {promptStatus.detail ? <p className="hint">{promptStatus.detail}</p> : null}
          <label className="field wide">
            <span>sudo password · used once</span>
            <input
              type="password"
              value={sudoDraft}
              onChange={(event) => setSudoDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitSudoPrompt();
                }
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder={`sudo password for ${promptHost.username}`}
            />
            <em className="hint">
              Sent over SSH only for <code>sudo -S</code>. It is never saved, logged, or exposed to the host after this
              install.
            </em>
          </label>
        </Modal>
      ) : null}
    </>
  );
}
