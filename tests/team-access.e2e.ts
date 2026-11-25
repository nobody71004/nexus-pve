import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import initSqlJs, { type Database as SqlDatabase } from "sql.js";
import type { TeamOverview } from "../shared/team-types";
import type { SshHostSummary } from "../shared/types";
import { TeamService } from "../electron/team/store";
import { TeamSyncService } from "../electron/team/sync";
import { loginWithFreshWorkspace } from "../electron/team/login";
import { publishTeamMutation } from "../electron/team/mutation";
import { ConfigStore } from "../electron/config";
import { SshKeyService } from "../electron/sshkeys/service";
import { revokeUnauthorizedTeamKeys } from "../electron/team/access-keys";

const PROJECT_ROOT = process.cwd();
const TOKEN = "nexus-team-access-e2e-token";
const PASSWORD = "nexus-team-access-pass";
const EDGE_HOST = "10.42.0.11";
const GPU_HOST = "10.42.0.12";
const LEGACY_EDGE_HOST = "10.42.0.21";
const LEGACY_EDITED_HOST = "10.42.0.22";
const LEGACY_REVOKED_HOST = "10.42.0.23";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sshHost(id: string, label: string, host: string): SshHostSummary {
  const now = Date.now();
  return {
    id,
    label,
    host,
    port: 22,
    username: "root",
    authMode: "key",
    hasSecret: false,
    color: "#38f2ff",
    createdAt: now,
  };
}

function userByName(overview: TeamOverview, username: string) {
  const user = overview.users.find((entry) => entry.username === username);
  if (!user) throw new Error(`Expected @${username} in the team directory.`);
  return user;
}

function machineByHost(overview: TeamOverview, host: string) {
  const machine = overview.machines.find((entry) => entry.host === host);
  if (!machine) throw new Error(`Expected ${host} in the machine directory.`);
  return machine;
}

function linkedHosts(overview: TeamOverview, userId: string): string[] {
  return overview.machines
    .filter((machine) => machine.linkedUserIds.includes(userId))
    .map((machine) => machine.host)
    .sort();
}

function machineHosts(overview: TeamOverview): string[] {
  return overview.machines.map((machine) => machine.host).sort();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port for the sync relay."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

interface RelayHandle {
  url: string;
  child: ChildProcess;
  logs: () => string;
}

async function startRelay(tempRoot: string): Promise<RelayHandle> {
  const port = await freePort();
  const logs: string[] = [];
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, "scripts", "team-sync-server.mjs")], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NEXUS_SYNC_TOKEN: TOKEN,
      NEXUS_SYNC_DATA: path.join(tempRoot, "relay", "state.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The sync relay exited before becoming ready.\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return { url, child, logs: () => logs.join("") };
    } catch {
      /* relay not listening yet */
    }
    await delay(100);
  }
  child.kill();
  throw new Error(`The sync relay did not become ready.\n${logs.join("")}`);
}

async function stopRelay(relay: RelayHandle): Promise<void> {
  if (relay.child.exitCode !== null || relay.child.signalCode !== null) return;
  const exited = once(relay.child, "exit").catch(() => undefined);
  relay.child.kill();
  await Promise.race([exited, delay(1_500)]);
  if (relay.child.exitCode === null && relay.child.signalCode === null) {
    relay.child.kill("SIGKILL");
  }
}

async function openTeam(home: string): Promise<TeamService> {
  process.env.NEXUS_PVE_HOME = home;
  return TeamService.open(PROJECT_ROOT);
}

async function openRawDatabase(file: string): Promise<SqlDatabase> {
  const wasm = fs.readFileSync(path.join(PROJECT_ROOT, "node_modules", "sql.js", "dist", "sql-wasm.wasm"));
  const wasmBinary = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer;
  const SQL = await initSqlJs({ wasmBinary });
  return new SQL.Database(fs.readFileSync(file));
}

function rawStringColumn(database: SqlDatabase, sql: string): string[] {
  const result = database.exec(sql)[0];
  return result ? result.values.map((row) => String(row[0])) : [];
}

function restoreHome(previousHome: string | undefined): void {
  if (previousHome === undefined) delete process.env.NEXUS_PVE_HOME;
  else process.env.NEXUS_PVE_HOME = previousHome;
}

test("team access survives create, grant, member sign-in, revoke and two-device sync", { timeout: 60_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-access-e2e-"));
  let relay: RelayHandle | undefined;
  let teamA: TeamService | undefined;
  let teamB: TeamService | undefined;
  let syncA: TeamSyncService | undefined;
  let syncB: TeamSyncService | undefined;

  try {
    relay = await startRelay(tempRoot);
    teamA = await openTeam(path.join(tempRoot, "device-a"));
    teamB = await openTeam(path.join(tempRoot, "device-b"));

    const ownerA = await teamA.bootstrap({
      username: "owner",
      displayName: "Morgan Lee",
      password: PASSWORD,
    });
    assert.equal(ownerA.role, "superadmin");

    teamA.syncMachines([sshHost("edge-a", "Edge relay", EDGE_HOST), sshHost("gpu-a", "GPU worker", GPU_HOST)]);
    let overviewA = teamA.overview();
    const edgeA = machineByHost(overviewA, EDGE_HOST);
    const gpuA = machineByHost(overviewA, GPU_HOST);

    overviewA = teamA.createUser({
      username: "alice",
      displayName: "Alice Rivera",
      role: "user",
      password: PASSWORD,
    });
    overviewA = teamA.createUser({
      username: "bob",
      displayName: "Bob Chen",
      role: "user",
      password: PASSWORD,
    });
    overviewA = teamA.createUser({
      username: "carol",
      displayName: "Carol Singh",
      role: "user",
      password: PASSWORD,
    });

    const aliceA = userByName(overviewA, "alice");
    const bobA = userByName(overviewA, "bob");
    const carolA = userByName(overviewA, "carol");
    assert.deepEqual(
      overviewA.users.filter((user) => user.role === "user").map((user) => user.username).sort(),
      ["alice", "bob", "carol"],
    );

    overviewA = teamA.setUserMachineLinks(aliceA.id, [edgeA.id, gpuA.id]);
    overviewA = teamA.setUserMachineLinks(bobA.id, [edgeA.id]);
    assert.deepEqual(linkedHosts(overviewA, aliceA.id), [EDGE_HOST, GPU_HOST]);
    assert.deepEqual(linkedHosts(overviewA, bobA.id), [EDGE_HOST]);
    assert.deepEqual(linkedHosts(overviewA, carolA.id), []);

    syncA = new TeamSyncService(teamA, () => undefined, path.join(tempRoot, "sync-a.json"));
    const firstSync = await syncA.configure({
      endpoint: relay.url,
      token: TOKEN,
      workspace: "team-access-e2e",
      deviceName: "device-a",
    });
    assert.equal(firstSync.status.phase, "online");
    assert.ok(firstSync.pushed >= 6, `expected the owner, three members and two machines to be pushed: ${firstSync.pushed}`);

    syncB = new TeamSyncService(teamB, () => undefined, path.join(tempRoot, "sync-b.json"));
    const pulled = await syncB.configure({
      endpoint: relay.url,
      token: TOKEN,
      workspace: "team-access-e2e",
      deviceName: "device-b",
    });
    assert.equal(pulled.status.phase, "online");
    assert.equal(pulled.status.counts.users, 4);
    assert.equal(pulled.status.counts.machines, 2);
    assert.ok(pulled.status.revision >= 1);

    const aliceB = await teamB.login({ username: "alice", password: PASSWORD });
    assert.equal(aliceB.role, "user");
    const aliceViewB = teamB.overview();
    assert.deepEqual(machineHosts(aliceViewB), [EDGE_HOST, GPU_HOST]);
    const edgeB = machineByHost(aliceViewB, EDGE_HOST);
    const gpuB = machineByHost(aliceViewB, GPU_HOST);
    assert.equal(edgeB.source, "remote");
    assert.equal(teamB.canAccessMachine(aliceB.id, edgeB.id), true);
    assert.equal(teamB.canAccessMachine(aliceB.id, gpuB.id), true);

    await teamB.logout();
    const ownerB = await teamB.login({ username: "owner", password: PASSWORD });
    assert.equal(ownerB.role, "superadmin");
    const ownerViewB = teamB.overview();
    const aliceIdB = userByName(ownerViewB, "alice").id;
    const bobIdB = userByName(ownerViewB, "bob").id;
    const edgeIdB = machineByHost(ownerViewB, EDGE_HOST).id;

    await delay(10);
    let revokedB = teamB.setUserMachineLinks(aliceIdB, [edgeIdB]);
    revokedB = teamB.setUserMachineLinks(bobIdB, []);
    assert.deepEqual(linkedHosts(revokedB, aliceIdB), [EDGE_HOST]);
    assert.deepEqual(linkedHosts(revokedB, bobIdB), []);

    await syncB.syncNow();
    await syncA.syncNow();

    const syncedA = teamA.overview();
    const aliceIdA = userByName(syncedA, "alice").id;
    const bobIdA = userByName(syncedA, "bob").id;
    const gpuIdA = machineByHost(syncedA, GPU_HOST).id;
    assert.deepEqual(linkedHosts(syncedA, aliceIdA), [EDGE_HOST], "the revoke from device B reached device A");
    assert.deepEqual(linkedHosts(syncedA, bobIdA), []);
    assert.ok(
      syncedA.activity.some((entry) => entry.action === "machine.links" && entry.targetName === "Alice Rivera"),
      "grant and revoke operations are audited",
    );

    await teamA.logout();
    const aliceOnA = await teamA.login({ username: "alice", password: PASSWORD });
    assert.equal(aliceOnA.username, "alice");
    const aliceViewA = teamA.overview();
    assert.deepEqual(machineHosts(aliceViewA), [EDGE_HOST]);
    assert.equal(teamA.canAccessMachine(aliceOnA.id, gpuIdA), false);

    await teamA.logout();
    const bobOnA = await teamA.login({ username: "bob", password: PASSWORD });
    assert.equal(bobOnA.username, "bob");
    assert.deepEqual(machineHosts(teamA.overview()), []);
  } finally {
    try {
      syncA?.close();
    } catch {
      /* best effort */
    }
    try {
      syncB?.close();
    } catch {
      /* best effort */
    }
    try {
      teamA?.close();
    } catch {
      /* best effort */
    }
    try {
      teamB?.close();
    } catch {
      /* best effort */
    }
    if (relay) {
      try {
        await stopRelay(relay);
      } catch {
        /* best effort */
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("admin and moderator roles get every machine without explicit grants", { timeout: 30_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-admin-access-e2e-"));
  const previousHome = process.env.NEXUS_PVE_HOME;
  let team: TeamService | undefined;

  try {
    team = await openTeam(path.join(tempRoot, "device"));
    await team.bootstrap({ username: "owner", displayName: "Morgan Lee", password: PASSWORD });
    team.syncMachines([sshHost("edge-a", "Edge relay", EDGE_HOST), sshHost("gpu-a", "GPU worker", GPU_HOST)]);

    let overview = team.overview();
    const edge = machineByHost(overview, EDGE_HOST);
    const gpu = machineByHost(overview, GPU_HOST);
    overview = team.createUser({ username: "admin", displayName: "Ada Admin", role: "admin", password: PASSWORD });
    overview = team.createUser({ username: "mod", displayName: "Mo Moderator", role: "moderator", password: PASSWORD });
    overview = team.createUser({ username: "member", displayName: "Mia Member", role: "user", password: PASSWORD });
    const admin = userByName(overview, "admin");
    const moderator = userByName(overview, "mod");
    const member = userByName(overview, "member");

    // Effective access is visible immediately, without a single machine_links row.
    assert.equal(admin.linkedMachines, 2);
    assert.equal(moderator.linkedMachines, 2);
    assert.equal(member.linkedMachines, 0);
    assert.equal(team.canAccessMachine(admin.id, edge.id), true);
    assert.equal(team.canAccessMachine(moderator.id, gpu.id), true);
    assert.equal(team.canUseSshKey(admin.id, edge.id), true);
    assert.equal(team.canUseSshKey(member.id, edge.id), false);

    await team.login({ username: "admin", password: PASSWORD });
    assert.deepEqual(machineHosts(team.overview()), [EDGE_HOST, GPU_HOST]);
    await team.logout();

    await team.login({ username: "member", password: PASSWORD });
    assert.deepEqual(machineHosts(team.overview()), []);
  } finally {
    try {
      team?.close();
    } catch {
      /* best effort */
    }
    restoreHome(previousHome);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("super admin creates a member with every workspace machine in one save and syncs the grants", { timeout: 60_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-create-all-e2e-"));
  const previousHome = process.env.NEXUS_PVE_HOME;
  let relay: RelayHandle | undefined;
  let ownerStation: TeamService | undefined;
  let memberStation: TeamService | undefined;
  let ownerSync: TeamSyncService | undefined;
  let memberSync: TeamSyncService | undefined;

  try {
    relay = await startRelay(tempRoot);
    ownerStation = await openTeam(path.join(tempRoot, "owner-station"));
    await ownerStation.bootstrap({ username: "owner", displayName: "Morgan Lee", password: PASSWORD });
    ownerStation.syncMachines([sshHost("edge-a", "Edge relay", EDGE_HOST), sshHost("gpu-a", "GPU worker", GPU_HOST)]);

    // One call creates the account and attaches every machine. There is no
    // follow-up grant call that could fail or leave the member half-provisioned.
    let overview = ownerStation.createUser({
      username: "newops",
      displayName: "New Operator",
      role: "user",
      password: PASSWORD,
      grantAllMachines: true,
    });
    const newOps = userByName(overview, "newops");
    assert.equal(newOps.linkedMachines, 2);
    assert.deepEqual(linkedHosts(overview, newOps.id), [EDGE_HOST, GPU_HOST]);
    assert.ok(
      overview.machines.every((machine) => machine.linkedUserIds.includes(newOps.id)),
      "every workspace machine is linked in the same create operation",
    );
    assert.ok(
      overview.activity.some(
        (entry) =>
          entry.action === "machine.links" &&
          entry.targetName === "New Operator" &&
          entry.detail === "2 machines granted at account creation",
      ),
      "the automatic grants are audit-logged",
    );

    ownerSync = new TeamSyncService(ownerStation, () => undefined, path.join(tempRoot, "sync-owner.json"));
    const published = await ownerSync.configure({
      endpoint: relay.url,
      token: TOKEN,
      workspace: "team-create-all-e2e",
      deviceName: "owner-station",
    });
    assert.equal(published.status.phase, "online");

    memberStation = await openTeam(path.join(tempRoot, "member-station"));
    memberSync = new TeamSyncService(memberStation, () => undefined, path.join(tempRoot, "sync-member.json"));
    const pulled = await memberSync.configure({
      endpoint: relay.url,
      token: TOKEN,
      workspace: "team-create-all-e2e",
      deviceName: "member-station",
    });
    assert.equal(pulled.status.phase, "online");

    const mirrored = memberStation.syncSnapshot().machines;
    assert.equal(mirrored.length, 2);
    assert.ok(
      mirrored.every((machine) => machine.linkedUsernames.includes("newops")),
      "the machine grants reached the second station",
    );

    const memberOnB = await memberStation.login({ username: "newops", password: PASSWORD });
    assert.equal(memberOnB.role, "user");
    const memberView = memberStation.overview();
    assert.deepEqual(machineHosts(memberView), [EDGE_HOST, GPU_HOST]);
    const edgeOnB = machineByHost(memberView, EDGE_HOST);
    const gpuOnB = machineByHost(memberView, GPU_HOST);
    assert.equal(memberStation.canAccessMachine(memberOnB.id, edgeOnB.id), true);
    assert.equal(memberStation.canAccessMachine(memberOnB.id, gpuOnB.id), true);
    assert.equal(memberStation.canUseSshKey(memberOnB.id, edgeOnB.id), true);
    assert.equal(
      memberStation.canUseSshEndpoint(memberOnB.id, { host: EDGE_HOST, port: 22, username: "root" }),
      true,
      "the member can adopt the granted SSH endpoint with their own credentials",
    );
    assert.equal(
      memberStation.canUseSshEndpoint(memberOnB.id, { host: "10.42.0.99", port: 22, username: "root" }),
      false,
      "an endpoint outside the member's grants cannot be adopted",
    );
  } finally {
    for (const service of [ownerSync, memberSync]) {
      try {
        service?.close();
      } catch {
        /* best effort */
      }
    }
    for (const service of [ownerStation, memberStation]) {
      try {
        service?.close();
      } catch {
        /* best effort */
      }
    }
    if (relay) {
      try {
        await stopRelay(relay);
      } catch {
        /* best effort */
      }
    }
    restoreHome(previousHome);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("a new station joins the relay directory and replaces an accidental local workspace", { timeout: 90_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-join-e2e-"));
  const previousHome = process.env.NEXUS_PVE_HOME;
  let relay: RelayHandle | undefined;
  let teamA: TeamService | undefined;
  let teamB: TeamService | undefined;
  let teamC: TeamService | undefined;
  let syncA: TeamSyncService | undefined;
  let syncB: TeamSyncService | undefined;
  let syncC: TeamSyncService | undefined;

  try {
    relay = await startRelay(tempRoot);
    teamA = await openTeam(path.join(tempRoot, "owner-station"));
    await teamA.bootstrap({ username: "owner", displayName: "Morgan Lee", password: PASSWORD });
    teamA.syncMachines([sshHost("edge-a", "Edge relay", EDGE_HOST), sshHost("gpu-a", "GPU worker", GPU_HOST)]);
    teamA.createUser({ username: "alice", displayName: "Alice Rivera", role: "user", password: PASSWORD });

    // The fresh station asks the relay before creating any local account.
    teamB = await openTeam(path.join(tempRoot, "fresh-station"));
    syncB = new TeamSyncService(teamB, () => undefined, path.join(tempRoot, "sync-fresh.json"));
    const emptyPreview = await syncB.preview({
      endpoint: relay.url,
      token: TOKEN,
      workspace: "team-join-e2e",
      deviceName: "fresh-station",
    });
    assert.equal(emptyPreview.users.length, 0);
    await assert.rejects(
      syncB.join({ endpoint: relay.url, token: TOKEN, workspace: "team-join-e2e", deviceName: "fresh-station" }),
      /no team workspace yet/,
    );

    syncA = new TeamSyncService(teamA, () => undefined, path.join(tempRoot, "sync-owner.json"));
    const published = await syncA.configure({
      endpoint: relay.url,
      token: TOKEN,
      workspace: "team-join-e2e",
      deviceName: "owner-station",
    });
    assert.equal(published.status.phase, "online");

    const preview = await syncB.preview({
      endpoint: relay.url,
      token: TOKEN,
      workspace: "team-join-e2e",
      deviceName: "fresh-station",
    });
    assert.equal(preview.workspaceName, "Nexus Operations");
    assert.deepEqual(preview.users.map((user) => user.username), ["alice", "owner"]);
    assert.equal(preview.machines, 2);
    assert.equal(teamB.hasUsers(), false, "preview does not create a local account");

    const joined = await syncB.join({
      endpoint: relay.url,
      token: TOKEN,
      workspace: "team-join-e2e",
      deviceName: "fresh-station",
    });
    assert.equal(joined.status.phase, "online");
    assert.equal(joined.pushed, 0, "joining never publishes the local directory");
    assert.equal(joined.status.counts.users, 2);
    assert.equal(joined.status.counts.machines, 2);
    assert.equal(teamB.status().initialized, true);
    assert.equal(teamB.status().user, null, "the joined station must sign in with the invited account");
    const aliceOnB = await teamB.login({ username: "alice", password: PASSWORD });
    assert.equal(aliceOnB.role, "user");
    await teamB.logout();

    // A station that already became its own owner must opt into replacement.
    teamC = await openTeam(path.join(tempRoot, "accidental-station"));
    await teamC.bootstrap({ username: "lori", displayName: "Lori Lane", password: PASSWORD });
    syncC = new TeamSyncService(teamC, () => undefined, path.join(tempRoot, "sync-accidental.json"));
    await assert.rejects(
      syncC.join({ endpoint: relay.url, token: TOKEN, workspace: "team-join-e2e", deviceName: "accidental-station" }),
      /already has a local workspace/,
    );

    const replaced = await syncC.join({
      endpoint: relay.url,
      token: TOKEN,
      workspace: "team-join-e2e",
      deviceName: "accidental-station",
      replaceLocal: true,
    });
    assert.equal(replaced.status.phase, "online");
    assert.equal(replaced.status.counts.users, 2);
    await assert.rejects(teamC.login({ username: "lori", password: PASSWORD }), /Invalid username or password/);
    const aliceOnC = await teamC.login({ username: "alice", password: PASSWORD });
    assert.equal(aliceOnC.role, "user");
    await teamC.logout();

    // The accidental local owner never reached the shared relay.
    await syncA.syncNow();
    assert.deepEqual(
      teamA.overview().users.map((user) => user.username),
      ["owner", "alice"],
      "the relay directory still contains only the real team accounts",
    );
  } finally {
    for (const service of [syncA, syncB, syncC]) {
      try {
        service?.close();
      } catch {
        /* best effort */
      }
    }
    for (const service of [teamA, teamB, teamC]) {
      try {
        service?.close();
      } catch {
        /* best effort */
      }
    }
    if (relay) {
      try {
        await stopRelay(relay);
      } catch {
        /* best effort */
      }
    }
    restoreHome(previousHome);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("team changes revoke only keys whose member grant disappeared", { timeout: 60_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-key-revoke-e2e-"));
  const previousHome = process.env.NEXUS_PVE_HOME;
  let team: TeamService | undefined;

  try {
    team = await openTeam(tempRoot);
    await team.bootstrap({ username: "owner", displayName: "Morgan Lee", password: PASSWORD });
    team.syncMachines([sshHost("edge-a", "Edge relay", EDGE_HOST), sshHost("gpu-a", "GPU worker", GPU_HOST)]);

    let overview = team.overview();
    const edge = machineByHost(overview, EDGE_HOST);
    const gpu = machineByHost(overview, GPU_HOST);
    overview = team.createUser({ username: "alice", displayName: "Alice Rivera", role: "user", password: PASSWORD });
    overview = team.createUser({ username: "bob", displayName: "Bob Chen", role: "user", password: PASSWORD });
    overview = team.createUser({ username: "carol", displayName: "Carol Singh", role: "user", password: PASSWORD });
    const alice = userByName(overview, "alice");
    const bob = userByName(overview, "bob");
    const carol = userByName(overview, "carol");
    team.setUserMachineLinks(alice.id, [edge.id, gpu.id]);
    team.setUserMachineLinks(bob.id, [edge.id]);
    team.setUserMachineLinks(carol.id, [edge.id, gpu.id]);

    // Seed the vault the same way issued member keys look: assigned to one
    // member for one machine. Empty hosts keeps this test focused on the
    // revocation decision; the SSH-key smoke covers remote removal itself.
    const keys = new SshKeyService(new ConfigStore(tempRoot));
    for (const label of ["alice-edge", "alice-gpu", "bob-edge", "carol-edge", "carol-gpu"]) {
      keys.generate({ label, owner: "seed" });
    }
    const stateFile = path.join(tempRoot, "sshkeys", "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { keys: Array<Record<string, unknown>> };
    const assign = (label: string, member: typeof alice, hostId: string) => {
      const key = state.keys.find((entry) => entry.label === label);
      assert(key, `expected seeded key ${label}`);
      key.assignedTo = { id: member.id, username: member.username, displayName: member.displayName };
      key.issuedHostId = hostId;
      key.hosts = [];
    };
    assign("alice-edge", alice, edge.id);
    assign("alice-gpu", alice, gpu.id);
    assign("bob-edge", bob, edge.id);
    assign("carol-edge", carol, edge.id);
    assign("carol-gpu", carol, gpu.id);
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

    const statusOf = (label: string) => keys.overview().keys.find((key) => key.label === label)?.status;
    let result = await revokeUnauthorizedTeamKeys(team, keys);
    assert.deepEqual(result.revoked, [], "valid grants are left alone");
    assert.equal(result.failed.length, 0);
    assert.equal(statusOf("alice-edge"), "active");
    assert.equal(statusOf("alice-gpu"), "active");
    assert.equal(team.canUseSshKey(alice.id, gpu.id), true);

    const validBefore = keys.overview().keys.find((key) => key.label === "alice-edge");
    assert(validBefore);
    team.setUserMachineLinks(alice.id, [edge.id]);
    result = await revokeUnauthorizedTeamKeys(team, keys);
    assert.deepEqual(result.revoked.map((key) => key.label), ["alice-gpu"]);
    assert.equal(statusOf("alice-gpu"), "retired", "the key for the removed machine is revoked");
    assert.equal(statusOf("alice-edge"), "active");
    assert.equal(statusOf("bob-edge"), "active");
    const validAfter = keys.overview().keys.find((key) => key.label === "alice-edge");
    assert(validAfter);
    assert.equal(validAfter.fingerprint, validBefore.fingerprint);
    assert.deepEqual(validAfter.hosts, validBefore.hosts);
    assert.equal(validAfter.lastDeployedAt, validBefore.lastDeployedAt);
    assert.equal(team.canUseSshKey(alice.id, gpu.id), false);
    assert.equal(team.canUseSshKey(alice.id, edge.id), true);

    team.updateUser(bob.id, { status: "suspended" });
    result = await revokeUnauthorizedTeamKeys(team, keys);
    assert.deepEqual(result.revoked.map((key) => key.label), ["bob-edge"]);
    assert.equal(statusOf("bob-edge"), "retired", "suspension revokes every key for the member");
    assert.equal(team.canUseSshKey(bob.id, edge.id), false);

    // A grant removed on another device is applied by sync; the same
    // reconciliation must retire the now-inaccessible key and keep the other.
    const syncedLinks = team.syncSnapshot();
    const syncedGpu = syncedLinks.machines.find((machine) => machine.host === GPU_HOST);
    assert(syncedGpu);
    syncedGpu.linkedUsernames = syncedGpu.linkedUsernames.filter((username) => username !== "carol");
    syncedGpu.linksUpdatedAt += 10_000;
    team.applySyncSnapshot(syncedLinks);
    result = await revokeUnauthorizedTeamKeys(team, keys);
    assert.deepEqual(result.revoked.map((key) => key.label), ["carol-gpu"]);
    assert.equal(statusOf("carol-gpu"), "retired");
    assert.equal(statusOf("carol-edge"), "active");

    const syncedSuspend = team.syncSnapshot();
    const syncedCarol = syncedSuspend.users.find((user) => user.username === "carol");
    assert(syncedCarol);
    syncedCarol.status = "suspended";
    syncedCarol.updatedAt += 10_000;
    team.applySyncSnapshot(syncedSuspend);
    result = await revokeUnauthorizedTeamKeys(team, keys);
    assert.deepEqual(result.revoked.map((key) => key.label), ["carol-edge"]);
    assert.equal(statusOf("carol-edge"), "retired");

    team.deleteUser(alice.id);
    result = await revokeUnauthorizedTeamKeys(team, keys);
    assert.deepEqual(result.revoked.map((key) => key.label), ["alice-edge"]);
    assert.equal(statusOf("alice-edge"), "retired", "deletion revokes the remaining member key");
    assert.equal(team.canUseSshKey(alice.id, edge.id), false);
    assert.equal(result.failed.length, 0);
  } finally {
    try {
      team?.close();
    } catch {
      /* best effort */
    }
    if (previousHome === undefined) delete process.env.NEXUS_PVE_HOME;
    else process.env.NEXUS_PVE_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("migrates pre-1.0.12 insert-time link revisions without touching edited grants", { timeout: 60_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-migration-e2e-"));
  let legacy: TeamService | undefined;

  try {
    const home = path.join(tempRoot, "legacy-pc");
    legacy = await openTeam(home);
    await legacy.bootstrap({
      username: "owner",
      displayName: "Legacy Owner",
      password: PASSWORD,
    });
    legacy.syncMachines([
      sshHost("legacy-edge", "Legacy edge", LEGACY_EDGE_HOST),
      sshHost("legacy-edited", "Legacy edited", LEGACY_EDITED_HOST),
      sshHost("legacy-revoked", "Legacy revoked", LEGACY_REVOKED_HOST),
    ]);
    const overview = legacy.createUser({
      username: "alice",
      displayName: "Alice Rivera",
      role: "user",
      password: PASSWORD,
    });
    const aliceId = userByName(overview, "alice").id;
    const edited = machineByHost(overview, LEGACY_EDITED_HOST);
    const revoked = machineByHost(overview, LEGACY_REVOKED_HOST);

    // These are ordinary pre-1.0.12 link edits: one grant remains, the other
    // was revoked. Both write machine-targeted machine.links audit entries.
    legacy.setMachineLinks(edited.id, [aliceId]);
    legacy.setMachineLinks(revoked.id, [aliceId]);
    legacy.setMachineLinks(revoked.id, []);
    legacy.close();
    legacy = undefined;

    const databasePath = path.join(home, "team.sqlite");
    const database = await openRawDatabase(databasePath);
    const legacyInsert = 1_700_000_000_000;
    // The pre-1.0.12 store used the machine insert time as the whole-set link
    // revision. All three rows get that exact marker; only the untouched edge
    // row is safe to reset.
    database.run("UPDATE settings SET value = '1' WHERE key = 'schema_version'");
    database.run("UPDATE machines SET links_updated_at = ?, updated_at = ?", [legacyInsert, legacyInsert]);
    fs.writeFileSync(databasePath, Buffer.from(database.export()));
    database.close();

    legacy = await openTeam(home);
    const migrated = legacy.syncSnapshot();
    const edgeSync = migrated.machines.find((machine) => machine.host === LEGACY_EDGE_HOST);
    const editedSync = migrated.machines.find((machine) => machine.host === LEGACY_EDITED_HOST);
    const revokedSync = migrated.machines.find((machine) => machine.host === LEGACY_REVOKED_HOST);
    assert(edgeSync && editedSync && revokedSync);
    assert.equal(edgeSync.linksUpdatedAt, 0, "only the untouched insert marker is reset");
    assert.equal(editedSync.linksUpdatedAt, legacyInsert, "an existing grant keeps its revision");
    assert.equal(revokedSync.linksUpdatedAt, legacyInsert, "a revoked grant keeps its revision");

    // A grant made earlier on another computer is older than the old insert
    // marker. It must apply to the reset row, but not to either edited row.
    const remote = structuredClone(migrated);
    for (const machine of remote.machines) {
      if (machine.host === LEGACY_EDGE_HOST || machine.host === LEGACY_REVOKED_HOST) {
        machine.linksUpdatedAt = legacyInsert - 10_000;
        machine.linkedUsernames = ["alice"];
      }
    }
    legacy.applySyncSnapshot(remote);
    await legacy.login({ username: "owner", password: PASSWORD });
    const afterSync = legacy.overview();
    const aliceAfter = userByName(afterSync, "alice");
    assert.deepEqual(linkedHosts(afterSync, aliceAfter.id), [LEGACY_EDGE_HOST, LEGACY_EDITED_HOST]);
    assert.equal(legacy.canAccessMachine(aliceAfter.id, machineByHost(afterSync, LEGACY_REVOKED_HOST).id), false);
  } finally {
    try {
      legacy?.close();
    } catch {
      /* best effort */
    }
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("legacy superadmin schema upgrade promotes the owner and preserves sessions and machine grants", { timeout: 60_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-superadmin-migration-e2e-"));
  const previousHome = process.env.NEXUS_PVE_HOME;
  let team: TeamService | undefined;

  try {
    const home = path.join(tempRoot, "legacy-pc");
    const service = await openTeam(home);
    team = service;
    const owner = await service.bootstrap({
      username: "owner",
      displayName: "Legacy Owner",
      password: PASSWORD,
    });
    assert.equal(owner.role, "superadmin");
    service.syncMachines([sshHost("legacy-edge", "Legacy edge", EDGE_HOST), sshHost("legacy-gpu", "Legacy GPU", GPU_HOST)]);

    let overview = service.overview();
    const edge = machineByHost(overview, EDGE_HOST);
    const gpu = machineByHost(overview, GPU_HOST);
    overview = service.createUser({ username: "admin", displayName: "Legacy Admin", role: "admin", password: PASSWORD });
    overview = service.createUser({ username: "mod", displayName: "Legacy Moderator", role: "moderator", password: PASSWORD });
    overview = service.createUser({ username: "member", displayName: "Legacy Member", role: "user", password: PASSWORD });
    const admin = userByName(overview, "admin");
    const moderator = userByName(overview, "mod");
    const member = userByName(overview, "member");
    service.setUserMachineLinks(member.id, [edge.id, gpu.id]);
    service.setMachineLinks(edge.id, [member.id, admin.id]);

    // Leave one session per account. The schema rebuild must not cascade them
    // away, and the password hashes must still authenticate after the upgrade.
    await service.login({ username: "admin", password: PASSWORD });
    await service.login({ username: "mod", password: PASSWORD });
    await service.login({ username: "member", password: PASSWORD });
    service.close();
    team = undefined;

    const databasePath = path.join(home, "team.sqlite");
    const database = await openRawDatabase(databasePath);
    const sessionHashes = rawStringColumn(database, "SELECT token_hash FROM sessions ORDER BY token_hash");
    const machineGrants = rawStringColumn(
      database,
      "SELECT user_id || ':' || machine_id FROM machine_links ORDER BY user_id, machine_id",
    );
    assert.equal(sessionHashes.length, 4, "the fixture has one session for each account");
    assert.equal(machineGrants.length, 3, "the fixture has three explicit machine grants");

    // Simulate a database created before superadmin existed. The old users
    // CHECK constraint only allowed admin/moderator/user, and the original
    // owner therefore had the admin role.
    database.run("PRAGMA foreign_keys = OFF");
    database.run(`
      CREATE TABLE users_legacy (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'moderator', 'user')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER
      )
    `);
    database.run(`
      INSERT INTO users_legacy
        (id, username, display_name, role, status, password_salt, password_hash, created_at, updated_at, last_login_at)
      SELECT id, username, display_name,
        CASE WHEN role = 'superadmin' THEN 'admin' ELSE role END,
        status, password_salt, password_hash, created_at, updated_at, last_login_at
      FROM users
    `);
    database.run("DROP TABLE users");
    database.run("ALTER TABLE users_legacy RENAME TO users");
    // Isolate this regression from the separate pre-1.0.12 link-revision repair.
    database.run("UPDATE settings SET value = '2' WHERE key = 'schema_version'");
    fs.writeFileSync(databasePath, Buffer.from(database.export()));
    database.close();

    const reopened = await openTeam(home);
    team = reopened;
    const upgraded = await openRawDatabase(databasePath);
    assert.deepEqual(
      rawStringColumn(upgraded, "SELECT token_hash FROM sessions ORDER BY token_hash"),
      sessionHashes,
      "the users-table rebuild preserves every session",
    );
    assert.deepEqual(
      rawStringColumn(upgraded, "SELECT user_id || ':' || machine_id FROM machine_links ORDER BY user_id, machine_id"),
      machineGrants,
      "the users-table rebuild preserves every machine grant",
    );
    assert.deepEqual(rawStringColumn(upgraded, "SELECT role FROM users WHERE username = 'owner'"), ["superadmin"]);
    assert.deepEqual(rawStringColumn(upgraded, "SELECT role FROM users WHERE username = 'admin'"), ["admin"]);
    assert.deepEqual(rawStringColumn(upgraded, "SELECT role FROM users WHERE username = 'mod'"), ["moderator"]);
    assert.deepEqual(rawStringColumn(upgraded, "SELECT role FROM users WHERE username = 'member'"), ["user"]);
    upgraded.close();

    const ownerAgain = await reopened.login({ username: "owner", password: PASSWORD });
    assert.equal(ownerAgain.role, "superadmin", "the earliest legacy admin is promoted to owner");
    const upgradedOverview = reopened.overview();
    assert.equal(userByName(upgradedOverview, "admin").role, "admin");
    assert.equal(userByName(upgradedOverview, "mod").role, "moderator");
    assert.equal(userByName(upgradedOverview, "member").role, "user");
    assert.deepEqual(linkedHosts(upgradedOverview, member.id), [EDGE_HOST, GPU_HOST]);
    assert.deepEqual(linkedHosts(upgradedOverview, admin.id), [EDGE_HOST]);

    const memberAfter = await reopened.login({ username: "member", password: PASSWORD });
    assert.equal(reopened.canAccessMachine(memberAfter.id, edge.id), true);
    assert.equal(reopened.canAccessMachine(memberAfter.id, gpu.id), true);
    assert.equal(reopened.canUseSshKey(memberAfter.id, edge.id), true);
    assert.equal(reopened.canUseSshKey(memberAfter.id, gpu.id), true);
  } finally {
    try {
      team?.close();
    } catch {
      /* best effort */
    }
    restoreHome(previousHome);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("superadmin role matrix enforces promotion and admin/moderator boundaries", { timeout: 60_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-superadmin-matrix-e2e-"));
  const previousHome = process.env.NEXUS_PVE_HOME;
  let team: TeamService | undefined;

  try {
    const service = await openTeam(path.join(tempRoot, "matrix-pc"));
    team = service;
    const owner = await service.bootstrap({
      username: "owner",
      displayName: "Matrix Owner",
      password: PASSWORD,
    });
    assert.equal(owner.role, "superadmin");
    service.syncMachines([sshHost("matrix-edge", "Matrix edge", EDGE_HOST), sshHost("matrix-gpu", "Matrix GPU", GPU_HOST)]);

    let overview = service.overview();
    const edge = machineByHost(overview, EDGE_HOST);
    const gpu = machineByHost(overview, GPU_HOST);
    overview = service.createUser({ username: "admin", displayName: "Matrix Admin", role: "admin", password: PASSWORD });
    overview = service.createUser({ username: "mod", displayName: "Matrix Moderator", role: "moderator", password: PASSWORD });
    overview = service.createUser({ username: "member", displayName: "Matrix Member", role: "user", password: PASSWORD });
    const admin = userByName(overview, "admin");
    const moderator = userByName(overview, "mod");
    const member = userByName(overview, "member");
    service.setUserMachineLinks(member.id, [edge.id]);
    await service.logout();

    const adminUser = await service.login({ username: "admin", password: PASSWORD });
    assert.equal(adminUser.role, "admin");
    let adminView = service.overview();
    assert.deepEqual(adminView.permissions, {
      manageUsers: true,
      manageRoles: true,
      deleteUsers: true,
      manageLinks: true,
      manageMachines: true,
    });
    assert.throws(
      () => service.createUser({ username: "bad-root", displayName: "Blocked", role: "superadmin", password: PASSWORD }),
      /Only a super admin can create another super admin/,
    );
    assert.throws(
      () => service.updateUser(member.id, { role: "superadmin" }),
      /Only a super admin can manage a super admin/,
    );
    assert.throws(
      () => service.updateUser(owner.id, { displayName: "Owner Renamed" }),
      /Only a super admin can manage a super admin/,
    );
    assert.throws(() => service.deleteUser(owner.id), /Only a super admin can delete a super admin/);
    adminView = service.createUser({ username: "ops", displayName: "Ops Moderator", role: "moderator", password: PASSWORD });
    const ops = userByName(adminView, "ops");
    adminView = service.updateUser(ops.id, { displayName: "Ops Lead" });
    assert.equal(userByName(adminView, "ops").displayName, "Ops Lead");
    adminView = service.updateUser(member.id, { displayName: "Member Prime" });
    assert.equal(userByName(adminView, "member").displayName, "Member Prime");
    await service.logout();

    const moderatorUser = await service.login({ username: "mod", password: PASSWORD });
    assert.equal(moderatorUser.role, "moderator");
    let moderatorView = service.overview();
    assert.deepEqual(moderatorView.permissions, {
      manageUsers: true,
      manageRoles: false,
      deleteUsers: false,
      manageLinks: true,
      manageMachines: true,
    });
    moderatorView = service.createUser({ username: "newbie", displayName: "New Member", role: "user", password: PASSWORD });
    assert.equal(userByName(moderatorView, "newbie").role, "user");
    for (const role of ["admin", "moderator", "superadmin"] as const) {
      assert.throws(
        () => service.createUser({ username: `bad-${role}`, displayName: "Blocked", role, password: PASSWORD }),
        /Moderators can only create standard members/,
      );
    }
    assert.throws(
      () => service.updateUser(admin.id, { displayName: "Admin Renamed" }),
      /Moderators can only manage standard member accounts/,
    );
    assert.throws(
      () => service.updateUser(member.id, { role: "admin" }),
      /Moderators can only manage standard member accounts/,
    );
    moderatorView = service.updateUser(member.id, { displayName: "Member Two" });
    assert.equal(userByName(moderatorView, "member").displayName, "Member Two");
    moderatorView = service.setUserMachineLinks(member.id, [edge.id]);
    assert.deepEqual(linkedHosts(moderatorView, member.id), [EDGE_HOST]);
    assert.throws(
      () => service.setUserMachineLinks(admin.id, [edge.id]),
      /Moderators can only manage standard member access/,
    );
    assert.throws(
      () => service.setMachineLinks(edge.id, [admin.id]),
      /Moderators can only grant machines to standard members/,
    );
    assert.throws(() => service.deleteUser(member.id), /Admin or super admin access required/);
    await service.logout();

    const memberUser = await service.login({ username: "member", password: PASSWORD });
    assert.equal(memberUser.role, "user");
    const memberView = service.overview();
    assert.deepEqual(memberView.permissions, {
      manageUsers: false,
      manageRoles: false,
      deleteUsers: false,
      manageLinks: false,
      manageMachines: false,
    });
    assert.throws(
      () => service.createUser({ username: "blocked", displayName: "Blocked", role: "user", password: PASSWORD }),
      /Admin or moderator access required/,
    );
    assert.throws(
      () => service.updateUser(member.id, { displayName: "No" }),
      /Admin or moderator access required/,
    );
    assert.throws(() => service.setUserMachineLinks(member.id, []), /Admin or moderator access required/);
    assert.throws(() => service.setMachineLinks(edge.id, []), /Admin or moderator access required/);
    assert.throws(() => service.deleteUser(member.id), /Admin or super admin access required/);
    assert.equal(service.canAccessMachine(memberUser.id, edge.id), true);
    assert.equal(service.canAccessMachine(memberUser.id, gpu.id), false);
    await service.logout();

    const ownerAgain = await service.login({ username: "owner", password: PASSWORD });
    assert.equal(ownerAgain.role, "superadmin");
    const ownerView = service.overview();
    assert.deepEqual(ownerView.permissions, {
      manageUsers: true,
      manageRoles: true,
      deleteUsers: true,
      manageLinks: true,
      manageMachines: true,
    });
    const root2View = service.createUser({ username: "root2", displayName: "Second Super", role: "superadmin", password: PASSWORD });
    assert.equal(userByName(root2View, "root2").role, "superadmin");
    const promotedView = service.updateUser(admin.id, { role: "superadmin" });
    assert.equal(userByName(promotedView, "admin").role, "superadmin", "a super admin can promote another admin");
    const managedView = service.updateUser(admin.id, { displayName: "Admin Prime" });
    assert.equal(userByName(managedView, "admin").displayName, "Admin Prime");
  } finally {
    try {
      team?.close();
    } catch {
      /* best effort */
    }
    restoreHome(previousHome);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("Proxmox endpoints sync as workspace machines without credentials", { timeout: 60_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-pve-e2e-"));
  const previousHome = process.env.NEXUS_PVE_HOME;
  let teamA: TeamService | undefined;
  let teamB: TeamService | undefined;

  try {
    teamA = await openTeam(path.join(tempRoot, "pve-a"));
    await teamA.bootstrap({ username: "owner", displayName: "PVE Owner", password: PASSWORD });
    teamA.syncMachines([sshHost("pve-edge", "Edge relay", EDGE_HOST)]);
    teamA.syncPveHosts([
      {
        id: "pve-cynosure",
        label: "Cynosure",
        baseUrl: "https://10.42.0.86:8006",
        authMode: "token",
        tlsVerify: false,
        color: "#ffaa00",
        hasSecret: true,
        createdAt: Date.now(),
      },
    ]);

    let overview = teamA.overview();
    const pve = overview.machines.find((machine) => machine.kind === "pve");
    assert.ok(pve, "the Proxmox endpoint is in the workspace directory");
    assert.equal(pve.baseUrl, "https://10.42.0.86:8006");
    const member = userByName(
      teamA.createUser({ username: "member", displayName: "PVE Member", role: "user", password: PASSWORD }),
      "member",
    );
    overview = teamA.setUserMachineLinks(member.id, [pve.id]);
    const pveAfterGrant = overview.machines.find((machine) => machine.kind === "pve");
    assert.ok(pveAfterGrant?.linkedUserIds.includes(member.id), "the member grant is recorded on the Proxmox entry");
    assert.equal(teamA.canUsePveEndpoint(member.id, "https://10.42.0.86:8006"), true);
    assert.equal(teamA.canUsePveEndpoint(member.id, "https://10.42.0.87:8006"), false);
    assert.equal(
      teamA.canUseSshEndpoint(member.id, { host: EDGE_HOST, port: 22, username: "root" }),
      false,
      "a Proxmox grant does not grant the unrelated SSH endpoint",
    );

    const snapshotA = teamA.syncSnapshot();
    const syncedPve = snapshotA.machines.find((machine) => machine.kind === "pve");
    assert.ok(syncedPve, "the Proxmox endpoint is published to the relay snapshot");
    assert.equal(syncedPve.key, "pve:https://10.42.0.86:8006");
    assert.deepEqual(syncedPve.linkedUsernames, ["member"]);
    assert.equal("secret" in syncedPve, false, "credentials never travel in the snapshot");

    teamB = await openTeam(path.join(tempRoot, "pve-b"));
    teamB.applySyncSnapshot(snapshotA);
    let snapshotB = teamB.syncSnapshot();
    const remotePve = snapshotB.machines.find((machine) => machine.kind === "pve");
    assert.ok(remotePve, "another station receives the Proxmox endpoint");
    assert.deepEqual(remotePve.linkedUsernames, ["member"]);

    teamB.syncMachines([]);
    snapshotB = teamB.syncSnapshot();
    assert.ok(
      snapshotB.machines.some((machine) => machine.kind === "pve"),
      "an SSH inventory refresh must not delete a workspace Proxmox endpoint",
    );

    teamB.syncPveHosts([
      {
        id: "local-pve",
        label: "Cynosure local",
        baseUrl: "https://10.42.0.86:8006",
        authMode: "token",
        tlsVerify: false,
        color: "#ffaa00",
        hasSecret: true,
        createdAt: Date.now(),
      },
    ]);
    const adopted = teamB.syncSnapshot().machines.filter((machine) => machine.kind === "pve");
    assert.equal(adopted.length, 1, "adding the endpoint locally adopts the workspace row");
    assert.equal(adopted[0].label, "Cynosure local");
    assert.deepEqual(adopted[0].linkedUsernames, ["member"], "the grant survives adoption");
    assert.equal("secret" in adopted[0], false);
    const memberB = await teamB.login({ username: "member", password: PASSWORD });
    assert.equal(teamB.canUsePveEndpoint(memberB.id, "https://10.42.0.86:8006"), true);
    assert.equal(teamB.canUsePveEndpoint(memberB.id, "https://10.42.0.88:8006"), false);
  } finally {
    try {
      teamA?.close();
    } catch {
      /* best effort */
    }
    try {
      teamB?.close();
    } catch {
      /* best effort */
    }
    restoreHome(previousHome);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("member creation stays local and reports the relay error when immediate sync fails", { timeout: 30_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-sync-failure-e2e-"));
  const previousHome = process.env.NEXUS_PVE_HOME;
  let team: TeamService | undefined;
  let sync: TeamSyncService | undefined;
  let relay: http.Server | undefined;

  try {
    relay = http.createServer((_request, response) => {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "relay rejected the test update" }));
    });
    await new Promise<void>((resolve, reject) => {
      relay!.once("error", reject);
      relay!.listen(0, "127.0.0.1", resolve);
    });
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("Could not bind the failing relay fixture.");

    team = await openTeam(path.join(tempRoot, "station"));
    await team.bootstrap({ username: "owner", displayName: "Relay Owner", password: PASSWORD });
    team.syncMachines([sshHost("edge-a", "Edge relay", EDGE_HOST)]);

    sync = new TeamSyncService(team, () => undefined, path.join(tempRoot, "sync.json"));
    await assert.rejects(
      sync.configure({
        endpoint: `http://127.0.0.1:${address.port}`,
        token: TOKEN,
        workspace: "sync-failure-e2e",
        deviceName: "station",
      }),
      /relay rejected the test update/,
    );
    assert.equal(sync.status().enabled, true, "the station remains configured after the failed initial sync");
    assert.equal(sync.status().phase, "error");

    const created = team.createUser({
      username: "relaymember",
      displayName: "Relay Member",
      role: "user",
      password: PASSWORD,
      grantAllMachines: true,
    });
    const result = await publishTeamMutation(created, sync);

    assert.match(result.syncWarning ?? "", /relay rejected the test update/);
    assert.ok(
      result.users.some((user) => user.username === "relaymember"),
      "the overview returned to the admin still includes the locally created member",
    );
    assert.ok(
      team.overview().users.some((user) => user.username === "relaymember"),
      "the account remains committed after the relay failure",
    );
  } finally {
    sync?.close();
    try {
      team?.close();
    } catch {
      /* best effort */
    }
    if (relay) {
      await new Promise<void>((resolve) => relay!.close(() => resolve()));
    }
    restoreHome(previousHome);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("sign-in refreshes a stale team directory before validating a newly added member", { timeout: 60_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-login-refresh-e2e-"));
  const previousHome = process.env.NEXUS_PVE_HOME;
  let relay: RelayHandle | undefined;
  let ownerStation: TeamService | undefined;
  let memberStation: TeamService | undefined;
  let ownerSync: TeamSyncService | undefined;
  let memberSync: TeamSyncService | undefined;

  try {
    relay = await startRelay(tempRoot);
    ownerStation = await openTeam(path.join(tempRoot, "owner-station"));
    await ownerStation.bootstrap({ username: "owner", displayName: "Morgan Lee", password: PASSWORD });
    ownerStation.syncMachines([sshHost("edge-a", "Edge relay", EDGE_HOST), sshHost("gpu-a", "GPU worker", GPU_HOST)]);

    ownerSync = new TeamSyncService(ownerStation, () => undefined, path.join(tempRoot, "sync-owner.json"));
    await ownerSync.configure({
      endpoint: relay.url,
      token: TOKEN,
      workspace: "login-refresh-e2e",
      deviceName: "owner-station",
    });

    memberStation = await openTeam(path.join(tempRoot, "member-station"));
    memberSync = new TeamSyncService(memberStation, () => undefined, path.join(tempRoot, "sync-member.json"));
    await memberSync.configure({
      endpoint: relay.url,
      token: TOKEN,
      workspace: "login-refresh-e2e",
      deviceName: "member-station",
    });
    // Stop the 20-second poller so this test proves the sign-in refresh, not a
    // background poll, is what makes the new account available.
    memberSync.close();
    assert.equal(
      memberStation.syncSnapshot().users.some((user) => user.username === "newops"),
      false,
      "the member station starts without the account added later",
    );

    ownerStation.createUser({
      username: "newops",
      displayName: "New Operator",
      role: "user",
      password: PASSWORD,
      grantAllMachines: true,
    });
    await ownerSync.syncNow();
    assert.ok(
      ownerStation.syncSnapshot().users.some((user) => user.username === "newops"),
      "the owner published the new account to the relay",
    );

    const member = await loginWithFreshWorkspace(memberStation, memberSync, {
      username: "newops",
      password: PASSWORD,
    });
    assert.equal(member.username, "newops");
    assert.equal(member.role, "user");
    assert.deepEqual(machineHosts(memberStation.overview()), [EDGE_HOST, GPU_HOST]);
  } finally {
    for (const service of [ownerSync, memberSync]) {
      try {
        service?.close();
      } catch {
        /* best effort */
      }
    }
    for (const service of [ownerStation, memberStation]) {
      try {
        service?.close();
      } catch {
        /* best effort */
      }
    }
    if (relay) {
      try {
        await stopRelay(relay);
      } catch {
        /* best effort */
      }
    }
    restoreHome(previousHome);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
