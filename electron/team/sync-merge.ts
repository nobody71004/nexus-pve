import type {
  TeamSyncBoardList,
  TeamSyncBoardTask,
  TeamSyncBoardTombstone,
  TeamSyncChatMessage,
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

function mergeChat(local: TeamSyncChatMessage[], remote: TeamSyncChatMessage[]): TeamSyncChatMessage[] {
  const messages = new Map<string, TeamSyncChatMessage>();
  for (const message of [...local, ...remote]) {
    if (!message?.id) continue;
    if (!messages.has(message.id)) messages.set(message.id, message);
  }
  return [...messages.values()].sort((left, right) => left.createdAt - right.createdAt).slice(-500);
}

function mergeBoardTombstones(
  local: TeamSyncBoardTombstone[],
  remote: TeamSyncBoardTombstone[],
): TeamSyncBoardTombstone[] {
  const tombstones = new Map<string, number>();
  for (const tombstone of [...local, ...remote]) {
    if (!tombstone?.id) continue;
    tombstones.set(tombstone.id, Math.max(tombstones.get(tombstone.id) ?? 0, Number(tombstone.deletedAt) || 0));
  }
  return [...tombstones.entries()]
    .map(([id, deletedAt]) => ({ id, deletedAt }))
    .sort((left, right) => right.deletedAt - left.deletedAt);
}

function mergeBoardLists(
  local: TeamSyncBoardList[],
  remote: TeamSyncBoardList[],
  deleted: Map<string, number>,
): TeamSyncBoardList[] {
  const lists = new Map<string, TeamSyncBoardList>();
  for (const list of [...local, ...remote]) {
    if (!list?.id) continue;
    const previous = lists.get(list.id);
    if (!previous || Number(list.updatedAt) > Number(previous.updatedAt)) lists.set(list.id, list);
  }
  return [...lists.values()]
    .filter((list) => !deleted.has(list.id))
    .sort((left, right) => left.position - right.position || left.createdAt - right.createdAt);
}

function mergeBoardTasks(
  local: TeamSyncBoardTask[],
  remote: TeamSyncBoardTask[],
  deleted: Map<string, number>,
  listIds: Set<string>,
): TeamSyncBoardTask[] {
  const tasks = new Map<string, TeamSyncBoardTask>();
  for (const task of [...local, ...remote]) {
    if (!task?.id) continue;
    const previous = tasks.get(task.id);
    if (!previous || Number(task.updatedAt) > Number(previous.updatedAt)) tasks.set(task.id, task);
  }
  return [...tasks.values()]
    .filter((task) => !deleted.has(task.id) && listIds.has(task.listId))
    .sort((left, right) => left.createdAt - right.createdAt);
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
  const boardListTombstones = mergeBoardTombstones(
    local.boardListTombstones ?? [],
    remote.boardListTombstones ?? [],
  );
  const boardTaskTombstones = mergeBoardTombstones(
    local.boardTaskTombstones ?? [],
    remote.boardTaskTombstones ?? [],
  );
  const deletedLists = new Map(boardListTombstones.map((entry) => [entry.id, entry.deletedAt]));
  const deletedTasks = new Map(boardTaskTombstones.map((entry) => [entry.id, entry.deletedAt]));
  const boardLists = mergeBoardLists(local.boardLists ?? [], remote.boardLists ?? [], deletedLists);
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
    chat: mergeChat(local.chat ?? [], remote.chat ?? []),
    boardLists,
    boardTasks: mergeBoardTasks(
      local.boardTasks ?? [],
      remote.boardTasks ?? [],
      deletedTasks,
      new Set(boardLists.map((list) => list.id)),
    ),
    boardListTombstones,
    boardTaskTombstones,
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
