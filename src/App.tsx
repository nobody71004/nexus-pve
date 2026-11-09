import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  AppInfo,
  BackupArchive,
  BackupRunRequest,
  FleetSnapshot,
  HostInput,
  HostRuntimeStatus,
  HostSummary,
  HostTestResult,
  McpStatus,
  PipelineDef,
  PipelineRun,
  RestoreRequest,
  ScheduleInput,
  SshHostSummary,
  SshRuntimeStatus,
  SshSnapshot,
  TeamAuthState,
  TeamUser,
  VmAction,
  VmSummary,
} from "../shared/types";
import { AuthScreen } from "./components/AuthScreen";
import { Backdrop } from "./components/Backdrop";
import { BackupStudio } from "./components/BackupStudio";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { ConnectPanel } from "./components/ConnectPanel";
import { HelperReadiness } from "./components/HelperReadiness";
import { Icon, type IconName } from "./components/Icon";
import { LinuxHosts } from "./components/LinuxHosts";
import { NodeCard } from "./components/NodeCard";
import { SshServerCard } from "./components/SshServerCard";
import { PipelineStudio } from "./components/PipelineStudio";
import { RelayFabric } from "./components/RelayFabric";
import { TitleBar } from "./components/TitleBar";
import { Modal, Panel, Skeleton, StatTile, StatusDot, Toasts, type ToastItem } from "./components/ui";
import { SecurityWorkspace } from "./components/SecurityWorkspace";
import { TeamPanel } from "./components/TeamPanel";
import { Throughput } from "./components/Throughput";
import { VmDrawer } from "./components/VmDrawer";
import { VmTable } from "./components/VmTable";
import { bridge, isMockBridge } from "./lib/bridge";
import { ago, bytes, clock, cx, pct } from "./lib/format";
import { helperAlertBreakdown, helperAlertCount, helperFleet, refreshHelpers, subscribeHelpers } from "./lib/helperFleet";

type Tab = "overview" | "hosts" | "network" | "security" | "fabric" | "backups" | "pipelines" | "connections" | "team";

const NAV: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: "overview", label: "Fleet overview", icon: "grid" },
  { id: "hosts", label: "Linux hosts", icon: "terminal" },
  { id: "network", label: "Network", icon: "activity" },
  { id: "security", label: "Security guard", icon: "shield" },
  { id: "fabric", label: "Relay fabric", icon: "plug" },
  { id: "backups", label: "Backup studio", icon: "shield" },
  { id: "pipelines", label: "Agent pipelines", icon: "agent" },
  { id: "connections", label: "Connections", icon: "plug" },
  { id: "team", label: "Team access", icon: "users" },
];

const DESTRUCTIVE: VmAction[] = ["stop", "reset", "reboot", "shutdown"];

interface ConfirmState {
  title: string;
  body: string;
  detail?: string;
  danger: boolean;
  label: string;
  run: () => Promise<void>;
}

export function App() {
  const [auth, setAuth] = useState<TeamAuthState | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const refreshAuth = useCallback(async () => {
    try {
      setAuth(await bridge.auth.status());
    } catch (err) {
      setBootError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let live = true;
    void bridge.auth
      .status()
      .then((state) => {
        if (live) setAuth(state);
      })
      .catch((err) => {
        if (live) setBootError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    return bridge.onEvent((event) => {
      if (event.type === "team-sync") void refreshAuth();
    });
  }, [refreshAuth]);

  if (bootError) {
    return (
      <div className="app auth-boot">
        <Backdrop reduced={false} />
        <section className="auth-boot-card" role="alert">
          <span className="auth-glyph">
            <Icon name="alert" size={24} />
          </span>
          <span className="eyebrow">WORKSPACE UNAVAILABLE</span>
          <h1>Nexus could not open the team workspace.</h1>
          <p>{bootError}</p>
          <button className="btn primary" onClick={() => window.location.reload()}>
            <Icon name="refresh" size={13} /> Try again
          </button>
        </section>
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="app auth-boot">
        <Backdrop reduced={false} />
        <div className="auth-boot-mark">
          <span className="brand-mark live">
            <i />
            <i />
            <i />
          </span>
          <span className="eyebrow">LOADING TEAM WORKSPACE</span>
        </div>
      </div>
    );
  }

  if (!auth.user) {
    return (
      <AuthScreen
        initialized={auth.initialized}
        onAuthenticated={(user) => {
          setAuth({ initialized: true, user, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
          void refreshAuth();
        }}
        onWorkspaceChanged={() => void refreshAuth()}
      />
    );
  }

  return (
    <Workspace
      currentUser={auth.user}
      sessionExpiresAt={auth.expiresAt}
      onUserChange={(user) => setAuth((current) => ({ initialized: true, user, expiresAt: current?.expiresAt ?? Date.now() + 12 * 60 * 60 * 1000 }))}
      onLogout={async () => {
        try {
          await bridge.auth.logout();
        } finally {
          setAuth({ initialized: true, user: null, expiresAt: 0 });
        }
      }}
    />
  );
}

function Workspace({
  currentUser,
  sessionExpiresAt,
  onUserChange,
  onLogout,
}: {
  currentUser: TeamUser;
  sessionExpiresAt: number | null;
  onUserChange: (user: TeamUser) => void;
  onLogout: () => Promise<void>;
}) {
  const [hosts, setHosts] = useState<HostSummary[]>([]);
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [fleetSnapshots, setFleetSnapshots] = useState<Record<string, FleetSnapshot>>({});
  const [statuses, setStatuses] = useState<Record<string, HostRuntimeStatus>>({});
  const [sshHosts, setSshHosts] = useState<SshHostSummary[]>([]);
  const [sshSnapshots, setSshSnapshots] = useState<Record<string, SshSnapshot>>({});
  const [sshStatuses, setSshStatuses] = useState<Record<string, SshRuntimeStatus>>({});
  const [sshFleetError, setSshFleetError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(sessionExpiresAt);
  const [clockNow, setClockNow] = useState(Date.now());
  const [tab, setTab] = useState<Tab>(currentUser.role === "user" ? "hosts" : "overview");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [motion, setMotion] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerVm, setDrawerVm] = useState<VmSummary | null>(null);
  const [drawerNonce, setDrawerNonce] = useState(0);
  const [busyVm, setBusyVm] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [logModal, setLogModal] = useState<{ title: string; lines: string[]; loading: boolean } | null>(null);
  const [archives, setArchives] = useState<BackupArchive[]>([]);
  const [pipelines, setPipelines] = useState<PipelineDef[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [activeRun, setActiveRun] = useState<PipelineRun | null>(null);
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [snapTarget, setSnapTarget] = useState<VmSummary | null>(null);
  const [snapName, setSnapName] = useState("nexus-checkpoint");
  const [snapDescription, setSnapDescription] = useState("Created from Nexus PVE");
  const [archiveBusy, setArchiveBusy] = useState(false);
  const toastTimers = useRef<number[]>([]);
  const sshInflight = useRef(false);

  const notify = useCallback((level: ToastItem["level"], title: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current.slice(-4), { id, level, title, detail }]);
    const timer = window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, level === "error" ? 9000 : 5200);
    toastTimers.current.push(timer);
  }, []);

  useEffect(() => {
    setExpiresAt(sessionExpiresAt);
  }, [sessionExpiresAt]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const extendSession = useCallback(async () => {
    try {
      const state = await bridge.auth.refreshSession();
      setExpiresAt(state.expiresAt);
      setClockNow(Date.now());
      notify("ok", "Session extended", "This computer stays signed in for another 12 hours.");
    } catch (err) {
      notify("error", "Could not extend session", err instanceof Error ? err.message : String(err));
    }
  }, [notify]);

  useEffect(() => {
    return () => toastTimers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  /* ------------------------------------------------------------- bootstrap */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [hostList, appInfo, pipelineList, mcpStatus] = await Promise.all([
          bridge.hosts.list(),
          bridge.app.info(),
          bridge.pipelines.list(),
          bridge.mcp.status(),
        ]);
        if (cancelled) return;
        setHosts(hostList);
        setInfo(appInfo);
        setPipelines(pipelineList);
        setMcp(mcpStatus);
        const stored = localStorage.getItem("nexus.activeHost");
        const preferred = hostList.find((host) => host.id === stored) ?? hostList[0];
        setActiveHostId(preferred?.id ?? null);
        const motionPref = localStorage.getItem("nexus.motion");
        if (motionPref === "off" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) setMotion(false);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeHost = useMemo(() => hosts.find((host) => host.id === activeHostId) ?? null, [hosts, activeHostId]);
  const visibleNav = useMemo(
    () =>
      currentUser.role === "user"
        ? NAV.filter((item) => item.id === "hosts" || item.id === "network" || item.id === "team")
        : NAV,
    [currentUser.role],
  );

  // The rail badge is fleet-wide, so it is checked even while the user is on a
  // Proxmox tab. A five-minute refresh is cheap (one command per Linux host),
  // and installs/checks inside the app push their result immediately.
  const helperState = useSyncExternalStore(subscribeHelpers, helperFleet);
  const helperAlerts = helperAlertCount(helperState);
  const helperBreakdown = helperAlertBreakdown(helperState);
  useEffect(() => {
    void refreshHelpers({ force: true });
    const timer = window.setInterval(() => void refreshHelpers(), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = useCallback(
    async (hostId: string | null = activeHostId, silent = false) => {
      if (!hostId) return;
      if (!silent) setLoading(true);
      try {
        const next = await bridge.pve.snapshot(hostId);
        setFleetSnapshots((current) => ({ ...current, [hostId]: next }));
        if (hostId === activeHostId) setSnapshot(next);
        setStatuses((current) => ({ ...current, [hostId]: next.status }));
        setError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatuses((current) => ({
          ...current,
          [hostId]: { id: hostId, health: "offline", error: message, checkedAt: Date.now() },
        }));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [activeHostId],
  );

  const refreshFleet = useCallback(
    async (silent = false) => {
      if (hosts.length === 0) {
        setSnapshot(null);
        setFleetSnapshots({});
        setError(null);
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const results = await Promise.allSettled(
          hosts.map(async (host) => ({ host, next: await bridge.pve.snapshot(host.id) })),
        );
        const nextSnapshots: Record<string, FleetSnapshot> = {};
        const nextStatuses: Record<string, HostRuntimeStatus> = {};
        let activeFailure: string | null = null;

        results.forEach((result, index) => {
          const host = hosts[index];
          if (result.status === "fulfilled") {
            nextSnapshots[host.id] = result.value.next;
            nextStatuses[host.id] = result.value.next.status;
            return;
          }
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          nextStatuses[host.id] = { id: host.id, health: "offline", error: message, checkedAt: Date.now() };
          if (host.id === activeHostId) activeFailure = message;
        });

        setFleetSnapshots((current) => ({ ...current, ...nextSnapshots }));
        setStatuses((current) => ({ ...current, ...nextStatuses }));

        const activeSnapshot = activeHostId ? nextSnapshots[activeHostId] : undefined;
        if (activeSnapshot) {
          setSnapshot(activeSnapshot);
          setError(null);
        } else if (activeFailure) {
          setError(activeFailure);
        } else if (!activeHostId) {
          setError("No endpoint selected");
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [hosts, activeHostId],
  );

  // The deck is the whole fleet, not only Proxmox. Sample every configured
  // Linux server over SSH so VPS and edge boxes are not invisible here.
  const refreshSshFleet = useCallback(async () => {
    if (sshInflight.current) return;
    sshInflight.current = true;
    try {
      const list = await bridge.ssh.hosts();
      setSshHosts(list);
      setSshFleetError(null);
      if (list.length === 0) {
        setSshStatuses({});
        setSshSnapshots({});
        return;
      }
      const [health, results] = await Promise.all([
        bridge.ssh.health().catch(() => []),
        Promise.allSettled(
          list.map(async (host) => ({ host, next: await bridge.ssh.snapshot(host.id) })),
        ),
      ]);
      const statuses: Record<string, SshRuntimeStatus> = {};
      for (const item of health) statuses[item.id] = { ...item, checkedAt: Date.now() };
      const snapshots: Record<string, SshSnapshot> = {};
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const { host, next } = result.value;
        snapshots[host.id] = next;
        statuses[host.id] = next.status;
      }
      setSshSnapshots((current) => ({ ...current, ...snapshots }));
      setSshStatuses((current) => ({ ...current, ...statuses }));
    } catch (err) {
      setSshFleetError(err instanceof Error ? err.message : String(err));
    } finally {
      sshInflight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!activeHostId) return;
    localStorage.setItem("nexus.activeHost", activeHostId);
    setSnapshot(null);
    setArchives([]);
    void refreshFleet(false);
    const timer = window.setInterval(() => void refreshFleet(true), 8000);
    void bridge.backups
      .archives(activeHostId)
      .then(setArchives)
      .catch(() => setArchives([]));
    return () => window.clearInterval(timer);
  }, [activeHostId, refreshFleet]);

  // The SSH half is refreshed only while the deck is visible; the Linux hosts
  // tab runs its own probe with its own poll timer.
  useEffect(() => {
    if (tab !== "overview") return;
    void refreshSshFleet();
    const timer = window.setInterval(() => void refreshSshFleet(), 20_000);
    return () => window.clearInterval(timer);
  }, [tab, refreshSshFleet]);

  useEffect(() => {
    if (tab !== "pipelines") return;
    void bridge.pipelines.runs().then(setRuns);
    void bridge.mcp.status().then(setMcp);
  }, [tab]);

  useEffect(() => {
    const unsubscribe = bridge.onEvent((event) => {
      if (event.type === "pipeline" && event.run) {
        const incoming = event.run;
        setActiveRun((current) => (current && current.id === incoming.id ? incoming : current));
        setRuns((current) => [incoming, ...current.filter((run) => run.id !== incoming.id)].slice(0, 20));
        if (incoming.status === "waiting-approval" && incoming.approval) {
          notify("warn", "Pipeline needs approval", `${incoming.name}: ${incoming.approval.title}`);
        }
      }
      if (event.type === "toast" && event.message) {
        notify(event.level ?? "info", event.message);
      }
    });
    return unsubscribe;
  }, [notify]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const target = (event.target as Element | null)?.closest?.("[data-spot]") as HTMLElement | null;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      target.style.setProperty("--mx", `${event.clientX - rect.left}px`);
      target.style.setProperty("--my", `${event.clientY - rect.top}px`);
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => document.removeEventListener("pointermove", onMove);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* --------------------------------------------------------------- actions */

  const performVmAction = useCallback(
    async (vm: VmSummary, action: VmAction) => {
      if (!activeHostId) return;
      setBusyVm(vm.key);
      try {
        const result = await bridge.pve.vmAction(activeHostId, vm.node, vm.type, vm.vmid, action);
        notify("ok", `${vm.name}: ${action} requested`, result.upid ? result.upid.slice(0, 52) : undefined);
        await refresh(activeHostId, true);
        setDrawerNonce((value) => value + 1);
      } catch (err) {
        notify("error", `${action} failed for ${vm.name}`, err instanceof Error ? err.message : String(err));
      } finally {
        setBusyVm(null);
      }
    },
    [activeHostId, notify, refresh],
  );

  const requestVmAction = useCallback(
    (vm: VmSummary, action: VmAction) => {
      if (!DESTRUCTIVE.includes(action)) {
        void performVmAction(vm, action);
        return;
      }
      setConfirmState({
        title: `${action === "shutdown" ? "Shut down" : action === "stop" ? "Force stop" : action} ${vm.name}?`,
        body:
          action === "stop"
            ? "A force stop kills the guest immediately, like pulling the power cord. Unsaved state is lost."
            : action === "shutdown"
              ? "Proxmox asks the guest to power off cleanly and returns a task id; the guest may take a moment."
              : action === "reboot"
                ? "The guest is rebooted through ACPI. Services will restart."
                : "The guest is reset without an orderly shutdown.",
        detail: `${vm.type === "lxc" ? "CT" : "VM"} ${vm.vmid} · ${vm.node} · ${vm.status}`,
        danger: action === "stop" || action === "reset",
        label: action === "shutdown" ? "Shut down" : action === "stop" ? "Force stop" : action,
        run: () => performVmAction(vm, action),
      });
    },
    [performVmAction],
  );

  const openLog = useCallback(
    async (node: string, upid: string) => {
      if (!activeHostId) return;
      setLogModal({ title: `${node} · ${upid.split(":")[5] ?? "task"}`, lines: [], loading: true });
      try {
        const lines = await bridge.pve.taskLog(activeHostId, node, upid);
        setLogModal({ title: `${node} · ${upid.split(":")[5] ?? "task"}`, lines, loading: false });
      } catch (err) {
        setLogModal({
          title: "Task log",
          lines: [`failed to read log: ${err instanceof Error ? err.message : String(err)}`],
          loading: false,
        });
      }
    },
    [activeHostId],
  );

  const createSnapshot = useCallback(async () => {
    if (!activeHostId || !snapTarget) return;
    try {
      await bridge.pve.snapshotCreate(activeHostId, snapTarget.node, snapTarget.type, snapTarget.vmid, snapName.trim(), snapDescription.trim());
      notify("ok", "Snapshot requested", `${snapName} on ${snapTarget.name}`);
      setSnapTarget(null);
      setDrawerNonce((value) => value + 1);
    } catch (err) {
      notify("error", "Snapshot failed", err instanceof Error ? err.message : String(err));
    }
  }, [activeHostId, snapTarget, snapName, snapDescription, notify]);

  const rollbackSnapshot = useCallback(
    (vm: VmSummary, name: string) => {
      if (!activeHostId) return;
      setConfirmState({
        title: `Roll back ${vm.name} to “${name}”?`,
        body: "Everything written since the snapshot is discarded. The guest is restored to the exact captured state.",
        detail: `VM ${vm.vmid} · snapshot ${name}`,
        danger: true,
        label: "Roll back",
        run: async () => {
          await bridge.pve.snapshotRollback(activeHostId, vm.node, vm.type, vm.vmid, name);
          setDrawerNonce((value) => value + 1);
          notify("ok", "Rollback requested", `${vm.name} → ${name}`);
        },
      });
    },
    [activeHostId, notify],
  );

  const deleteSnapshot = useCallback(
    (vm: VmSummary, name: string) => {
      if (!activeHostId) return;
      setConfirmState({
        title: `Delete snapshot “${name}”?`,
        body: "The snapshot is removed and cannot be recovered. The current guest state is untouched.",
        detail: `VM ${vm.vmid}`,
        danger: true,
        label: "Delete snapshot",
        run: async () => {
          await bridge.pve.snapshotDelete(activeHostId, vm.node, vm.type, vm.vmid, name);
          setDrawerNonce((value) => value + 1);
          notify("ok", "Snapshot deleted", `${vm.name} · ${name}`);
        },
      });
    },
    [activeHostId, notify],
  );

  const quickBackup = useCallback(
    async (vm: VmSummary) => {
      if (!activeHostId) return;
      const storage =
        snapshot?.nodes.find((node) => node.node === vm.node)?.storages.find((entry) => entry.content.includes("backup"))?.storage ??
        "local";
      try {
        const result = await bridge.backups.run(activeHostId, {
          node: vm.node,
          vmid: vm.vmid,
          storage,
          mode: "snapshot",
          compress: "zstd",
          notes: `Nexus PVE manual backup of ${vm.name}`,
        });
        notify("ok", "Backup started", `${vm.name} → ${storage}${result.upid ? ` · ${result.upid.slice(0, 40)}` : ""}`);
      } catch (err) {
        notify("error", "Backup failed to start", err instanceof Error ? err.message : String(err));
      }
    },
    [activeHostId, snapshot, notify],
  );

  /* --------------------------------------------------------------- backups */

  const reloadArchives = useCallback(async () => {
    if (!activeHostId) return;
    try {
      setArchives(await bridge.backups.archives(activeHostId));
    } catch (err) {
      notify("error", "Could not read backup storages", err instanceof Error ? err.message : String(err));
    }
  }, [activeHostId, notify]);

  const runBackup = useCallback(
    async (request: BackupRunRequest) => {
      if (!activeHostId) return;
      try {
        const result = await bridge.backups.run(activeHostId, request);
        notify("ok", "Backup started", result.upid ? result.upid.slice(0, 52) : undefined);
        await reloadArchives();
        await refresh(activeHostId, true);
      } catch (err) {
        notify("error", "Backup failed to start", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [activeHostId, notify, reloadArchives, refresh],
  );

  const restoreArchive = useCallback(
    async (request: RestoreRequest) => {
      if (!activeHostId) return;
      try {
        const result = await bridge.backups.restore(activeHostId, request);
        notify("ok", "Restore task started", result.upid ? result.upid.slice(0, 52) : `VMID ${request.vmid}`);
        await refresh(activeHostId, true);
      } catch (err) {
        notify("error", "Restore failed", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [activeHostId, notify, refresh],
  );

  const deleteArchive = useCallback(
    (archive: BackupArchive) => {
      if (!activeHostId) return;
      setConfirmState({
        title: "Delete this backup archive?",
        body: "The vzdump file is removed from storage. This cannot be undone and no other copy is assumed.",
        detail: archive.volid,
        danger: true,
        label: "Delete archive",
        run: async () => {
          setArchiveBusy(true);
          try {
            await bridge.backups.removeArchive(activeHostId, archive.node ?? "", archive.storage, archive.volid);
            await reloadArchives();
            notify("ok", "Archive deleted", archive.volid.split("/").pop());
          } finally {
            setArchiveBusy(false);
          }
        },
      });
    },
    [activeHostId, notify, reloadArchives],
  );

  const saveSchedule = useCallback(
    async (input: ScheduleInput) => {
      if (!activeHostId) return;
      try {
        await bridge.backups.saveSchedule(activeHostId, input);
        notify("ok", "Schedule saved", `${input.schedule} → ${input.storage}`);
        await refresh(activeHostId, true);
      } catch (err) {
        notify("error", "Could not save schedule", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [activeHostId, notify, refresh],
  );

  const deleteSchedule = useCallback(
    (id: string) => {
      if (!activeHostId) return;
      setConfirmState({
        title: "Delete backup schedule?",
        body: "Scheduled protection stops for this job. Existing archives are kept.",
        detail: `job id ${id}`,
        danger: true,
        label: "Delete schedule",
        run: async () => {
          await bridge.backups.deleteSchedule(activeHostId, id);
          await refresh(activeHostId, true);
          notify("ok", "Schedule deleted");
        },
      });
    },
    [activeHostId, notify, refresh],
  );

  const toggleSchedule = useCallback(
    async (job: { id: string; enabled: boolean; schedule: string; storage: string; mode: string; compress: string; node?: string; vmid?: string; comment?: string }) => {
      if (!activeHostId) return;
      try {
        await bridge.backups.saveSchedule(activeHostId, {
          id: job.id,
          node: job.node ?? snapshot?.nodes[0]?.node ?? "",
          vmid: job.vmid ? Number(job.vmid.split(",")[0]) : undefined,
          storage: job.storage,
          schedule: job.schedule,
          mode: job.mode as ScheduleInput["mode"],
          compress: job.compress as ScheduleInput["compress"],
          enabled: !job.enabled,
          comment: job.comment,
        });
        await refresh(activeHostId, true);
        notify("ok", job.enabled ? "Schedule paused" : "Schedule enabled");
      } catch (err) {
        notify("error", "Could not update schedule", err instanceof Error ? err.message : String(err));
      }
    },
    [activeHostId, snapshot, refresh, notify],
  );

  /* ------------------------------------------------------------- pipelines */

  const startPipeline = useCallback(
    async (pipeline: PipelineDef, vars: Record<string, unknown>) => {
      if (!activeHostId) {
        notify("warn", "Add a host first");
        return;
      }
      try {
        const run = await bridge.pipelines.run(pipeline.id, activeHostId, vars);
        setActiveRun(run);
        setRuns((current) => [run, ...current.filter((entry) => entry.id !== run.id)]);
        notify("ok", `${pipeline.name} started`, `${pipeline.steps.length} steps queued`);
      } catch (err) {
        notify("error", "Pipeline failed to start", err instanceof Error ? err.message : String(err));
      }
    },
    [activeHostId, notify],
  );

  const approve = useCallback(
    async (runId: string, approved: boolean) => {
      try {
        const run = await bridge.pipelines.approve(runId, approved);
        setActiveRun(run);
      } catch (err) {
        notify("error", "Approval failed", err instanceof Error ? err.message : String(err));
      }
    },
    [notify],
  );

  const cancelRun = useCallback(
    async (runId: string) => {
      try {
        const run = await bridge.pipelines.cancel(runId);
        setActiveRun(run);
      } catch (err) {
        notify("error", "Cancel failed", err instanceof Error ? err.message : String(err));
      }
    },
    [notify],
  );

  /* ----------------------------------------------------------------- hosts */

  const saveHost = useCallback(
    async (input: HostInput) => {
      const saved = await bridge.hosts.save(input);
      const list = await bridge.hosts.list();
      setHosts(list);
      setActiveHostId(saved.id);
      notify("ok", "Host saved", saved.baseUrl);
      setTab("overview");
    },
    [notify],
  );

  const removeHost = useCallback(
    (host: HostSummary) => {
      setConfirmState({
        title: `Remove ${host.label}?`,
        body: "The connection and its encrypted credential are deleted from this machine. The Proxmox host itself is untouched.",
        detail: host.baseUrl,
        danger: true,
        label: "Remove host",
        run: async () => {
          await bridge.hosts.remove(host.id);
          const list = await bridge.hosts.list();
          setHosts(list);
          if (activeHostId === host.id) setActiveHostId(list[0]?.id ?? null);
          if (list.length === 0) setSnapshot(null);
        },
      });
    },
    [activeHostId],
  );

  const testHost = useCallback(async (input: HostInput): Promise<HostTestResult> => {
    return bridge.hosts.test(input);
  }, []);

  const writeMcp = useCallback(
    async (target: "claude" | "cursor" | "vscode") => {
      try {
        const result = await bridge.mcp.writeConfig(target);
        notify("ok", "MCP client configured", result.path);
      } catch (err) {
        notify("error", "Could not write MCP config", err instanceof Error ? err.message : String(err));
      }
    },
    [notify],
  );

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text).then(
        () => notify("ok", "Copied to clipboard"),
        () => notify("error", "Clipboard unavailable"),
      );
    },
    [notify],
  );

  const toggleMotion = useCallback(() => {
    setMotion((current) => {
      localStorage.setItem("nexus.motion", current ? "off" : "on");
      return !current;
    });
  }, []);

  /* ---------------------------------------------------------------- derived */

  const nodes = snapshot?.nodes ?? [];
  const fleetNodes = useMemo(
    () => hosts.flatMap((host) => (fleetSnapshots[host.id]?.nodes ?? []).map((node) => ({ host, node }))),
    [hosts, fleetSnapshots],
  );
  const fleetNodeStats = useMemo(() => fleetNodes.map(({ node }) => node), [fleetNodes]);
  const sshOnline = sshHosts.filter((host) => {
    const state = sshStatuses[host.id]?.health;
    return state === "online" || state === "degraded";
  }).length;
  const sshThreads = sshHosts.reduce((sum, host) => sum + (sshSnapshots[host.id]?.cpu.cores ?? 0), 0);
  const vms = snapshot?.vms ?? [];
  const tasks = snapshot?.tasks ?? [];
  const running = vms.filter((vm) => vm.status === "running").length;
  const failed = tasks.filter((task) => task.state === "error").length;
  const fleetCpu =
    fleetNodeStats.length > 0
      ? (fleetNodeStats.reduce((sum, node) => sum + node.cpu, 0) / fleetNodeStats.length) * 100
      : 0;
  const memUsed = fleetNodeStats.reduce((sum, node) => sum + node.memory.used, 0);
  const memTotal = fleetNodeStats.reduce((sum, node) => sum + node.memory.total, 0);
  const memPct = pct(memUsed, memTotal);
  const cpuSeries = useMemo(() => {
    if (fleetNodeStats.length === 0) return [0, 0];
    const length = Math.max(...fleetNodeStats.map((node) => node.rrd.length), 2);
    return Array.from({ length }, (_, index) => {
      const values = fleetNodeStats.map((node) => node.rrd[index]?.cpu ?? 0);
      return (values.reduce((sum, value) => sum + value, 0) / values.length) * 100;
    });
  }, [fleetNodeStats]);
  const netIn = fleetNodeStats.reduce((sum, node) => sum + (node.rrd.at(-1)?.netin ?? 0), 0);
  const netOut = fleetNodeStats.reduce((sum, node) => sum + (node.rrd.at(-1)?.netout ?? 0), 0);
  const fleetErrors = useMemo(() => {
    const messages = new Set<string>();
    for (const host of hosts) {
      const live = fleetSnapshots[host.id];
      for (const error of live?.errors ?? []) messages.add(`${host.label}: ${error}`);
      const status = statuses[host.id];
      if (status?.health === "offline" && status.error) messages.add(`${host.label}: ${status.error}`);
    }
    return [...messages];
  }, [hosts, fleetSnapshots, statuses]);
  const storageOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const node of nodes) for (const storage of node.storages) if (storage.content.includes("backup")) seen.add(storage.storage);
    return [...seen];
  }, [nodes]);

  const health = snapshot?.status.health ?? (hosts.length > 0 ? "connecting" : "offline");

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: "refresh", label: "Refresh fleet snapshot", hint: "Proxmox and Linux servers", icon: "refresh", group: "Fleet", run: () => { void refreshFleet(); void refreshSshFleet(); } },
      { id: "health", label: "Run fleet health sweep", hint: "pipeline · read-only", icon: "activity", group: "Fleet", run: () => {
        const pipeline = pipelines.find((entry) => entry.id === "health-sweep");
        if (pipeline) void startPipeline(pipeline, {});
        setTab("pipelines");
      } },
      ...visibleNav.map((item) => ({
        id: `nav-${item.id}`,
        label: item.label,
        hint: "go to workspace",
        icon: item.icon,
        group: "Navigate",
        run: () => setTab(item.id),
      })),
      ...hosts.map((host) => ({
        id: `host-${host.id}`,
        label: `Switch to ${host.label}`,
        hint: host.baseUrl,
        icon: "server" as IconName,
        group: "Hosts",
        run: () => setActiveHostId(host.id),
      })),
      { id: "motion", label: motion ? "Reduce motion" : "Enable motion", hint: "visual effects", icon: "zap", group: "Interface", run: toggleMotion },
      { id: "mcp", label: "Install MCP config for Claude Desktop", hint: "agent access", icon: "agent", group: "Interface", run: () => void writeMcp("claude") },
      ...(currentUser.role === "user"
        ? []
        : [{ id: "add", label: "Add a Proxmox host", hint: "new connection", icon: "plus" as IconName, group: "Hosts", run: () => setTab("connections") }]),
    ];
    return list;
  }, [currentUser.role, hosts, motion, pipelines, refreshFleet, refreshSshFleet, startPipeline, toggleMotion, visibleNav, writeMcp]);

  /* ----------------------------------------------------------------- render */

  return (
    <div className="app">
      <Backdrop reduced={!motion} />
      <TitleBar health={health} onPalette={() => setPaletteOpen(true)} motion={motion} onToggleMotion={toggleMotion} />

      <div className="shell">
        <nav className="rail">
          <div className="rail-brand">
            <span>NEXUS</span>
            <em>OPS CONSOLE</em>
          </div>
          <div className="rail-nav">
            {visibleNav.map((item) => (
              <button
                key={item.id}
                className={cx("rail-item", tab === item.id && "active")}
                onClick={() => setTab(item.id)}
                title={item.label}
                aria-label={item.label}
                aria-current={tab === item.id ? "page" : undefined}
              >
                <Icon name={item.icon} size={17} />
                <span>{item.label}</span>
                {item.id === "hosts" && helperAlerts > 0 ? (
                  <b
                    className="warn"
                    title={`${helperAlerts} host${helperAlerts === 1 ? "" : "s"} need helper attention: ${Object.entries(helperBreakdown)
                      .map(([state, count]) => `${count} ${state}`)
                      .join(" · ")}`}
                  >
                    {helperAlerts}
                  </b>
                ) : null}
                {item.id === "overview" && running > 0 ? <b>{running}</b> : null}
                {item.id === "backups" && archives.length > 0 ? <b>{archives.length}</b> : null}
                {item.id === "pipelines" && activeRun && activeRun.status !== "ok" ? <b className="warn">{activeRun.status === "waiting-approval" ? "!" : "•"}</b> : null}
              </button>
            ))}
          </div>

          {currentUser.role !== "user" ? (
          <div className="rail-hosts">
            <span className="rail-caption">ENDPOINTS</span>
            {hosts.map((host) => {
              const status = statuses[host.id];
              return (
                <button
                  key={host.id}
                  className={cx("rail-host", activeHostId === host.id && "active")}
                  onClick={() => setActiveHostId(host.id)}
                  title={host.baseUrl}
                >
                  <span className="host-color" style={{ background: host.color }} />
                  <div>
                    <strong>{host.label}</strong>
                    <span className="mono">{status?.latencyMs ? `${status.latencyMs} ms` : host.baseUrl.replace(/^https?:\/\//, "")}</span>
                  </div>
                  <StatusDot state={status?.health ?? "offline"} />
                </button>
              );
            })}
            <button className="rail-add" onClick={() => setTab("connections")}>
              <Icon name="plus" size={13} /> Add endpoint
            </button>
          </div>
          ) : null}

          <div className="rail-foot">
            <div className="rail-sync">
              <span className={cx("pulse-dot", health === "online" && "live")} />
              <div>
                <strong>{health === "online" ? "Live telemetry" : health}</strong>
                <span className="mono">{snapshot ? `synced ${ago(snapshot.fetchedAt)}` : "waiting for host"}</span>
              </div>
            </div>
            <div className="rail-user">
              <span className="avatar">{currentUser.displayName.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || currentUser.username.slice(0, 2).toUpperCase()}</span>
              <div>
                <strong>{currentUser.displayName}</strong>
                <span className="mono">@{currentUser.username} · {currentUser.role === "admin" ? "Admin" : currentUser.role === "moderator" ? "Mod" : "Member"}</span>
              </div>
              <button className="btn icon ghost" onClick={() => void onLogout()} title="Sign out">
                <Icon name="logout" size={13} />
              </button>
            </div>
            {info ? <span className="rail-version mono">v{info.version} · {isMockBridge ? "preview" : "desktop"}</span> : null}
          </div>
        </nav>

        <main className="main">
          <header className="workspace-head">
            <div className="workspace-title">
              <span className="eyebrow">{tab === "overview" ? "COMMAND DECK" : tab.toUpperCase()}</span>
              <h1>
                {tab === "overview"
                  ? "Fleet overview"
                  : tab === "hosts"
                    ? "Linux hosts"
                    : tab === "network"
                      ? "Network throughput"
                      : tab === "security"
                      ? "Security guard"
                      : tab === "fabric"
                      ? "Relay fabric"
                      : tab === "backups"
                      ? "Backup studio"
                      : tab === "pipelines"
                        ? "Agent pipelines"
                        : tab === "team"
                          ? "Team access"
                          : "Connections"}
              </h1>
              <p>
                {tab === "overview"
                  ? `Live hardware and guest control across ${hosts.length} Proxmox endpoint${hosts.length === 1 ? "" : "s"}${sshHosts.length > 0 ? ` and ${sshHosts.length} Linux server${sshHosts.length === 1 ? "" : "s"}` : ""}.`
                  : tab === "hosts"
                    ? "SSH telemetry for VPS and VM guests that have no Proxmox API."
                    : tab === "network"
                      ? "Measured download, upload and RTT per endpoint, next to the link rate the NIC negotiates."
                      : tab === "security"
                      ? "A 24/7 auditor with layered protections, plus the edge DDoS shield that fronts the game stack."
                      : tab === "fabric"
                      ? "Encrypted multi-hop relay chains: one public entry, private WireGuard hops, and a single origin."
                      : tab === "backups"
                      ? "Archives, schedules, restore and verification."
                      : tab === "pipelines"
                        ? "Multi-step agent operations with explicit human approval gates."
                        : tab === "team"
                          ? "Accounts, roles, machine grants and the workspace audit trail."
                          : "Proxmox API endpoints and credential handling."}
              </p>
            </div>

            <div className="workspace-actions">
              {activeHost ? (
                <div className="host-pill">
                  <span className="host-color" style={{ background: activeHost.color }} />
                  <div>
                    <strong>{activeHost.label}</strong>
                    <span className="mono">{activeHost.baseUrl.replace(/^https?:\/\//, "")}</span>
                  </div>
                  <StatusDot state={health} />
                </div>
              ) : null}
              <button
                className="btn icon"
                onClick={() => {
                  void refreshFleet();
                  void refreshSshFleet();
                }}
                title="Refresh Proxmox endpoints and Linux servers"
                disabled={(hosts.length === 0 && sshHosts.length === 0) || loading}
              >
                <Icon name="refresh" size={15} className={loading ? "spin" : ""} />
              </button>
              <button className="btn" onClick={() => setPaletteOpen(true)}>
                <Icon name="search" size={14} /> <span>Command</span> <kbd>⌘K</kbd>
              </button>
            </div>
          </header>

          {expiresAt !== null && expiresAt - clockNow < 10 * 60 * 1000 ? (
            <SessionBanner
              expiresAt={expiresAt}
              now={clockNow}
              onExtend={() => void extendSession()}
              onLogout={() => void onLogout()}
            />
          ) : null}

          {tab === "hosts" ? (
            <LinuxHosts onToast={notify} onOpenNetwork={() => setTab("network")} canManage={currentUser.role !== "user"} />
          ) : tab === "team" ? (
            <TeamPanel
              currentUser={currentUser}
              onCurrentUserChange={onUserChange}
              onOpenHosts={() => setTab("hosts")}
              onRefreshHosts={() => void refreshSshFleet()}
              onToast={notify}
            />
          ) : tab === "network" ? (
            <Throughput onToast={notify} />
          ) : tab === "security" ? (
            <SecurityWorkspace onToast={notify} onOpenConnections={() => setTab("connections")} />
          ) : tab === "fabric" ? (
            <RelayFabric onToast={notify} onOpenConnections={() => setTab("connections")} />
          ) : !activeHostId ? (
            <Panel eyebrow="GET STARTED" title="Connect your first Proxmox endpoint">
              <div className="hero-empty">
                <span className="hero-glyph">
                  <Icon name="server" size={26} />
                </span>
                <div>
                  <h3>No host configured</h3>
                  <p>
                    Nexus PVE talks directly to the Proxmox REST API on port 8006. Add a host with an API token — the credential is
                    encrypted on disk and never leaves the main process.
                  </p>
                  <button className="btn primary" onClick={() => setTab("connections")}>
                    <Icon name="plus" size={13} /> Set up a connection
                  </button>
                </div>
              </div>
            </Panel>
          ) : tab === "overview" ? (
            <div className="overview">
              {error ? (
                <div className="error-banner">
                  <Icon name="alert" size={16} />
                  <div>
                    <strong>Telemetry degraded</strong>
                    <span>{error}</span>
                  </div>
                  <button className="btn small ghost" onClick={() => void refreshFleet()}>
                    Retry
                  </button>
                </div>
              ) : null}
              {fleetErrors.length > 0 ? (
                <div className="warn-banner">
                  <Icon name="alert" size={14} />
                  <span>{fleetErrors.slice(0, 3).join(" · ")}</span>
                </div>
              ) : null}

              <div className="stat-strip">
                <StatTile
                  label="Proxmox nodes"
                  value={`${fleetNodeStats.filter((node) => node.status === "online").length}/${fleetNodeStats.length}`}
                  hint={`${hosts.length} endpoint${hosts.length === 1 ? "" : "s"} · ${fleetNodeStats.length} node${fleetNodeStats.length === 1 ? "" : "s"}`}
                  icon="server"
                  tone="cyan"
                />
                <StatTile
                  label="Linux servers"
                  value={`${sshOnline}/${sshHosts.length}`}
                  hint={sshHosts.length === 0 ? "none configured" : `${sshThreads} threads over SSH`}
                  icon="terminal"
                  tone={sshHosts.length === 0 ? "amber" : sshOnline === sshHosts.length ? "green" : "violet"}
                />
                <StatTile
                  label="Guests running"
                  value={running}
                  unit={`/ ${vms.length}`}
                  hint={`${activeHost?.label ?? "active endpoint"} · ${vms.filter((vm) => vm.status === "stopped").length} stopped`}
                  icon="layers"
                  tone="green"
                />
                <StatTile label="PVE CPU" value={fleetCpu.toFixed(1)} unit="%" hint={`${fleetNodeStats.reduce((sum, node) => sum + node.cores, 0)} threads on Proxmox nodes`} icon="cpu" tone={fleetCpu > 80 ? "amber" : "violet"} data={cpuSeries} />
                <StatTile label="PVE memory" value={memPct.toFixed(1)} unit="%" hint={`${bytes(memUsed)} of ${bytes(memTotal)}`} icon="database" tone={memPct > 85 ? "red" : "cyan"} />
                <StatTile
                  label="Failed tasks"
                  value={failed}
                  hint={failed > 0 ? "inspect the task stream" : "no recent failures"}
                  icon="alert"
                  tone={failed > 0 ? "red" : "green"}
                />
              </div>

              <div className="overview-grid">
                <div className="stack">
                  <Panel
                    eyebrow="HARDWARE"
                    title="Proxmox nodes"
                    actions={<span className="mono subtle">{fleetNodes.length} across {hosts.length} endpoint{hosts.length === 1 ? "" : "s"}</span>}
                  >
                    <div className="fleet-endpoints" aria-label="Configured Proxmox endpoints">
                      {hosts.map((host) => {
                        const live = fleetSnapshots[host.id];
                        const state = statuses[host.id]?.health ?? (live ? "online" : "connecting");
                        return (
                          <button
                            key={host.id}
                            type="button"
                            className={cx("fleet-endpoint", activeHostId === host.id && "active")}
                            onClick={() => setActiveHostId(host.id)}
                            title={`${host.baseUrl} · ${live ? `${live.nodes.length} node${live.nodes.length === 1 ? "" : "s"}` : "waiting for telemetry"}`}
                          >
                            <span className="host-color" style={{ background: host.color }} />
                            <strong>{host.label}</strong>
                            <em>{live ? `${live.nodes.length} node${live.nodes.length === 1 ? "" : "s"}` : "connecting"}</em>
                            <StatusDot state={state} />
                          </button>
                        );
                      })}
                    </div>
                    {fleetNodes.length === 0 ? (
                      loading ? (
                        <div className="node-grid">
                          <Skeleton height={300} />
                          <Skeleton height={300} />
                        </div>
                      ) : (
                        <p className="subtle">No node detail returned. The token needs Sys.Audit on the nodes.</p>
                      )
                    ) : (
                      <div className="node-grid">
                        {fleetNodes.map(({ host, node }) => (
                          <NodeCard key={`${host.id}:${node.node}`} node={node} endpoint={host} />
                        ))}
                      </div>
                    )}
                  </Panel>

                  <Panel
                    eyebrow="SSH FLEET"
                    title="Linux servers"
                    actions={
                      <div className="inline-actions">
                        <span className="mono subtle">
                          {sshOnline}/{sshHosts.length} online
                          {sshThreads > 0 ? ` · ${sshThreads} threads` : ""}
                        </span>
                        <button className="btn small ghost" onClick={() => setTab("hosts")}>
                          <Icon name="terminal" size={12} /> Open
                        </button>
                      </div>
                    }
                  >
                    {sshHosts.length === 0 ? (
                      <div className="empty-inline">
                        <Icon name="terminal" size={20} />
                        <div>
                          <strong>No Linux servers yet</strong>
                          <p>Add a Linux host to see its CPU, memory and disks beside the Proxmox nodes.</p>
                        </div>
                      </div>
                    ) : (
                      <div className="node-grid">
                        {sshHosts.map((host) => (
                          <SshServerCard
                            key={host.id}
                            host={host}
                            snapshot={sshSnapshots[host.id]}
                            status={sshStatuses[host.id]}
                          />
                        ))}
                      </div>
                    )}
                    {sshFleetError ? <p className="inline-error">{sshFleetError}</p> : null}
                  </Panel>

                  <Panel
                    eyebrow="INVENTORY"
                    title="Guests"
                    actions={
                      <div className="inline-actions">
                        <span className="mono subtle">{vms.length} total</span>
                      </div>
                    }
                    flush
                  >
                    <VmTable vms={vms} onSelect={setDrawerVm} onAction={requestVmAction} busy={busyVm} />
                  </Panel>
                </div>

                <div className="stack side">
                  <Panel eyebrow="TELEMETRY" title="PVE load" actions={<span className="live-tag"><i /> LIVE</span>}>
                    <div className="fleet-load">
                      <div className="fleet-load-value">
                        <strong>{fleetCpu.toFixed(1)}</strong>
                        <span>% CPU</span>
                      </div>
                      <div className="fleet-chart">
                        <div className="chart-grid" />
                        <div className="chart-fill">
                          <SparklineBig data={cpuSeries} />
                        </div>
                        <div className="chart-axis mono">
                          <span>−60 min</span>
                          <span>now</span>
                        </div>
                      </div>
                      <div className="io-row">
                        <div>
                          <span>NET IN</span>
                          <strong className="mono">{bytes(netIn)}/s</strong>
                        </div>
                        <div>
                          <span>NET OUT</span>
                          <strong className="mono">{bytes(netOut)}/s</strong>
                        </div>
                        <div>
                          <span>API</span>
                          <strong className="mono">{snapshot?.status.latencyMs ?? "—"} ms</strong>
                        </div>
                      </div>
                    </div>
                  </Panel>

                  <Panel
                    eyebrow="TASKS"
                    title="Activity stream"
                    actions={<span className="mono subtle">{tasks.filter((task) => task.state === "running").length} running</span>}
                  >
                    <div className="task-list">
                      {tasks.slice(0, 11).map((task) => (
                        <button className="task-row" key={task.upid} onClick={() => void openLog(task.node, task.upid)}>
                          <StatusDot state={task.state === "ok" ? "online" : task.state === "running" ? "running" : "offline"} />
                          <span className="mono task-type">{task.type}</span>
                          <span className="subtle small">{task.node}</span>
                          <span className="mono subtle task-time">{clock(task.starttime)}</span>
                          <span
                            className={cx(
                              "chip",
                              task.state === "ok" ? "chip-ok" : task.state === "error" ? "chip-err" : "chip-info",
                            )}
                          >
                            {task.state}
                          </span>
                        </button>
                      ))}
                      {tasks.length === 0 ? <p className="subtle small">No recent tasks.</p> : null}
                    </div>
                  </Panel>

                  <HelperReadiness onToast={notify} onOpenHosts={() => setTab("hosts")} />

                  <Panel eyebrow="COVERAGE" title="Protection" actions={<button className="btn small ghost" onClick={() => setTab("backups")}>Open studio</button>}>
                    <div className="coverage">
                      <div className="coverage-ring">
                        <strong>
                          {Math.round(
                            (vms.filter((vm) => archives.some((archive) => archive.vmid === vm.vmid && (archive.ctime ?? 0) > Date.now() - 7 * 86_400_000)).length /
                              Math.max(1, vms.length)) *
                              100,
                          )}
                          <small>%</small>
                        </strong>
                        <span>last 7 days</span>
                      </div>
                      <div className="coverage-facts">
                        <div>
                          <span>Archives</span>
                          <strong>{archives.length}</strong>
                        </div>
                        <div>
                          <span>Storage</span>
                          <strong className="mono">{bytes(archives.reduce((sum, entry) => sum + (entry.size ?? 0), 0))}</strong>
                        </div>
                        <div>
                          <span>Newest</span>
                          <strong className="mono">{archives[0]?.ctime ? ago(archives[0].ctime) : "—"}</strong>
                        </div>
                      </div>
                    </div>
                  </Panel>
                </div>
              </div>
            </div>
          ) : tab === "backups" ? (
            <BackupStudio
              vms={vms}
              nodes={nodes}
              schedules={snapshot?.schedules ?? []}
              archives={archives}
              loading={loading || archiveBusy}
              onRun={runBackup}
              onRestore={restoreArchive}
              onDeleteArchive={deleteArchive}
              onSaveSchedule={saveSchedule}
              onDeleteSchedule={deleteSchedule}
              onToggleSchedule={toggleSchedule}
              onRefresh={() => void reloadArchives()}
            />
          ) : tab === "pipelines" ? (
            <PipelineStudio
              hostLabel={activeHost?.label ?? "no host"}
              pipelines={pipelines}
              runs={runs}
              activeRun={activeRun}
              mcp={mcp}
              storageOptions={storageOptions}
              onRun={startPipeline}
              onSelectRun={setActiveRun}
              onApprove={approve}
              onCancel={cancelRun}
              onWriteMcp={writeMcp}
              onCopy={copy}
            />
          ) : (
            <ConnectPanel
              hosts={hosts}
              statuses={statuses}
              activeId={activeHostId}
              info={info}
              onSelect={(id) => {
                setActiveHostId(id);
                setTab("overview");
              }}
              onSave={saveHost}
              onRemove={removeHost}
              onTest={testHost}
              onOpenHosts={() => setTab("hosts")}
            />
          )}
        </main>
      </div>

      {paletteOpen ? <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} /> : null}

      {drawerVm && activeHostId ? (
        <VmDrawer
          key={`${drawerVm.key}-${drawerNonce}`}
          hostId={activeHostId}
          vm={drawerVm}
          archives={archives}
          onClose={() => setDrawerVm(null)}
          onAction={requestVmAction}
          onLog={(node, upid) => void openLog(node, upid)}
          onSnapshot={(vm) => {
            setSnapTarget(vm);
            setSnapName(`nexus-${new Date().toISOString().slice(0, 10)}`);
          }}
          onRollback={rollbackSnapshot}
          onDeleteSnapshot={deleteSnapshot}
          onBackup={(vm) => void quickBackup(vm)}
        />
      ) : null}

      {snapTarget ? (
        <Modal
          title="Create snapshot"
          subtitle={`${snapTarget.name} · ${snapTarget.node}`}
          onClose={() => setSnapTarget(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setSnapTarget(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={!snapName.trim()} onClick={() => void createSnapshot()}>
                Create snapshot
              </button>
            </>
          }
        >
          <div className="form-grid">
            <label className="field">
              <span>Snapshot name</span>
              <input value={snapName} onChange={(event) => setSnapName(event.target.value)} maxLength={40} />
            </label>
            <label className="field">
              <span>Description</span>
              <input value={snapDescription} onChange={(event) => setSnapDescription(event.target.value)} maxLength={80} />
            </label>
          </div>
          <p className="hint">Snapshots with memory are not requested here — this is a disk-state checkpoint.</p>
        </Modal>
      ) : null}

      {logModal ? (
        <Modal title={logModal.title} subtitle="Proxmox task log" onClose={() => setLogModal(null)} width={760}>
          <pre className="terminal">
            {logModal.loading ? "reading task log…" : logModal.lines.length > 0 ? logModal.lines.join("\n") : "no log lines returned"}
          </pre>
        </Modal>
      ) : null}

      {confirmState ? (
        <Modal
          title={confirmState.title}
          subtitle={confirmState.detail}
          onClose={() => !confirmBusy && setConfirmState(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirmState(null)} disabled={confirmBusy}>
                Cancel
              </button>
              <button
                className={cx("btn", confirmState.danger ? "danger" : "primary")}
                disabled={confirmBusy}
                onClick={async () => {
                  setConfirmBusy(true);
                  try {
                    await confirmState.run();
                    setConfirmState(null);
                  } catch (err) {
                    notify("error", "Operation failed", err instanceof Error ? err.message : String(err));
                  } finally {
                    setConfirmBusy(false);
                  }
                }}
              >
                {confirmBusy ? "Working…" : confirmState.label}
              </button>
            </>
          }
        >
          <p className="confirm-body">{confirmState.body}</p>
        </Modal>
      ) : null}

      <Toasts items={toasts} dismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
    </div>
  );
}

function SessionBanner({
  expiresAt,
  now,
  onExtend,
  onLogout,
}: {
  expiresAt: number;
  now: number;
  onExtend: () => void;
  onLogout: () => void;
}) {
  const remaining = expiresAt - now;
  const expired = remaining <= 0;
  const minutes = Math.max(0, Math.ceil(remaining / 60_000));
  return (
    <div className={cx("session-banner", expired && "expired")} role={expired ? "alert" : undefined}>
      <span className="session-banner-mark">
        <Icon name={expired ? "alert" : "lock"} size={15} />
      </span>
      <div className="session-banner-copy">
        <strong>{expired ? "Your session has expired" : `Session expires in ${minutes} minute${minutes === 1 ? "" : "s"}`}</strong>
        <span>
          {expired
            ? "Sign in again to continue. Unsaved form values are not recoverable."
            : "Extend now to keep this Nexus station signed in for another 12 hours."}
        </span>
      </div>
      {expired ? (
        <button className="btn small primary" onClick={onLogout}>
          Sign in again
        </button>
      ) : (
        <button className="btn small primary" onClick={onExtend}>
          <Icon name="refresh" size={12} /> Extend session
        </button>
      )}
    </div>
  );
}

function SparklineBig({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const width = 420;
  const height = 130;
  const min = Math.min(...data, 0);
  const max = Math.max(...data, 10);
  const span = max - min || 1;
  const step = width / (data.length - 1);
  const points = data.map((value, index) => ({
    x: index * step,
    y: height - 6 - ((value - min) / span) * (height - 16),
  }));
  let line = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const mid = (previous.x + current.x) / 2;
    line += ` Q ${mid} ${previous.y} ${current.x} ${current.y}`;
  }
  const area = `${line} L ${width} ${height} L 0 ${height} Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="big-spark">
      <defs>
        <linearGradient id="fleet-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3ef2ff" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#3ef2ff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="fleet-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#7c5cff" />
          <stop offset="60%" stopColor="#3ef2ff" />
          <stop offset="100%" stopColor="#5cffb1" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#fleet-fill)" />
      <path d={line} fill="none" stroke="url(#fleet-line)" strokeWidth="2" strokeLinecap="round" />
      <circle cx={points.at(-1)!.x} cy={points.at(-1)!.y} r="3.2" fill="#5cffb1" />
      <circle cx={points.at(-1)!.x} cy={points.at(-1)!.y} r="7" fill="none" stroke="#5cffb1" strokeOpacity="0.35" />
    </svg>
  );
}

