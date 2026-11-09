import type {
  TeamSyncMachine,
  TeamSyncMachineTombstone,
  TeamSyncSnapshot,
  TeamSyncUser,
  TeamSyncUserTombstone,
} from "../../shared/team-sync";

function newest<T extends { updatedAt: number }>(left: T | undefined, right: T | undefined): T | undefined {
  if (!left) return right;
  if (!right) return left;
  return right.updatedAt > left.updatedAt ? right : left;
}

function mergeMachineTombstones(
  local: TeamSyncMachineTombstone[],
  remote: TeamSyncMachineTombstone[],
): TeamSyncMachineTombstone[] {
  const tombstones = new Map<string, number>();
  for (const tombstone of [...local, ...remote]) {
    const key = tombstone.key.trim().toLowerCase();
    if (!key) continue;
    tombstones.set(key, Math.max(tombstones.get(key) ?? 0, tombstone.deletedAt));
  }
  return [...tombstones.entries()]
    .map(([key, deletedAt]) => ({ key, deletedAt }))
    .sort((left, right) => right.deletedAt - left.deletedAt);
}

function mergeUsers(local: TeamSyncUser[], remote: TeamSyncUser[]): TeamSyncUser[] {
  const users = new Map<string, TeamSyncUser>();
  for (const user of [...local, ...remote]) {
    const key = user.username.trim().toLowerCase();
    if (!key) continue;
    const previous = users.get(key);
    if (!previous || user.updatedAt > previous.updatedAt) users.set(key, user);
  }
  return [...users.values()].sort((left, right) => left.username.localeCompare(right.username));
}

function mergeMachines(local: TeamSyncMachine[], remote: TeamSyncMachine[]): TeamSyncMachine[] {
  const machines = new Map<string, TeamSyncMachine>();
  for (const machine of [...local, ...remote]) {
    const key = machine.key.trim().toLowerCase();
    if (!key) continue;
    const previous = machines.get(key);
    if (!previous) {
      machines.set(key, machine);
      continue;
    }
    const base = newest(previous, machine) ?? previous;
    const links = machine.linksUpdatedAt > previous.linksUpdatedAt ? machine : previous;
    machines.set(key, {
      ...base,
      linkedUsernames: [...new Set(links.linkedUsernames)].sort(),
      linksUpdatedAt: links.linksUpdatedAt,
    });
  }
  return [...machines.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function mergeTombstones(local: TeamSyncUserTombstone[], remote: TeamSyncUserTombstone[]): TeamSyncUserTombstone[] {
  const tombstones = new Map<string, number>();
  for (const tombstone of [...local, ...remote]) {
    const key = tombstone.username.trim().toLowerCase();
    if (!key) continue;
    tombstones.set(key, Math.max(tombstones.get(key) ?? 0, tombstone.deletedAt));
  }
  return [...tombstones.entries()]
    .map(([username, deletedAt]) => ({ username, deletedAt }))
    .sort((left, right) => right.deletedAt - left.deletedAt);
}

export function mergeTeamSnapshots(local: TeamSyncSnapshot, remote: TeamSyncSnapshot): TeamSyncSnapshot {
  if (local.version !== 1 || remote.version !== 1) throw new Error("Unsupported team sync snapshot version.");
  const tombstones = mergeTombstones(local.userTombstones ?? [], remote.userTombstones ?? []);
  const deleted = new Map(tombstones.map((entry) => [entry.username.toLowerCase(), entry.deletedAt]));
  const machineTombstones = mergeMachineTombstones(local.machineTombstones ?? [], remote.machineTombstones ?? []);
  const deletedMachines = new Map(machineTombstones.map((entry) => [entry.key.toLowerCase(), entry.deletedAt]));
  const users = mergeUsers(local.users ?? [], remote.users ?? []).filter(
    (user) => (deleted.get(user.username.toLowerCase()) ?? 0) < user.updatedAt,
  );
  const activity = new Map<string, TeamSyncSnapshot["activity"][number]>();
  for (const entry of [...(local.activity ?? []), ...(remote.activity ?? [])]) {
    if (!entry?.id) continue;
    if (!activity.has(entry.id)) activity.set(entry.id, entry);
  }
  const workspace =
    remote.workspaceUpdatedAt > local.workspaceUpdatedAt
      ? { workspaceName: remote.workspaceName, workspaceUpdatedAt: remote.workspaceUpdatedAt }
      : { workspaceName: local.workspaceName, workspaceUpdatedAt: local.workspaceUpdatedAt };
  return {
    version: 1,
    workspaceName: workspace.workspaceName,
    workspaceUpdatedAt: workspace.workspaceUpdatedAt,
    users,
    machines: mergeMachines(local.machines ?? [], remote.machines ?? []).filter(
      (machine) => (deletedMachines.get(machine.key.toLowerCase()) ?? 0) < machine.updatedAt,
    ),
    activity: [...activity.values()].sort((left, right) => right.at - left.at).slice(0, 1_000),
    userTombstones: tombstones,
    machineTombstones,
  };
}

export function snapshotCounts(snapshot: TeamSyncSnapshot): { users: number; machines: number; activity: number } {
  return {
    users: snapshot.users.length,
    machines: snapshot.machines.length,
    activity: snapshot.activity.length,
  };
}

export function snapshotsEqual(left: TeamSyncSnapshot, right: TeamSyncSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
