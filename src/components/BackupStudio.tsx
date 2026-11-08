import { useMemo, useState } from "react";
import type {
  BackupArchive,
  BackupRunRequest,
  ClusterBackupJob,
  NodeStats,
  RestoreRequest,
  ScheduleInput,
  VmSummary,
} from "../../shared/types";
import { bytes, cx, dateTime, duration } from "../lib/format";
import { Icon } from "./Icon";
import { Chip, Modal, Panel, StatTile } from "./ui";

const SCHEDULE_PRESETS = ["02:30", "03:15", "sat 03:00", "sun 04:00", "*/6:00"];

export function BackupStudio({
  vms,
  nodes,
  schedules,
  archives,
  loading,
  onRun,
  onRestore,
  onDeleteArchive,
  onSaveSchedule,
  onDeleteSchedule,
  onToggleSchedule,
  onRefresh,
}: {
  vms: VmSummary[];
  nodes: NodeStats[];
  schedules: ClusterBackupJob[];
  archives: BackupArchive[];
  loading: boolean;
  onRun: (req: BackupRunRequest) => Promise<void>;
  onRestore: (req: RestoreRequest) => Promise<void>;
  onDeleteArchive: (archive: BackupArchive) => void | Promise<void>;
  onSaveSchedule: (input: ScheduleInput) => Promise<void>;
  onDeleteSchedule: (id: string) => void | Promise<void>;
  onToggleSchedule: (job: ClusterBackupJob) => Promise<void>;
  onRefresh: () => void;
}) {
  const [runOpen, setRunOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupArchive | null>(null);
  const [busy, setBusy] = useState(false);

  const storages = useMemo(() => {
    const set = new Map<string, string>();
    for (const node of nodes) for (const storage of node.storages) set.set(storage.storage, storage.type);
    return [...set.entries()];
  }, [nodes]);

  const coverage = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86_400_000;
    const covered = new Set(archives.filter((archive) => (archive.ctime ?? 0) > weekAgo).map((archive) => archive.vmid));
    const guests = vms.filter((vm) => !vm.template);
    return {
      covered: guests.filter((vm) => covered.has(vm.vmid)).length,
      total: guests.length,
      bytes: archives.reduce((sum, archive) => sum + (archive.size ?? 0), 0),
      newest: archives[0]?.ctime,
    };
  }, [archives, vms]);

  const guestName = (vmid?: number) => vms.find((vm) => vm.vmid === vmid)?.name ?? "unknown guest";

  return (
    <div className="stack">
      <div className="stat-strip">
        <StatTile
          label="Protection coverage"
          value={coverage.total === 0 ? 0 : Math.round((coverage.covered / coverage.total) * 100)}
          unit="%"
          hint={`${coverage.covered} of ${coverage.total} guests backed up this week`}
          tone={coverage.total > 0 && coverage.covered === coverage.total ? "green" : "amber"}
          icon="shield"
        />
        <StatTile label="Archives" value={archives.length} hint={`${bytes(coverage.bytes)} on disk`} icon="database" tone="cyan" />
        <StatTile
          label="Newest archive"
          value={coverage.newest ? duration((Date.now() - coverage.newest) / 1000) : "—"}
          hint={coverage.newest ? dateTime(coverage.newest) : "no archives found"}
          icon="clock"
          tone="violet"
        />
        <StatTile
          label="Scheduled jobs"
          value={schedules.length}
          hint={`${schedules.filter((job) => job.enabled).length} enabled · native PVE cron`}
          icon="clock"
          tone="green"
        />
      </div>

      <Panel
        eyebrow="AUTOMATION"
        title="Backup schedules"
        actions={
          <>
            <button className="btn small ghost" onClick={onRefresh}>
              <Icon name="refresh" size={13} /> Refresh
            </button>
            <button className="btn small primary" onClick={() => setScheduleOpen(true)}>
              <Icon name="plus" size={13} /> New schedule
            </button>
          </>
        }
      >
        {schedules.length === 0 ? (
          <div className="empty-inline">
            <Icon name="clock" size={18} />
            <div>
              <strong>No scheduled backups</strong>
              <p>Create a native Proxmox cluster backup job so guests are protected even when this app is closed.</p>
            </div>
            <button className="btn small primary" onClick={() => setScheduleOpen(true)}>
              Create one
            </button>
          </div>
        ) : (
          <div className="schedule-grid">
            {schedules.map((job) => (
              <article className={cx("schedule-card", !job.enabled && "disabled")} key={job.id}>
                <header>
                  <div>
                    <strong>{job.comment || `Backup job ${job.id}`}</strong>
                    <span className="mono subtle">
                      {job.schedule} · {job.storage} · {job.mode} · {job.compress}
                    </span>
                  </div>
                  <Chip tone={job.enabled ? "ok" : "muted"} dot>
                    {job.enabled ? "enabled" : "paused"}
                  </Chip>
                </header>
                <div className="schedule-scope">
                  <span>
                    Scope: <b>{job.vmid ? job.vmid.split(",").map((id) => guestName(Number(id))).join(", ") : "all guests"}</b>
                  </span>
                  <span>
                    Next run: <b>{job.nextRun ? dateTime(job.nextRun) : "—"}</b>
                  </span>
                </div>
                <div className="schedule-actions">
                  <button className="btn small ghost" onClick={() => onToggleSchedule(job)}>
                    {job.enabled ? "Pause" : "Enable"}
                  </button>
                  <button className="btn small ghost danger" onClick={() => onDeleteSchedule(job.id)}>
                    <Icon name="trash" size={12} /> Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        eyebrow="ARCHIVE INVENTORY"
        title="Backup archives"
        actions={
          <button className="btn small primary" onClick={() => setRunOpen(true)}>
            <Icon name="download" size={13} /> Run backup now
          </button>
        }
        flush
      >
        <div className="table-scroll">
          <table className="vm-table archives">
            <thead>
              <tr>
                <th>Guest</th>
                <th>Archive</th>
                <th>Storage</th>
                <th>Size</th>
                <th>Created</th>
                <th className="w-actions" />
              </tr>
            </thead>
            <tbody>
              {archives.map((archive) => (
                <tr key={archive.volid}>
                  <td>
                    <div className="guest-cell">
                      <span className="guest-icon lxc">BK</span>
                      <div>
                        <strong>{guestName(archive.vmid)}</strong>
                        <span className="mono subtle">vmid {archive.vmid ?? "?"}</span>
                      </div>
                    </div>
                  </td>
                  <td className="mono small archive-name">{archive.volid.split("/").pop()}</td>
                  <td className="mono subtle">{archive.storage}</td>
                  <td className="mono">{bytes(archive.size ?? 0)}</td>
                  <td className="mono subtle">{dateTime(archive.ctime)}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn small ghost" onClick={() => setRestoreTarget(archive)}>
                        <Icon name="download" size={12} /> Restore
                      </button>
                      <button
                        className="btn icon ghost danger"
                        title="Delete archive"
                        onClick={() => onDeleteArchive(archive)}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {archives.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <div className="table-empty">
                      {loading ? "Scanning backup storages…" : "No archives found on any backup-capable storage."}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>

      {runOpen ? (
        <RunBackupModal
          nodes={nodes}
          vms={vms}
          storages={storages}
          busy={busy}
          onClose={() => setRunOpen(false)}
          onSubmit={async (request) => {
            setBusy(true);
            try {
              await onRun(request);
              setRunOpen(false);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {scheduleOpen ? (
        <ScheduleModal
          nodes={nodes}
          vms={vms}
          storages={storages}
          busy={busy}
          onClose={() => setScheduleOpen(false)}
          onSubmit={async (input) => {
            setBusy(true);
            try {
              await onSaveSchedule(input);
              setScheduleOpen(false);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {restoreTarget ? (
        <RestoreModal
          archive={restoreTarget}
          vms={vms}
          storages={storages}
          busy={busy}
          onClose={() => setRestoreTarget(null)}
          onSubmit={async (request) => {
            setBusy(true);
            try {
              await onRestore(request);
              setRestoreTarget(null);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function RunBackupModal({
  nodes,
  vms,
  storages,
  busy,
  onClose,
  onSubmit,
}: {
  nodes: NodeStats[];
  vms: VmSummary[];
  storages: [string, string][];
  busy: boolean;
  onClose: () => void;
  onSubmit: (req: BackupRunRequest) => Promise<void>;
}) {
  const [node, setNode] = useState(nodes[0]?.node ?? "");
  const [vmid, setVmid] = useState<string>(String(vms[0]?.vmid ?? ""));
  const [storage, setStorage] = useState(storages[0]?.[0] ?? "");
  const [mode, setMode] = useState<"snapshot" | "suspend" | "stop">("snapshot");
  const [compress, setCompress] = useState<"zstd" | "gzip" | "lzo" | "0">("zstd");
  const onNode = vms.filter((vm) => vm.node === node);

  return (
    <Modal
      title="Run a backup now"
      subtitle="vzdump runs on the node; progress streams into the task console."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !node || !storage}
            onClick={() => onSubmit({ node, vmid: vmid ? Number(vmid) : undefined, storage, mode, compress, notes: "Nexus PVE manual backup" })}
          >
            {busy ? "Starting…" : "Start backup"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span>Node</span>
          <select value={node} onChange={(event) => setNode(event.target.value)}>
            {nodes.map((entry) => (
              <option key={entry.node} value={entry.node}>
                {entry.node}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Guest</span>
          <select value={vmid} onChange={(event) => setVmid(event.target.value)}>
            <option value="">All guests on node</option>
            {onNode.map((vm) => (
              <option key={vm.vmid} value={vm.vmid}>
                {vm.vmid} · {vm.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Target storage</span>
          <select value={storage} onChange={(event) => setStorage(event.target.value)}>
            {storages.map(([name, type]) => (
              <option key={name} value={name}>
                {name} ({type})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Snapshot mode</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
            <option value="snapshot">snapshot — no downtime</option>
            <option value="suspend">suspend — brief pause</option>
            <option value="stop">stop — cold backup</option>
          </select>
        </label>
        <label className="field">
          <span>Compression</span>
          <select value={compress} onChange={(event) => setCompress(event.target.value as typeof compress)}>
            <option value="zstd">zstd (fast, balanced)</option>
            <option value="gzip">gzip (smaller, slower)</option>
            <option value="lzo">lzo</option>
            <option value="0">none</option>
          </select>
        </label>
      </div>
      <p className="hint">
        <Icon name="alert" size={12} /> A snapshot-mode backup needs free space for the snapshot delta on the guest's storage.
      </p>
    </Modal>
  );
}

function ScheduleModal({
  nodes,
  vms,
  storages,
  busy,
  onClose,
  onSubmit,
}: {
  nodes: NodeStats[];
  vms: VmSummary[];
  storages: [string, string][];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: ScheduleInput) => Promise<void>;
}) {
  const [node, setNode] = useState(nodes[0]?.node ?? "");
  const [scope, setScope] = useState("all");
  const [storage, setStorage] = useState(storages[0]?.[0] ?? "");
  const [schedule, setSchedule] = useState("02:30");
  const [mode, setMode] = useState<"snapshot" | "suspend" | "stop">("snapshot");
  const [compress, setCompress] = useState<"zstd" | "gzip" | "lzo" | "0">("zstd");
  const [comment, setComment] = useState("Nightly fleet protection");

  return (
    <Modal
      title="New backup schedule"
      subtitle="Creates a Proxmox cluster backup job (visible in the PVE UI, runs without Nexus)."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !storage || !schedule}
            onClick={() =>
              onSubmit({
                node,
                vmid: scope === "all" ? undefined : Number(scope),
                storage,
                schedule,
                mode,
                compress,
                enabled: true,
                comment,
              })
            }
          >
            {busy ? "Saving…" : "Create schedule"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span>Schedule</span>
          <input value={schedule} onChange={(event) => setSchedule(event.target.value)} placeholder="02:30" />
          <div className="preset-row">
            {SCHEDULE_PRESETS.map((preset) => (
              <button key={preset} className="pill tiny" onClick={() => setSchedule(preset)} type="button">
                {preset}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>Target storage</span>
          <select value={storage} onChange={(event) => setStorage(event.target.value)}>
            {storages.map(([name, type]) => (
              <option key={name} value={name}>
                {name} ({type})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Scope</span>
          <select value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="all">All guests in the cluster</option>
            {vms.map((vm) => (
              <option key={vm.vmid} value={vm.vmid}>
                {vm.vmid} · {vm.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Node for single-guest jobs</span>
          <select value={node} onChange={(event) => setNode(event.target.value)}>
            {nodes.map((entry) => (
              <option key={entry.node} value={entry.node}>
                {entry.node}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Mode</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
            <option value="snapshot">snapshot</option>
            <option value="suspend">suspend</option>
            <option value="stop">stop</option>
          </select>
        </label>
        <label className="field">
          <span>Compression</span>
          <select value={compress} onChange={(event) => setCompress(event.target.value as typeof compress)}>
            <option value="zstd">zstd</option>
            <option value="gzip">gzip</option>
            <option value="lzo">lzo</option>
            <option value="0">none</option>
          </select>
        </label>
        <label className="field wide">
          <span>Comment</span>
          <input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={80} />
        </label>
      </div>
      <p className="hint">
        Schedule syntax is systemd calendar time: <code>02:30</code> daily, <code>sat 03:00</code> weekly,{" "}
        <code>*/6:00</code> every six hours.
      </p>
    </Modal>
  );
}

function RestoreModal({
  archive,
  vms,
  storages,
  busy,
  onClose,
  onSubmit,
}: {
  archive: BackupArchive;
  vms: VmSummary[];
  storages: [string, string][];
  busy: boolean;
  onClose: () => void;
  onSubmit: (req: RestoreRequest) => Promise<void>;
}) {
  const [vmid, setVmid] = useState(String(archive.vmid ?? 200));
  const [overwrite, setOverwrite] = useState(false);
  const [start, setStart] = useState(true);
  const [storage, setStorage] = useState(storages[0]?.[0] ?? "");
  const type = archive.volid.includes("vzdump-lxc") ? "lxc" : "qemu";
  const existing = vms.find((vm) => vm.vmid === Number(vmid));

  return (
    <Modal
      title="Restore archive"
      subtitle={archive.volid.split("/").pop()}
      onClose={onClose}
      width={600}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={cx("btn", overwrite ? "danger" : "primary")}
            disabled={busy || !vmid}
            onClick={() =>
              onSubmit({
                node: archive.node ?? "",
                vmid: Number(vmid),
                archive: archive.volid,
                type,
                storage,
                overwrite,
                start,
              })
            }
          >
            {busy ? "Starting…" : overwrite ? "Overwrite and restore" : "Restore"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span>Target VMID</span>
          <input value={vmid} onChange={(event) => setVmid(event.target.value.replace(/\D/g, ""))} />
          {existing ? <em className="warn-text small">VMID {existing.vmid} already exists ({existing.name}).</em> : null}
        </label>
        <label className="field">
          <span>Restore storage</span>
          <select value={storage} onChange={(event) => setStorage(event.target.value)}>
            {storages.map(([name, kind]) => (
              <option key={name} value={name}>
                {name} ({kind})
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />
        <span>Overwrite the existing guest at this VMID (irreversible)</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={start} onChange={(event) => setStart(event.target.checked)} />
        <span>Start the guest after restore (containers only)</span>
      </label>
      <p className="hint">
        <Icon name="alert" size={12} /> Restores run as a Proxmox task. Watch progress in the task console before assuming success.
      </p>
    </Modal>
  );
}
