import { useCallback, useEffect, useRef, useState } from "react";
import type { PraetorCheck, PraetorHealth } from "../../shared/types";
import { bridge } from "../lib/bridge";
import { cx } from "../lib/format";
import { Icon } from "./Icon";
import { Chip, Panel } from "./ui";

const POLL_MS = 60_000;

function toneFor(state: PraetorHealth["state"]): "ok" | "warn" | "err" | "muted" {
  if (state === "ready") return "ok";
  if (state === "outdated") return "warn";
  if (state === "error") return "err";
  return "muted";
}

function labelFor(state: PraetorHealth["state"]): string {
  if (state === "ready") return "Egress ready";
  if (state === "outdated") return "Update available";
  if (state === "error") return "Needs attention";
  return "Not installed";
}

function checkTitle(check: PraetorCheck): string {
  const tcp = check.tcpReachable
    ? `TCP 9443 reachable${check.tcpLatencyMs !== undefined ? ` · ${check.tcpLatencyMs} ms` : ""}`
    : `TCP 9443 unreachable${check.tcpError ? ` · ${check.tcpError}` : ""}`;
  return `${new Date(check.checkedAt).toLocaleString()}\n${tcp}\n${check.firewallDetail}`;
}

/** Recurring single-host PRAETOR service check for the Command Deck. */
export function PraetorHealthPanel({ target, onOpenPraetor }: { target: string; onOpenPraetor: () => void }) {
  const [health, setHealth] = useState<PraetorHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const busy = useRef(false);

  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    try {
      setHealth(await bridge.praetor.health(target));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busy.current = false;
      setChecking(false);
    }
  }, [target]);

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const tick = async () => {
      await check();
      if (live) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [check]);

  const recent = (health?.history ?? []).slice(-24);
  const reachable = recent.filter((entry) => entry.tcpReachable).length;

  return (
    <Panel
      eyebrow="PRAETOR EGRESS"
      title={target}
      actions={
        <Chip tone={health ? toneFor(health.state) : error ? "err" : "muted"} dot>
          {health ? labelFor(health.state) : error ? "Unavailable" : "Checking"}
        </Chip>
      }
    >
      <div className="praetor-health">
        {health ? (
          <>
            <div className="praetor-health-endpoint">
              <span className="mono" title={health.endpoint}>
                {health.endpoint}
              </span>
              <span className="mono subtle">
                {health.tcpReachable ? `${health.tcpLatencyMs ?? "?"} ms` : "no TCP"}
              </span>
            </div>
            <dl className="praetor-facts">
              <div>
                <dt>Service</dt>
                <dd>{health.state === "ready" ? "active" : health.state}</dd>
              </div>
              <div>
                <dt>TCP 9443</dt>
                <dd>{health.tcpReachable ? "reachable" : "unreachable"}</dd>
              </div>
              <div>
                <dt>Last check</dt>
                <dd>{new Date(health.checkedAt).toLocaleTimeString()}</dd>
              </div>
            </dl>
            <div className="praetor-history">
              <div className="praetor-history-head">
                <span>Recent checks</span>
                <span>{recent.length === 0 ? "no checks recorded" : `${reachable}/${recent.length} reachable`}</span>
              </div>
              {recent.length > 0 ? (
                <div className="praetor-history-strip" aria-label={`${target} recent PRAETOR health checks`}>
                  {recent.map((entry, index) => (
                    <span
                      key={`${entry.checkedAt}-${index}`}
                      className={cx(
                        "praetor-history-cell",
                        entry.firewallBlocked ? "blocked" : entry.tcpReachable ? "reachable" : "failed",
                      )}
                      title={checkTitle(entry)}
                    />
                  ))}
                </div>
              ) : (
                <span className="praetor-history-empty">No checks recorded yet</span>
              )}
            </div>
            <p className="praetor-health-detail">{health.detail}</p>
          </>
        ) : (
          <div className="praetor-health-empty">
            <Icon name="key" size={16} />
            <span>
              {error
                ? "PRAETOR health is unavailable."
                : `No PRAETOR endpoint is saved for ${target}. Install the egress to start checking it.`}
            </span>
          </div>
        )}
        {error ? <p className="praetor-error">{error}</p> : null}
        <div className="praetor-health-foot">
          <span className="praetor-panel-note">
            <Icon name="refresh" size={11} /> every 60s
          </span>
          <div className="inline-actions">
            <button className="btn small ghost" onClick={() => void check()} disabled={checking}>
              <Icon name="refresh" size={12} /> {checking ? "Checking…" : "Check now"}
            </button>
            <button className="btn small ghost" onClick={onOpenPraetor}>
              Open
            </button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
