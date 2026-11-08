import { useCallback, useEffect, useMemo, useState } from "react";
import type { SpeedTestResult, SshHostSummary } from "../../shared/types";
import { bridge } from "../lib/bridge";
import { ago, cx, pct } from "../lib/format";
import { speedHistory, useSpeedHistory } from "../lib/speed";
import { Icon } from "./Icon";
import { Chip, Panel, Skeleton, StatTile } from "./ui";

/** 8300 → "8.3 Gbps", 940 → "940 Mbps", 0 → "—". */
export function mbps(value: number | undefined): string {
  if (!value || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} Gbps`;
  if (value >= 100) return `${Math.round(value)} Mbps`;
  return `${value.toFixed(1)} Mbps`;
}

/** 10000 → "10 GbE", 2500 → "2.5 GbE". */
export function linkLabel(linkMbps: number | undefined): string | null {
  if (!linkMbps || linkMbps <= 0) return null;
  if (linkMbps >= 1000) return `${Math.round((linkMbps / 1000) * 10) / 10} GbE`;
  return `${linkMbps} MbE`;
}

/** Compact label for the host card: 8311 → "8.3 G", 940 → "940 M". */
export function shortRate(value: number | undefined): string {
  if (!value || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} G`;
  return `${Math.round(value)} M`;
}

function historyMax(entries: SpeedTestResult[]): number {
  return Math.max(1, ...entries.map((entry) => entry.downMbps), ...entries.map((entry) => entry.upMbps));
}

export function Throughput({
  onToast,
}: {
  onToast: (level: "info" | "ok" | "warn" | "error", title: string, detail?: string) => void;
}) {
  const [hosts, setHosts] = useState<SshHostSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const history = useSpeedHistory();

  useEffect(() => {
    let cancelled = false;
    void bridge.ssh
      .hosts()
      .then((list) => {
        if (!cancelled) setHosts(list);
      })
      .catch((error: unknown) => {
        if (!cancelled) onToast("error", "Could not list endpoints", error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [onToast]);

  const run = useCallback(
    async (hostId?: string) => {
      setBusy(hostId ?? "all");
      try {
        const entries = hostId ? [await bridge.ssh.speedtest(hostId)] : await bridge.ssh.speedtestAll();
        speedHistory.recordMany(entries);
        const failed = entries.filter((entry) => entry.error);
        const measured = entries.filter((entry) => !entry.error);
        if (measured.length > 0) {
          const best = measured.reduce((top, entry) => (entry.downMbps > top.downMbps ? entry : top));
          onToast(
            failed.length > 0 ? "warn" : "ok",
            hostId ? "Speed test complete" : "Fleet speed test",
            `${best.label}: ${mbps(best.downMbps)} down · ${mbps(best.upMbps)} up${
              failed.length > 0 ? ` · ${failed.length} endpoint(s) could not be measured` : ""
            }`,
          );
        } else if (failed.length > 0) {
          onToast("error", "Speed test failed", failed[0].error);
        }
      } catch (error) {
        onToast("error", "Speed test failed", error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
    [onToast],
  );

  const rows = useMemo(
    () =>
      (hosts ?? []).map((host) => ({
        host,
        latest: history[host.id]?.at(-1),
        series: history[host.id] ?? [],
      })),
    [hosts, history],
  );

  const measured = rows.map((row) => row.latest).filter((entry): entry is SpeedTestResult => Boolean(entry && !entry.error));
  const fastestDown = measured.reduce<SpeedTestResult | null>((top, entry) => (!top || entry.downMbps > top.downMbps ? entry : top), null);
  const fastestUp = measured.reduce<SpeedTestResult | null>((top, entry) => (!top || entry.upMbps > top.upMbps ? entry : top), null);
  const capacity = rows.reduce((sum, row) => sum + (row.latest?.linkMbps ?? 0), 0);

  if (hosts === null) {
    return (
      <div className="stack">
        <Skeleton height={96} />
        <Skeleton height={220} />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="stat-strip">
        <StatTile label="Endpoints" value={hosts.length} hint={`${measured.length} measured`} icon="terminal" tone="cyan" />
        <StatTile
          label="Fastest download"
          value={fastestDown ? mbps(fastestDown.downMbps) : "—"}
          hint={fastestDown ? `${fastestDown.label} · via ${fastestDown.endpoint ?? "mirror"}` : "run a test to populate"}
          icon="download"
          tone="green"
        />
        <StatTile
          label="Fastest upload"
          value={fastestUp ? mbps(fastestUp.upMbps) : "—"}
          hint={fastestUp ? fastestUp.label : "run a test to populate"}
          icon="external"
          tone="violet"
        />
        <StatTile
          label="Provisioned links"
          value={capacity > 0 ? linkLabel(capacity) ?? "—" : "—"}
          hint="sum of reported NIC rates"
          icon="plug"
          tone="cyan"
        />
      </div>

      <Panel
        eyebrow="THROUGHPUT"
        title="Endpoint speed"
        actions={
          <button className="btn small primary" onClick={() => void run()} disabled={busy !== null || hosts.length === 0}>
            <Icon name="activity" size={13} className={busy === "all" ? "spin" : ""} />
            {busy === "all" ? "Measuring…" : "Test all endpoints"}
          </button>
        }
      >
        {hosts.length === 0 ? (
          <div className="empty-inline">
            <Icon name="terminal" size={20} />
            <div>
              <strong>No SSH endpoints yet</strong>
              <p>Add a VPS or bare-metal box under Linux hosts. Throughput is measured over HTTPS, so nothing is installed on the target.</p>
            </div>
          </div>
        ) : (
          <div className="endpoint-grid">
            {rows.map(({ host, latest, series }) => {
              const link = linkLabel(latest?.linkMbps);
              const ceiling = latest?.linkMbps ?? Math.max(1, ...measured.map((entry) => entry.downMbps));
              const downPct = latest ? pct(latest.downMbps, ceiling) : 0;
              const upPct = latest ? pct(latest.upMbps, ceiling) : 0;
              const peak = historyMax(series);
              return (
                <article className={cx("endpoint-card", busy === host.id && "measuring")} key={host.id}>
                  <header>
                    <span className="host-color" style={{ background: host.color }} />
                    <div>
                      <strong>{host.label}</strong>
                      <span className="mono subtle">
                        {host.username}@{host.host}:{host.port}
                        {latest?.device ? ` · ${latest.device}` : ""}
                      </span>
                    </div>
                    {link ? <Chip tone="info">{link}</Chip> : null}
                    <button className="btn small ghost" onClick={() => void run(host.id)} disabled={busy !== null}>
                      {busy === host.id ? "Measuring…" : "Test"}
                    </button>
                  </header>

                  {latest ? (
                    <>
                      <div className="endpoint-rates">
                        <div className="endpoint-rate">
                          <span>DOWN</span>
                          <div className="meter">
                            <i style={{ width: `${downPct}%` }} />
                          </div>
                          <b className="mono">{mbps(latest.downMbps)}</b>
                        </div>
                        <div className="endpoint-rate">
                          <span>UP</span>
                          <div className="meter violet">
                            <i style={{ width: `${upPct}%` }} />
                          </div>
                          <b className="mono">{mbps(latest.upMbps)}</b>
                        </div>
                      </div>

                      {latest.error ? <p className="inline-error">{latest.error}</p> : null}

                      <div className="endpoint-meta">
                        <span>
                          RTT <b className="mono">{latest.latencyMs || "—"} ms</b>
                        </span>
                        <span>
                          Jitter <b className="mono">{latest.jitterMs ? `${latest.jitterMs} ms` : "—"}</b>
                        </span>
                        <span>
                          Via <b>{latest.endpoint ?? "—"}</b>
                        </span>
                        <span>
                          Streams{" "}
                          <b className="mono">
                            {latest.streams ?? "—"}
                            {latest.cutStreams ? ` · ${latest.cutStreams} cut` : ""}
                          </b>
                        </span>
                        <span>
                          Moved <b className="mono">{latest.bytes > 0 ? `${Math.round(latest.bytes / 1_048_576)} MB` : "—"}</b>
                        </span>
                        <span className="endpoint-when">{ago(latest.at)}</span>
                      </div>

                      {series.length > 1 ? (
                        <div className="endpoint-history" title="Recent downloads, newest last">
                          {series.map((entry) => (
                            <i
                              key={entry.at}
                              className={cx(entry.error && "failed")}
                              style={{ height: `${Math.max(8, (entry.downMbps / peak) * 100)}%` }}
                              title={`${new Date(entry.at).toLocaleTimeString()} · ${mbps(entry.downMbps)} down · ${mbps(entry.upMbps)} up`}
                            />
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className="subtle small">
                      Not measured yet. A run transfers up to ~500 MB down and ~64 MB up, split across CacheFly, Hetzner US and OVH EU.
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel eyebrow="METHOD" title="How the number is produced">
        <ul className="method-list small">
          <li>
            <b>Five parallel HTTPS streams</b> across three mirrors, capped at five seconds each. A single stream answers "what does one
            TCP flow do"; the aggregate answers "what can this box move".
          </li>
          <li>
            <b>Stalled and refused streams are dropped.</b> A mirror that answers with a rate-limit body, or a socket that stalls, no longer
            drags the average down — it is counted under <em>cut</em> instead. A host is only reported as slow when the healthy streams say so.
          </li>
          <li>
            <b>Link rate comes from the NIC</b> (<span className="mono">ethtool</span>), so you can see the port's provisioned speed next to
            what the internet path actually delivered.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
