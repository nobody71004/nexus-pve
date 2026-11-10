import type { CSSProperties } from "react";
import type { SshHostSummary, SshRuntimeStatus, SshSnapshot } from "../../shared/types";
import { bytes, duration, pct } from "../lib/format";
import { findSustainedTemperatureAlert } from "../../shared/gpu-alerts";
import { useGpuAlerts } from "../lib/gpuAlerts";
import { Icon } from "./Icon";
import { Chip, MiniBar, Sparkline, type Tone } from "./ui";
import { GpuTelemetryPanel } from "./GpuDial";
import { ServerHardware } from "./ServerHardware";
import { NodeDial } from "./NodeCard";

function dialTone(value: number, offline: boolean): Tone {
  if (offline) return "red";
  if (value >= 85) return "red";
  if (value >= 70) return "amber";
  return "cyan";
}

function dialState(value: number, offline: boolean, waiting: boolean): string {
  if (offline) return "OFFLINE";
  if (waiting) return "WAITING";
  if (value >= 85) return "CRITICAL";
  if (value >= 70) return "ELEVATED";
  return "NOMINAL";
}

/**
 * A plain Linux server on the Command Deck.
 *
 * The deck used to aggregate only Proxmox nodes, which hid every VPS and edge
 * box that is managed over SSH. This card uses the same chassis and detailed
 * dials as a Proxmox node so both halves of the fleet read the same way.
 */
export function SshServerCard({
  host,
  snapshot,
  status,
}: {
  host: SshHostSummary;
  snapshot?: SshSnapshot;
  status?: SshRuntimeStatus;
}) {
  const health = status?.health ?? snapshot?.status.health ?? "connecting";
  const offline = health === "offline";
  const waiting = !snapshot && !offline;
  const cpu = snapshot?.cpu.usage ?? 0;
  const memoryTotal = snapshot?.memory.total ?? 0;
  const memoryUsed = snapshot?.memory.used ?? 0;
  const memory = memoryTotal > 0 ? pct(memoryUsed, memoryTotal) : 0;
  const swapPct =
    snapshot && snapshot.memory.swapTotal > 0 ? pct(snapshot.memory.swapUsed, snapshot.memory.swapTotal) : 0;
  const root = snapshot?.disks.find((disk) => disk.mount === "/") ?? snapshot?.disks[0];
  const load = snapshot?.cpu.load[0] ?? 0;
  const loadPct = snapshot && snapshot.cpu.cores > 0 ? Math.min(100, (load / snapshot.cpu.cores) * 100) : 0;
  const samples = snapshot?.samples ?? [];
  const cpuPeak = Math.max(cpu, ...samples.map((sample) => sample.cpu));
  const memoryPeak = Math.max(memory, ...samples.map((sample) => sample.mem));
  const net = samples.map((sample) => sample.netRx + sample.netTx);
  const latency = Math.round(status?.latencyMs ?? snapshot?.status.latencyMs ?? 0);
  const thresholds = useGpuAlerts();
  const thermalAlert = findSustainedTemperatureAlert(snapshot?.gpus ?? [], thresholds);

  return (
    <article
      className="node-card"
      data-spot
      style={{ "--node-accent": host.color } as CSSProperties}
    >
      <div className="node-head">
        <div className="node-id">
          <span className="node-glyph">
            <i />
          </span>
          <div>
            <h3>{host.label}</h3>
            <p title={snapshot ? `${snapshot.identity.hostname} · ${snapshot.identity.os}` : `${host.username}@${host.host}`}>
              {snapshot ? `${snapshot.identity.hostname} · ${snapshot.identity.os}` : "Linux server over SSH"}
            </p>
          </div>
        </div>
        <div className="node-badges">
          {thermalAlert ? (
            <Chip
              tone="err"
              dot
              title={`${thermalAlert.gpu.name}: ${thermalAlert.state.temperatureStreak} samples at or above ${thresholds.temperatureC}°C`}
            >
              GPU THERMAL
            </Chip>
          ) : null}
          <Chip tone={health === "online" ? "ok" : health === "degraded" ? "warn" : offline ? "err" : "muted"} dot>
            {health}
          </Chip>
          <span className="mono subtle">{snapshot?.identity.arch || "SSH"}</span>
        </div>
      </div>

      <div className="node-endpoint-line" title={`${host.username}@${host.host}:${host.port}`}>
        <span className="host-color" style={{ background: host.color }} />
        <span>SSH</span>
        <em>
          · {host.username}@{host.host}:{host.port}
        </em>
      </div>

      {status?.error ? <p className="warn-text small">{status.error}</p> : null}

      <div className="node-gauges">
        <NodeDial
          value={cpu}
          label="CPU"
          detail={waiting ? "awaiting probe" : `${load.toFixed(2)} load`}
          tone={dialTone(cpu, offline)}
          status={dialState(cpu, offline, waiting)}
          peak={cpuPeak}
          secondaryPct={loadPct}
          meta={[
            { label: "PEAK", value: `${cpuPeak.toFixed(1)}%` },
            { label: "LOAD", value: waiting ? "—" : load.toFixed(2) },
          ]}
        />
        <NodeDial
          value={memory}
          label="MEMORY"
          detail={snapshot ? `${bytes(memoryUsed)} / ${bytes(memoryTotal)}` : "awaiting probe"}
          tone={dialTone(memory, offline)}
          status={dialState(memory, offline, waiting)}
          peak={memoryPeak}
          secondaryPct={swapPct}
          meta={[
            { label: "PEAK", value: `${memoryPeak.toFixed(1)}%` },
            { label: "SWAP", value: snapshot && snapshot.memory.swapTotal > 0 ? `${swapPct.toFixed(0)}%` : "—" },
          ]}
        />
        <div className="node-facts">
          <div>
            <span>Uptime</span>
            <strong>{snapshot ? duration(snapshot.identity.uptime) : "—"}</strong>
          </div>
          <div>
            <span>Root disk</span>
            <strong className={root && pct(root.used, root.size) > 85 ? "warn-text" : ""}>
              {root ? `${bytes(root.avail)} free` : "—"}
            </strong>
          </div>
          <div>
            <span>Load 1·5·15</span>
            <strong className="mono">
              {snapshot && snapshot.cpu.load.length > 0
                ? snapshot.cpu.load.map((value) => value.toFixed(2)).join(" · ")
                : "—"}
            </strong>
          </div>
          <div>
            <span>Kernel</span>
            <strong title={snapshot?.identity.kernel}>{snapshot?.identity.kernel ?? "—"}</strong>
          </div>
          <div className="node-net">
            <span>Network in/out</span>
            <Sparkline data={net.length > 1 ? net : [0, 0]} width={148} height={30} tone="violet" strokeWidth={1.2} />
          </div>
        </div>
      </div>

      <div className="node-storage">
        {(snapshot?.disks ?? []).slice(0, 2).map((disk) => {
          const usage = pct(disk.used, disk.size);
          return (
            <div className="storage-row" key={`${disk.fs}-${disk.mount}`}>
              <span className="storage-name">
                <Icon name="database" size={12} /> {disk.mount}
              </span>
              <MiniBar value={usage} tone={usage > 85 ? "red" : usage > 70 ? "amber" : "cyan"} />
              <span className={`mono${usage > 85 ? " warn-text" : ""}`}>{Math.round(usage)}%</span>
              <span className="mono subtle">{bytes(disk.avail)} free</span>
            </div>
          );
        })}
        {(snapshot?.disks.length ?? 0) === 0 ? (
          <span className="subtle">{waiting ? "Waiting for the first SSH probe…" : "No filesystems reported"}</span>
        ) : null}
      </div>

      {snapshot ? <ServerHardware snapshot={snapshot} compact /> : null}

      <GpuTelemetryPanel
        gpus={snapshot?.gpus ?? []}
        error={snapshot?.gpuError}
      />

      <div className="node-foot">
        <span>
          <Icon name="terminal" size={12} /> {snapshot?.cpu.cores ?? "—"} threads · {host.authMode === "password" ? "password" : "key"} auth
        </span>
        <span>
          <Icon name="disk" size={12} /> {snapshot?.disks.length ?? 0} filesystem{(snapshot?.disks.length ?? 0) === 1 ? "" : "s"}
        </span>
        <span className="mono">{latency > 0 ? `${latency} ms` : "—"}</span>
      </div>
    </article>
  );
}
