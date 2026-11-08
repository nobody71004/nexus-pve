import { useMemo, useState } from "react";
import type { VmAction, VmSummary } from "../../shared/types";
import { bytes, cx, duration, pct } from "../lib/format";
import { Icon } from "./Icon";
import { Chip, MiniBar, StatusDot, toneFor } from "./ui";

export function VmTable({
  vms,
  onSelect,
  onAction,
  busy,
}: {
  vms: VmSummary[];
  onSelect: (vm: VmSummary) => void;
  onAction: (vm: VmSummary, action: VmAction) => void;
  busy: string | null;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "running" | "stopped" | "paused">("all");

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return vms.filter((vm) => {
      if (filter !== "all" && vm.status !== filter) return false;
      if (!term) return true;
      return `${vm.name} ${vm.vmid} ${vm.node} ${vm.tags.join(" ")}`.toLowerCase().includes(term);
    });
  }, [vms, search, filter]);

  const running = vms.filter((vm) => vm.status === "running").length;

  return (
    <div className="vm-table-wrap">
      <div className="table-toolbar">
        <div className="filter-pills">
          {(
            [
              ["all", `All ${vms.length}`],
              ["running", `Running ${running}`],
              ["stopped", `Stopped ${vms.filter((vm) => vm.status === "stopped").length}`],
              ["paused", `Paused ${vms.filter((vm) => vm.status === "paused").length}`],
            ] as const
          ).map(([value, label]) => (
            <button key={value} className={cx("pill", filter === value && "active")} onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
        </div>
        <label className="search">
          <Icon name="search" size={14} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter by name, id, node or tag…" />
          {search ? (
            <button className="search-clear" onClick={() => setSearch("")} aria-label="Clear">
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </label>
      </div>

      <div className="table-scroll">
        <table className="vm-table">
          <thead>
            <tr>
              <th className="w-status">State</th>
              <th>Guest</th>
              <th>Node</th>
              <th className="w-cpu">CPU</th>
              <th className="w-mem">Memory</th>
              <th className="w-disk">Disk</th>
              <th className="w-up">Uptime</th>
              <th className="w-actions" />
            </tr>
          </thead>
          <tbody>
            {visible.map((vm) => {
              const memPct = pct(vm.mem, vm.maxmem);
              const diskPct = pct(vm.disk, vm.maxdisk);
              const cpuPct = vm.cpu * 100;
              const key = vm.key;
              return (
                <tr key={key} onClick={() => onSelect(vm)} className={cx(vm.status === "stopped" && "dim")}>
                  <td>
                    <Chip tone={vm.status === "running" ? "ok" : vm.status === "paused" ? "warn" : "muted"} dot>
                      {vm.status}
                    </Chip>
                  </td>
                  <td>
                    <div className="guest-cell">
                      <span className={cx("guest-icon", vm.type)}>{vm.type === "lxc" ? "CT" : "VM"}</span>
                      <div>
                        <strong>{vm.name}</strong>
                        <span className="mono subtle">
                          {vm.vmid}
                          {vm.tags.length > 0 ? <em className="tag-inline">{vm.tags.slice(0, 2).join(" · ")}</em> : null}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="mono subtle">{vm.node}</td>
                  <td>
                    <div className="cell-meter">
                      <MiniBar value={cpuPct} tone={toneFor(cpuPct)} />
                      <span className="mono">{vm.status === "running" ? `${cpuPct.toFixed(0)}%` : "—"}</span>
                    </div>
                    <span className="cell-sub mono">{vm.cpus} vCPU</span>
                  </td>
                  <td>
                    <div className="cell-meter">
                      <MiniBar value={memPct} tone={toneFor(memPct)} />
                      <span className="mono">{Math.round(memPct)}%</span>
                    </div>
                    <span className="cell-sub mono">
                      {bytes(vm.mem)} / {bytes(vm.maxmem)}
                    </span>
                  </td>
                  <td>
                    <div className="cell-meter">
                      <MiniBar value={diskPct} tone="violet" />
                      <span className="mono">{Math.round(diskPct)}%</span>
                    </div>
                    <span className="cell-sub mono">{bytes(vm.disk)}</span>
                  </td>
                  <td className="mono subtle">{vm.status === "running" ? duration(vm.uptime) : "—"}</td>
                  <td>
                    <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                      {vm.status !== "running" ? (
                        <button
                          className="btn icon ghost"
                          title="Start"
                          disabled={busy === key}
                          onClick={() => onAction(vm, "start")}
                        >
                          <Icon name="play" size={13} />
                        </button>
                      ) : (
                        <>
                          <button
                            className="btn icon ghost"
                            title="Graceful shutdown"
                            disabled={busy === key}
                            onClick={() => onAction(vm, "shutdown")}
                          >
                            <Icon name="power" size={13} />
                          </button>
                          <button
                            className="btn icon ghost"
                            title="Reboot"
                            disabled={busy === key}
                            onClick={() => onAction(vm, "reboot")}
                          >
                            <Icon name="reboot" size={13} />
                          </button>
                          <button
                            className="btn icon ghost danger"
                            title="Force stop"
                            disabled={busy === key}
                            onClick={() => onAction(vm, "stop")}
                          >
                            <Icon name="stop" size={12} />
                          </button>
                        </>
                      )}
                      <button className="btn icon ghost" title="Open details" onClick={() => onSelect(vm)}>
                        <Icon name="chevron" size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <div className="table-empty">
                    <StatusDot state="offline" />
                    <span>No guests match this filter.</span>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
