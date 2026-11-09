import fs from "node:fs";
import path from "node:path";
import type {
  TeamSyncConfigInput,
  TeamSyncPhase,
  TeamSyncRemoteState,
  TeamSyncRunResult,
  TeamSyncSnapshot,
  TeamSyncStatus,
} from "../../shared/team-sync";
import { nexusHome } from "../paths";
import type { TeamService } from "./store";
import { mergeTeamSnapshots, snapshotCounts, snapshotsEqual } from "./sync-merge";

const CONFIG_VERSION = 1;
const SYNC_INTERVAL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 12_000;

interface StoredSyncConfig {
  version: 1;
  endpoint: string;
  token: string;
  workspace: string;
  deviceName: string;
}

function endpoint(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The sync relay must use HTTPS (HTTP is allowed only for loopback).");
  }
  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("The sync relay must use HTTPS. Plain HTTP is only allowed for localhost testing.");
  }
  if (parsed.username || parsed.password) throw new Error("Do not put credentials in the sync relay URL.");
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function configPath(): string {
  return path.join(nexusHome(), "team-sync.json");
}

export class TeamSyncService {
  private config: StoredSyncConfig | null;
  private readonly file: string;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<TeamSyncRunResult> | null = null;
  private revision = 0;
  private phase: TeamSyncPhase = "disabled";
  private lastSyncAt: number | undefined;
  private lastAttemptAt: number | undefined;
  private error: string | undefined;

  constructor(
    private readonly team: TeamService,
    private readonly onChange: (status: TeamSyncStatus) => void,
    file = configPath(),
  ) {
    this.file = file;
    this.config = this.load();
    if (this.config) {
      this.phase = "idle";
      this.startTimer();
    }
  }

  close(): void {
    this.stopTimer();
  }

  status(): TeamSyncStatus {
    const counts = this.team.syncCounts();
    return {
      enabled: Boolean(this.config),
      phase: this.phase,
      endpoint: this.config?.endpoint,
      workspace: this.config?.workspace ?? "default",
      deviceName: this.config?.deviceName ?? "Nexus device",
      tokenSet: Boolean(this.config?.token),
      revision: this.revision,
      lastSyncAt: this.lastSyncAt,
      lastAttemptAt: this.lastAttemptAt,
      error: this.error,
      counts,
    };
  }

  async configure(input: TeamSyncConfigInput): Promise<TeamSyncRunResult> {
    const nextEndpoint = endpoint(input.endpoint ?? "");
    const token = (input.token ?? "").trim();
    if (token.length < 16) throw new Error("The sync token must be at least 16 characters.");
    if (input.workspace && !/^[a-z0-9][a-z0-9._-]{1,47}$/i.test(input.workspace)) {
      throw new Error("Workspace names use letters, numbers, dots, dashes or underscores.");
    }
    const deviceName = (input.deviceName || "Nexus device").trim().slice(0, 48);
    this.config = {
      version: CONFIG_VERSION,
      endpoint: nextEndpoint,
      token,
      workspace: (input.workspace || "default").trim(),
      deviceName: deviceName || "Nexus device",
    };
    this.revision = 0;
    this.error = undefined;
    this.phase = "idle";
    this.save();
    this.startTimer();
    this.emit();
    return this.syncNow();
  }

  async syncNow(): Promise<TeamSyncRunResult> {
    if (!this.config) throw new Error("Cross-device sync is not configured on this computer.");
    if (this.running) return this.running;
    this.running = this.runSync().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async disable(): Promise<TeamSyncStatus> {
    this.config = null;
    this.phase = "disabled";
    this.revision = 0;
    this.error = undefined;
    this.lastSyncAt = undefined;
    this.stopTimer();
    try {
      fs.unlinkSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const status = this.status();
    this.emit(status);
    return status;
  }

  private async runSync(): Promise<TeamSyncRunResult> {
    if (!this.config) throw new Error("Cross-device sync is not configured on this computer.");
    this.phase = "syncing";
    this.lastAttemptAt = Date.now();
    this.error = undefined;
    this.emit();
    try {
      let result = await this.syncAttempt();
      this.revision = result.revision;
      this.lastSyncAt = Date.now();
      this.phase = "online";
      const status = this.status();
      this.emit(status);
      return {
        status,
        pulled: result.pulled,
        pushed: result.pushed,
        changed: result.changed,
      };
    } catch (err) {
      this.phase = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.emit();
      throw err;
    }
  }

  private async syncAttempt(): Promise<{
    revision: number;
    snapshot: TeamSyncSnapshot;
    pulled: number;
    pushed: number;
    changed: boolean;
  }> {
    let lastConflict = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = this.team.syncSnapshot();
      const remote = await this.getRemote();
      const merged = remote.snapshot ? mergeTeamSnapshots(before, remote.snapshot) : before;
      const changed = !snapshotsEqual(before, merged);
      // Do not advance the relay revision every polling interval when both
      // sides already agree. The PUT is only needed to initialize an empty
      // relay or publish a real local/remote change.
      if (remote.snapshot && snapshotsEqual(merged, remote.snapshot)) {
        this.team.applySyncSnapshot(merged);
        const remoteCounts = snapshotCounts(remote.snapshot);
        return {
          revision: remote.revision,
          snapshot: merged,
          pulled: remoteCounts.users + remoteCounts.machines,
          pushed: 0,
          changed: false,
        };
      }
      const write = await this.putRemote(remote.revision, merged);
      if (write.conflict) {
        lastConflict = true;
        continue;
      }
      // A team mutation can land while the request is in flight. Fold it into
      // the revision we just wrote instead of silently clobbering it.
      const after = this.team.syncSnapshot();
      let finalSnapshot = merged;
      let revision = write.revision;
      if (!snapshotsEqual(before, after)) {
        finalSnapshot = mergeTeamSnapshots(after, merged);
        const second = await this.putRemote(revision, finalSnapshot);
        if (second.conflict) {
          lastConflict = true;
          continue;
        }
        revision = second.revision;
      }
      this.team.applySyncSnapshot(finalSnapshot);
      const remoteCounts = remote.snapshot ? snapshotCounts(remote.snapshot) : { users: 0, machines: 0, activity: 0 };
      return {
        revision,
        snapshot: finalSnapshot,
        pulled: remoteCounts.users + remoteCounts.machines,
        pushed: before.users.length + before.machines.length,
        changed,
      };
    }
    if (lastConflict) throw new Error("The sync relay kept changing. Try again in a moment.");
    throw new Error("The sync relay did not accept the workspace update.");
  }

  private async getRemote(): Promise<TeamSyncRemoteState> {
    const response = await fetch(`${this.config!.endpoint}/v1/state`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.config!.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as Partial<TeamSyncRemoteState> & { error?: string };
    if (!response.ok) throw new Error(body.error || `Sync relay returned HTTP ${response.status}.`);
    if (!body || !Number.isFinite(Number(body.revision))) throw new Error("Sync relay returned an invalid state envelope.");
    return {
      revision: Number(body.revision),
      updatedAt: Number(body.updatedAt) || 0,
      snapshot: (body.snapshot as TeamSyncSnapshot | null | undefined) ?? null,
    };
  }

  private async putRemote(
    baseRevision: number,
    snapshot: TeamSyncSnapshot,
  ): Promise<{ conflict: true } | { conflict: false; revision: number }> {
    const response = await fetch(`${this.config!.endpoint}/v1/state`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.config!.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ baseRevision, snapshot }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 409) return { conflict: true };
    const body = (await response.json().catch(() => ({}))) as { revision?: number; error?: string };
    if (!response.ok) throw new Error(body.error || `Sync relay returned HTTP ${response.status}.`);
    return { conflict: false, revision: Number(body.revision) || baseRevision + 1 };
  }

  private load(): StoredSyncConfig | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<StoredSyncConfig>;
      if (
        parsed.version !== CONFIG_VERSION ||
        typeof parsed.endpoint !== "string" ||
        typeof parsed.token !== "string" ||
        typeof parsed.workspace !== "string" ||
        typeof parsed.deviceName !== "string"
      ) {
        throw new Error("invalid config");
      }
      return {
        version: CONFIG_VERSION,
        endpoint: endpoint(parsed.endpoint),
        token: parsed.token,
        workspace: parsed.workspace,
        deviceName: parsed.deviceName,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      return null;
    }
  }

  private save(): void {
    if (!this.config) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows uses the profile ACL. */
    }
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (!this.config || this.running) return;
      void this.syncNow().catch(() => undefined);
    }, SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private emit(status = this.status()): void {
    this.onChange(status);
  }
}
