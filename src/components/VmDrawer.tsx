import { useEffect, useState } from "react";
import type { BackupArchive, VmAction, VmDetail, VmSummary } from "../../shared/types";
import { bridge } from "../lib/bridge";
import { bytes, clock, cx, duration, pct } from "../lib/format";
import { Icon } from "./Icon";
import { Chip, Gauge, MiniBar, Skeleton, StatusDot, toneFor } from "./ui";

export function VmDrawer({
  hostId,
  vm,
  archives,
  onClose,
  onAction,
  onLog,
  onSnapshot,
  onRollback,
  onDeleteSnapshot,
  onBackup,
}: {
  hostId: string;
  vm: VmSummary;
  archives: BackupArchive[];
  onClose: () => void;
  onAction: (vm: VmSummary, action: VmAction) => void;
  onLog: (node: string, upid: string) => void;
  onSnapshot: (vm: VmSummary) => void;
  onRollback: (vm: VmSummary, name: string) => void;
  onDeleteSnapshot: (vm: VmSummary, name: string) => void;
  onBackup: (vm: VmSummary) => void;
}) {
  const [detail, setDetail] = useState<VmDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    bridge.pve
      .vmDetail(hostId, vm.node, vm.type, vm.vmid)
      .then((value) => !cancelled && setDetail(value))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [hostId, vm.node, vm.vmid, vm.type]);

  const cpu = (detail?.cpu ?? vm.cpu) * 100;
  const memPct = pct(detail?.mem ?? vm.mem, detail?.maxmem ?? vm.maxmem);
  const diskPct = pct(detail?.disk ?? vm.disk, detail?.maxdisk ?? vm.maxdisk);
  const backups = archives.filter((archive) => archive.vmid === vm.vmid);
  const running = vm.status === "running";

  return (
    <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label={`${vm.name} details`}>
        <header className="drawer-head">
          <div className="drawer-title">
            <span className={cx("guest-icon large", vm.type)}>{vm.type === "lxc" ? "CT" : "VM"}</span>
            <div>
              <h2>{vm.name}</h2>
              <p className="mono">
                {vm.vmid} · {vm.node} · {vm.type === "lxc" ? "LXC container" : "QEMU virtual machine"}
              </p>
            </div>
          </div>
          <div className="drawer-head-actions">
            <Chip tone={running ? "ok" : vm.status === "paused" ? "warn" : "muted"} dot>
              {vm.status}
            </Chip>
            <button className="btn icon ghost" onClick={onClose} aria-label="Close drawer">
              <Icon name="close" />
            </button>
          </div>
        </header>

        <div className="drawer-power">
          {running ? (
            <>
              <button className="btn small" onClick={() => onAction(vm, "shutdown")}>
                <Icon name="power" size={13} /> Shutdown
              </button>
              <button className="btn small" onClick={() => onAction(vm, "reboot")}>
                <Icon name="reboot" size={13} /> Reboot
              </button>
              <button className="btn small danger" onClick={() => onAction(vm, "stop")}>
                <Icon name="stop" size={12} /> Force stop
              </button>
            </>
          ) : (
            <button className="btn small primary" onClick={() => onAction(vm, "start")}>
              <Icon name="play" size={13} /> Start guest
            </button>
          )}
          <button className="btn small" onClick={() => onSnapshot(vm)}>
            <Icon name="layers" size={13} /> Snapshot
          </button>
          <button className="btn small" onClick={() => onBackup(vm)}>
            <Icon name="database" size={13} /> Back up now
          </button>
        </div>

        <div className="drawer-scroll">
          {error ? (
            <div className="inline-error">
              <Icon name="alert" size={15} /> {error}
            </div>
          ) : null}

          <div className="drawer-gauges">
            <Gauge value={cpu} label="CPU" detail={`${vm.cpus} vCPU`} tone={toneFor(cpu)} size={122} />
            <Gauge value={memPct} label="MEMORY" detail={`${bytes(vm.mem)} / ${bytes(vm.maxmem)}`} tone={toneFor(memPct)} size={122} />
            <Gauge value={diskPct} label="DISK" detail={bytes(vm.maxdisk)} tone="violet" size={122} />
          </div>

          <div className="drawer-stats">
            <div>
              <span>Uptime</span>
              <strong>{running ? duration(vm.uptime) : "—"}</strong>
            </div>
            <div>
              <span>Network in</span>
              <strong>{running ? bytes(vm.netin) + "/s" : "—"}</strong>
            </div>
            <div>
              <span>Network out</span>
              <strong>{running ? bytes(vm.netout) + "/s" : "—"}</strong>
            </div>
            <div>
              <span>Disk IO</span>
              <strong>{running ? `${bytes(vm.diskread)} / ${bytes(vm.diskwrite)}` : "—"}</strong>
            </div>
          </div>

          <section className="drawer-section">
            <div className="section-title">
              <h3>Guest agent interfaces</h3>
              <span className="mono subtle">{detail?.agentAvailable ? "qemu-guest-agent" : "not available"}</span>
            </div>
            {detail === null ? (
              <Skeleton height={52} />
            ) : detail.agentNetworks.length === 0 ? (
              <p className="subtle small">
                {vm.type === "lxc"
                  ? "Containers report networking through the node bridge; no agent interface list."
                  : "No guest-agent interfaces. Install and start qemu-guest-agent inside the VM."}
              </p>
            ) : (
              <div className="agent-nics">
                {detail.agentNetworks.map((nic) => (
                  <div className="agent-nic" key={`${nic.name}-${nic.mac}`}>
                    <span className="nic-name">{nic.name}</span>
                    <span className="mono subtle">{nic.mac}</span>
                    <div className="nic-ips">
                      {nic.ips.map((ip) => (
                        <span key={ip.address} className={cx("ip", ip.family)}>
                          {ip.address}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="drawer-section">
            <div className="section-title">
              <h3>Snapshots</h3>
              <span className="mono subtle">{detail?.snapshots.filter((snap) => !snap.current).length ?? 0} stored</span>
            </div>
            {detail === null ? (
              <Skeleton height={44} />
            ) : (
              <div className="snap-list">
                {detail.snapshots
                  .filter((snapshot) => !snapshot.current)
                  .map((snapshot) => (
                    <div className="snap-row" key={snapshot.name}>
                      <div>
                        <strong>{snapshot.name}</strong>
                        <span className="subtle small">
                          {snapshot.description ?? "no description"}
                          {snapshot.snaptime ? ` · ${clock(snapshot.snaptime)}` : ""}
                        </span>
                      </div>
                      <div className="row-actions">
                        <button className="btn small ghost" onClick={() => onRollback(vm, snapshot.name)}>
                          Restore
                        </button>
                        <button className="btn icon ghost danger" onClick={() => onDeleteSnapshot(vm, snapshot.name)} title="Delete snapshot">
                          <Icon name="trash" size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                {detail.snapshots.filter((snapshot) => !snapshot.current).length === 0 ? (
                  <p className="subtle small">No snapshots. Take one before a risky change.</p>
                ) : null}
              </div>
            )}
          </section>

          <section className="drawer-section">
            <div className="section-title">
              <h3>Backup coverage</h3>
              <span className="mono subtle">{backups.length} archive{backups.length === 1 ? "" : "s"}</span>
            </div>
            {backups.length === 0 ? (
              <p className="warn-text small">
                <Icon name="alert" size={12} /> No archive found for this guest in any backup storage.
              </p>
            ) : (
              <div className="snap-list">
                {backups.slice(0, 4).map((archive) => (
                  <div className="snap-row" key={archive.volid}>
                    <div>
                      <strong>{archive.volid.split("/").pop()}</strong>
                      <span className="subtle small">
                        {archive.storage} · {bytes(archive.size ?? 0)} · {archive.ctime ? clock(archive.ctime) : "—"}
                      </span>
                    </div>
                    <MiniBar value={100} tone="green" />
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="drawer-section">
            <div className="section-title">
              <h3>Configuration</h3>
            </div>
            {detail === null ? (
              <Skeleton height={88} />
            ) : (
              <div className="config-grid">
                {Object.entries(detail.config)
                  .slice(0, 18)
                  .map(([key, value]) => (
                    <div key={key}>
                      <span className="mono subtle">{key}</span>
                      <strong className="mono">{String(value)}</strong>
                    </div>
                  ))}
              </div>
            )}
          </section>

          <section className="drawer-section">
            <div className="section-title">
              <h3>Recent tasks</h3>
            </div>
            {detail === null ? (
              <Skeleton height={60} />
            ) : detail.tasks.length === 0 ? (
              <p className="subtle small">No recent tasks for this guest.</p>
            ) : (
              <div className="task-list compact">
                {detail.tasks.slice(0, 6).map((task) => (
                  <button className="task-row" key={task.upid} onClick={() => onLog(task.node, task.upid)}>
                    <StatusDot state={task.state === "ok" ? "online" : task.state === "running" ? "running" : "offline"} />
                    <span className="mono">{task.type}</span>
                    <span className="subtle small">{clock(task.starttime)}</span>
                    <span className={cx("chip", task.state === "ok" ? "chip-ok" : task.state === "error" ? "chip-err" : "chip-info")}>
                      {task.state}
                    </span>
                    <Icon name="chevron" size={12} />
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
