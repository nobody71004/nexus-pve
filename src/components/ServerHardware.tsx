import type { SshSnapshot } from "../../shared/types";
import { bytes, cx, duration, pct } from "../lib/format";
import { Icon } from "./Icon";

function linkSpeed(mbps: number | undefined): string {
  if (!mbps || mbps <= 0) return "link —";
  if (mbps >= 1000) return `${Math.round((mbps / 1000) * 10) / 10} GbE`;
  return `${mbps} MbE`;
}

/**
 * The same hardware inventory the Proxmox node cards expose, for a plain Linux
 * host. Every value comes from the SSH probe; fields the kernel does not expose
 * are rendered as unavailable instead of being inferred.
 */
export function ServerHardware({
  snapshot,
  compact = false,
}: {
  snapshot: SshSnapshot;
  compact?: boolean;
}) {
  const { cpu, memory, identity, blockDevices, nics, temps } = snapshot;
  const usedPct = memory.total > 0 ? pct(memory.used, memory.total) : 0;
  const disks = compact ? blockDevices.slice(0, 2) : blockDevices;
  const adapters = compact ? nics.slice(0, 2) : nics;
  const sensors = compact ? temps.slice(0, 2) : temps;

  return (
    <section className={cx("hardware-panel", compact && "compact")} aria-label="Server hardware">
      <div className="hardware-head">
        <span className="hardware-kicker">
          <Icon name="cpu" size={12} /> HARDWARE
        </span>
        <span className="hardware-source mono">
          SSH · {snapshot.status.latencyMs} ms
        </span>
      </div>

      <div className="hardware-cpu">
        <div className="hardware-model">
          <strong title={cpu.model || "CPU model not exposed"}>{cpu.model || "CPU model not exposed"}</strong>
          <span className="mono" title={`${identity.os} · ${identity.kernel} · ${identity.arch}`}>
            {identity.os} · {identity.kernel} · {identity.arch} · up {duration(identity.uptime)}
          </span>
        </div>

        <div className="hardware-facts">
          <div className="hardware-fact">
            <span>PHYSICAL</span>
            <strong className="mono">{cpu.physicalCores ?? "—"}</strong>
            <em>{cpu.physicalCores === undefined ? "not exposed" : "cores"}</em>
          </div>
          <div className="hardware-fact">
            <span>THREADS</span>
            <strong className="mono">{cpu.cores || "—"}</strong>
            <em>logical</em>
          </div>
          <div className="hardware-fact">
            <span>SOCKETS</span>
            <strong className="mono">{cpu.sockets ?? "—"}</strong>
            <em>{cpu.sockets === undefined ? "not exposed" : cpu.sockets === 1 ? "socket" : "sockets"}</em>
          </div>
          <div className="hardware-fact">
            <span>CLOCK</span>
            <strong className="mono">{cpu.mhz ? `${cpu.mhz} MHz` : "—"}</strong>
            <em>average</em>
          </div>
          <div className="hardware-fact">
            <span>MEMORY</span>
            <strong className="mono">{bytes(memory.total)}</strong>
            <em>{usedPct.toFixed(0)}% used</em>
          </div>
          <div className="hardware-fact">
            <span>SWAP</span>
            <strong className="mono">{memory.swapTotal > 0 ? bytes(memory.swapTotal) : "—"}</strong>
            <em>{memory.swapTotal > 0 ? `${bytes(memory.swapUsed)} used` : "not configured"}</em>
          </div>
        </div>
      </div>

      <div className="hardware-groups">
        <div className="hardware-group">
          <div className="hardware-group-title">
            <span><Icon name="disk" size={11} /> PHYSICAL DISKS</span>
            <em className="mono">{blockDevices.length}</em>
          </div>
          {disks.length > 0 ? (
            <div className="hardware-list">
              {disks.map((device) => (
                <div className="hardware-disk" key={device.name}>
                  <span className="hardware-device-name mono">{device.name}</span>
                  <div className="hardware-device-main">
                    <strong title={device.model}>{device.model || "Model not exposed"}</strong>
                    <span className="mono">
                      {bytes(device.size)} · {device.rotational ? "HDD" : "SSD"}
                      {device.type && device.type !== "disk" ? ` · ${device.type}` : ""}
                    </span>
                    {device.serial ? <em className="mono" title={device.serial}>S/N {device.serial}</em> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="hardware-empty">No physical disks exposed by lsblk.</p>
          )}
        </div>

        <div className="hardware-group">
          <div className="hardware-group-title">
            <span><Icon name="network" size={11} /> NETWORK ADAPTERS</span>
            <em className="mono">{nics.length}</em>
          </div>
          {adapters.length > 0 ? (
            <div className="hardware-list">
              {adapters.map((nic) => (
                <div className="hardware-nic" key={nic.name}>
                  <strong className="mono">{nic.name}</strong>
                  <span className="hardware-nic-link">
                    {linkSpeed(nic.speedMbps)} <em>{nic.state ?? "state —"}</em>
                  </span>
                  <span className="hardware-nic-mac mono" title={nic.mac ?? "MAC address not exposed"}>
                    {nic.mac ?? "MAC —"}
                  </span>
                  <span className="hardware-nic-io mono">↓ {bytes(nic.rx)} ↑ {bytes(nic.tx)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="hardware-empty">No interface counters readable.</p>
          )}
        </div>

        <div className="hardware-group">
          <div className="hardware-group-title">
            <span><Icon name="thermometer" size={11} /> THERMAL SENSORS</span>
            <em className="mono">{temps.length}</em>
          </div>
          {sensors.length > 0 ? (
            <div className="hardware-list hardware-temps">
              {sensors.map((sensor) => (
                <div className="hardware-temp" key={sensor.label}>
                  <span className="mono" title={sensor.label}>{sensor.label}</span>
                  <strong className={cx("mono", sensor.celsius >= 85 && "warn-text")}>{sensor.celsius.toFixed(1)} °C</strong>
                </div>
              ))}
            </div>
          ) : (
            <p className="hardware-empty">No thermal sensors exposed.</p>
          )}
        </div>
      </div>
    </section>
  );
}
