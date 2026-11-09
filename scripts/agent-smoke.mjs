/**
 * End-to-end smoke test for the Nexus PVE agent/MCP pipeline.
 *
 * 1. boots a mock Proxmox VE API,
 * 2. spawns the real `dist-electron/mcp-server.cjs` over stdio JSON-RPC,
 * 3. drives full agent runs: fleet health sweep -> gated fleet backup ->
 *    restore -> snapshot rollback -> schedules -> evidence bundle -> dev tools,
 * 4. exercises the PRAETOR install gate and an active-Proxmox-firewall status
 *    regression through a local mock SSH host,
 * 5. asserts both the agent responses and the Proxmox calls the mock received.
 *
 * No network, no real Proxmox, no credentials.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";
import { startMockServer } from "./mock-pve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = path.join(root, "dist-electron", "mcp-server.cjs");

const TOKEN = "smoke@pve!agent=mock-secret";
const FIREWALL_PUBLIC_KEY = crypto.randomBytes(1216).toString("base64");
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const home = mkdtempSync(path.join(tmpdir(), "nexus-pve-smoke-"));
const mock = await startMockServer(0);
let firewallSsh = null;

const child = spawn(process.execPath, [serverPath], {
  cwd: root,
  env: {
    ...process.env,
    NEXUS_PVE_HOME: home,
    NEXUS_PVE_URL: mock.url,
    NEXUS_PVE_TOKEN: TOKEN,
    NEXUS_PVE_LABEL: "smoke-lab",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
child.on("error", (error) => {
  console.error("failed to spawn MCP server:", error);
  process.exit(1);
});

const pending = new Map();
let nextId = 1;
let buffer = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else resolve(message.result);
    }
  }
});

function rpc(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}${params?.name ? ` (${params.name})` : ""}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const call = async (name, args = {}) => {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result?.content?.[0]?.text ?? "";
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { result, text, json, isError: result?.isError === true };
};

const status = (runId) => call("pipeline.status", { runId }).then((result) => result.json);

const waitFor = async (predicate, timeoutMs = 30000, label = "condition") => {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};

function encryptSecret(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${data.toString("base64")}`;
}

function portIsFree(host, port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

async function pickFirewallHost() {
  for (let index = 9; index < 32; index += 1) {
    const host = `127.0.0.${index}`;
    if (await portIsFree(host, 9443)) return host;
  }
  throw new Error("no loopback address with TCP 9443 free for the PRAETOR firewall fixture");
}

function firewallStatus(expectedSha) {
  return [
    "installed=yes",
    `sha=${expectedSha}`,
    "active=active",
    `pubkey=${FIREWALL_PUBLIC_KEY}`,
    "node=v22.11.0",
    "profiles=yes",
    "listen_count=1",
    "listen_bind=0.0.0.0:9443",
    "pve=yes",
    "pvefw_status=Status: enabled",
    "pvefw_active=yes",
    "pvefw_policy=DROP",
    "pvefw_allow=no",
    "pvefw_readable=yes",
    "",
  ].join("\n");
}

function unreadableFirewallStatus(expectedSha) {
  return [
    "installed=yes",
    `sha=${expectedSha}`,
    "active=active",
    `pubkey=${FIREWALL_PUBLIC_KEY}`,
    "node=v22.11.0",
    "profiles=yes",
    "listen_count=1",
    "listen_bind=0.0.0.0:9443",
    "pve=yes",
    "pvefw_status=",
    "pvefw_active=unknown",
    "pvefw_policy=",
    "pvefw_allow=unknown",
    "pvefw_readable=no",
    "",
  ].join("\n");
}

function startMockSsh(host, output) {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sockets = new Set();
  const scripts = [];
  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === "root") {
        ctx.accept();
        return;
      }
      ctx.reject(["password"]);
    });
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec) => {
        const stream = acceptExec();
        let script = "";
        stream.on("data", (chunk) => {
          script += chunk.toString();
        });
        stream.on("end", () => {
          scripts.push(script);
          const result = typeof output === "function" ? output(script) : output;
          stream.write(result);
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, host, () => {
      server.removeListener("error", onError);
      server.on("error", () => {});
      resolve({
        port: server.address().port,
        scripts,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const cleanup = async () => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  if (firewallSsh) {
    try {
      await firewallSsh.close();
    } catch {
      /* already closed */
    }
  }
  await mock.close();
  rmSync(home, { recursive: true, force: true });
};

try {
  // ---- protocol -----------------------------------------------------------
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  check("initialize identifies the Nexus PVE MCP server", init?.serverInfo?.name === "nexus-pve", init?.serverInfo?.name);
  check(
    "initialize ships agent instructions covering approval + audit",
    typeof init?.instructions === "string" && init.instructions.includes("pipeline.approve") && init.instructions.includes("audit.tail"),
  );

  const list = await rpc("tools/list", {});
  const names = (list?.tools ?? []).map((tool) => tool.name);
  const required = [
    "hosts.list",
    "fleet.overview",
    "node.detail",
    "node.rrd",
    "vms.list",
    "vm.detail",
    "vm.action",
    "snapshot.list",
    "snapshot.create",
    "snapshot.rollback",
    "snapshot.delete",
    "tasks.list",
    "task.log",
    "backup.list",
    "backup.run",
    "backup.restore",
    "backup.remove",
    "backup.schedule.save",
    "backup.schedule.delete",
    "incident.bundle",
    "dev.tree",
    "dev.read_file",
    "dev.write_file",
    "dev.build",
    "dev.typecheck",
    "dev.smoke",
    "dev.package",
    "dev.run_script",
    "util.sleep",
    "util.assert",
    "pipeline.list",
    "pipeline.run",
    "pipeline.status",
    "pipeline.approve",
    "pipeline.cancel",
    "audit.tail",
    "praetor.overview",
    "praetor.plan",
    "praetor.profiles",
    "praetor.install",
    "praetor.install_all",
    "praetor.rotate",
  ];
  const missing = required.filter((name) => !names.includes(name));
  check("tool registry exposes the full PVE + dev surface", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${names.length} tools`);

  const runTool = (list?.tools ?? []).find((tool) => tool.name === "pipeline.run");
  check(
    "pipeline.run schema takes pipeline + vars + waitSeconds",
    !!runTool?.inputSchema?.properties?.pipeline &&
      !!runTool?.inputSchema?.properties?.vars &&
      !!runTool?.inputSchema?.properties?.waitSeconds,
  );
  const destructive = (list?.tools ?? []).filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name);
  check(
    "destructive tools are annotated",
    destructive.includes("backup.restore") &&
      destructive.includes("snapshot.rollback") &&
      destructive.includes("praetor.install") &&
      destructive.includes("praetor.install_all") &&
      destructive.includes("praetor.rotate") &&
      destructive.length >= 3,
    destructive.join(","),
  );
  check(
    "power actions are advisory-safe (mutate, not destructive)",
    !destructive.includes("vm.action") && !destructive.includes("backup.run"),
  );

  // ---- discovery + hardware ----------------------------------------------
  const hosts = await call("hosts.list");
  const hostList = hosts.json?.hosts ?? [];
  const hostId = hostList[0]?.id;
  check("hosts.list exposes the headless env host without secrets", hostList.length === 1 && hostList[0].label === "smoke-lab", hostList[0]?.label);
  check("hosts.list never leaks the token secret", !JSON.stringify(hosts.json ?? {}).includes("mock-secret"));

  const praetor = await call("praetor.overview");
  check(
    "praetor.overview reads the bundled rollout without SSH hosts",
    /^[a-f0-9]{64}$/.test(praetor.json?.expectedSha ?? "") &&
      Array.isArray(praetor.json?.hosts) &&
      praetor.json.hosts.length === 0 &&
      typeof praetor.json?.historyPath === "string",
    `${praetor.json?.expectedSha?.slice(0, 12)}…`,
  );
  const praetorPlan = await call("praetor.plan");
  check(
    "praetor.plan reports an empty fleet without inventing targets",
    praetorPlan.json?.totalHosts === 0 && (praetorPlan.json?.pending ?? []).length === 0,
  );
  const praetorProfiles = await call("praetor.profiles");
  check(
    "praetor.profiles reads the local profile store",
    praetorProfiles.isError === false && praetorProfiles.json?.count === 0 && typeof praetorProfiles.json?.path === "string",
  );

  // ---- PRAETOR install gate (mock fleet, no SSH) --------------------------
  // Seed one host so the gate can resolve a target. It points at a closed
  // loopback port; a gate regression would try SSH and fail visibly rather
  // than touching a real machine.
  const configPath = path.join(home, "config.json");
  const gateConfig = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {
        version: 1,
        hosts: [],
        sshHosts: [],
        settings: { pollMs: 8000, accent: "cyan", reduceMotion: false, confirmDestructive: true },
      };
  gateConfig.sshHosts = [
    {
      id: "praetor-gate-host",
      label: "praetor-gate",
      host: "127.0.0.1",
      port: 1,
      username: "root",
      authMode: "key",
      keyPath: "~/.ssh/nexus-mock-missing",
      hasSecret: false,
      color: "#38f2ff",
      createdAt: Date.now(),
    },
  ];
  writeFileSync(configPath, `${JSON.stringify(gateConfig, null, 2)}\n`, { mode: 0o600 });
  const gateConfigBefore = readFileSync(configPath, "utf8");

  const installGate = await call("praetor.install", { host: "praetor-gate" });
  check(
    "unconfirmed praetor.install is refused before SSH",
    installGate.isError === true && /confirm/i.test(installGate.json?.error ?? installGate.text),
    installGate.json?.error ?? installGate.text.slice(0, 200),
  );
  const fleetGate = await call("praetor.install_all", {});
  check(
    "unconfirmed praetor.install_all is refused before SSH",
    fleetGate.isError === true && /confirm/i.test(fleetGate.json?.error ?? fleetGate.text),
    fleetGate.json?.error ?? fleetGate.text.slice(0, 200),
  );
  const profilesAfterGate = await call("praetor.profiles");
  check(
    "refused PRAETOR installs leave config and profiles untouched",
    readFileSync(configPath, "utf8") === gateConfigBefore && profilesAfterGate.json?.count === 0,
  );

  // ---- PRAETOR status: active Proxmox firewall without a 9443 allowance -----
  // The mock SSH host answers the real status script with active PVE firewall
  // evidence. Its loopback address has no listener on 9443, so the real TCP
  // probe fails while the host still reports a listener. This must classify as
  // a firewall block, not "not listening" and not a ready rollout.
  if (!praetor.json?.expectedSha) throw new Error("initial PRAETOR overview did not return the expected bundle hash");
  const firewallHost = await pickFirewallHost();
  firewallSsh = await startMockSsh(firewallHost, firewallStatus(praetor.json.expectedSha));
  const firewallPassword = crypto.randomBytes(18).toString("base64url");
  const masterKey = crypto.randomBytes(32);
  mkdirSync(path.join(home, "keys"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, "keys", "master.key"), masterKey, { mode: 0o600 });
  gateConfig.sshHosts = [
    {
      id: "praetor-firewall-host",
      label: "praetor-firewall",
      host: firewallHost,
      port: firewallSsh.port,
      username: "root",
      authMode: "password",
      hasSecret: true,
      color: "#ff5c7a",
      createdAt: Date.now(),
      secretEnc: encryptSecret(firewallPassword, masterKey),
    },
  ];
  writeFileSync(configPath, `${JSON.stringify(gateConfig, null, 2)}\n`, { mode: 0o600 });

  const firewallOverview = await call("praetor.overview");
  const firewallHostStatus = firewallOverview.json?.hosts?.find((host) => host.hostId === "praetor-firewall-host");
  check(
    "praetor.overview reports an active Proxmox firewall with no TCP 9443 allowance as blocked",
    firewallOverview.isError === false &&
      firewallOverview.json?.hosts?.length === 1 &&
      firewallHostStatus?.state === "error" &&
      firewallHostStatus?.firewallBlocked === true &&
      firewallHostStatus?.tcpReachable === false &&
      firewallHostStatus?.portListening === true &&
      firewallHostStatus?.bindAddress === "0.0.0.0:9443" &&
      firewallHostStatus?.installedSha === praetor.json.expectedSha &&
      firewallHostStatus?.profilesOnHost === true &&
      firewallHostStatus?.publicKey === FIREWALL_PUBLIC_KEY &&
      /no TCP 9443 allow rule was found/.test(firewallHostStatus?.firewallDetail ?? "") &&
      /policy_in DROP/.test(firewallHostStatus?.firewallDetail ?? "") &&
      /TCP 9443 blocked by the Proxmox firewall/.test(firewallHostStatus?.detail ?? "") &&
      /TCP 9443 blocked by the Proxmox firewall/.test(firewallHostStatus?.error ?? ""),
    `${firewallHostStatus?.state}: ${firewallHostStatus?.firewallDetail ?? "no host"}`,
  );
  check(
    "readable firewall evidence does not trigger a sudo pass",
    firewallSsh.scripts.length === 1 && !/sudo -n/.test(firewallSsh.scripts[0] ?? ""),
    `${firewallSsh.scripts.length} status pass(es)`,
  );
  check(
    "praetor.overview records the current TCP and firewall state in history",
    firewallHostStatus?.firewallActive === true &&
      firewallHostStatus?.firewallAllow === false &&
      firewallHostStatus?.history?.length === 1 &&
      firewallHostStatus.history[0]?.tcpReachable === false &&
      firewallHostStatus.history[0]?.firewallBlocked === true &&
      firewallHostStatus.history[0]?.firewallActive === true &&
      firewallHostStatus.history[0]?.firewallAllow === false &&
      typeof firewallHostStatus.history[0]?.checkedAt === "string",
    `${firewallHostStatus?.history?.length ?? 0} checks`,
  );

  const firewallHistory = await call("praetor.overview");
  const firewallHistoryHost = firewallHistory.json?.hosts?.find((host) => host.hostId === "praetor-firewall-host");
  check(
    "praetor.overview appends TCP and firewall history across checks",
    firewallHistory.isError === false &&
      firewallHistoryHost?.history?.length === 2 &&
      firewallHistoryHost.history.every(
        (entry) =>
          entry.tcpReachable === false &&
          entry.firewallBlocked === true &&
          entry.firewallActive === true &&
          entry.firewallAllow === false,
      ) &&
      firewallHistoryHost.history[0]?.checkedAt <= firewallHistoryHost.history[1]?.checkedAt &&
      /[/\\]praetor[/\\]history\.json$/.test(firewallHistory.json?.historyPath ?? ""),
    `${firewallHistoryHost?.history?.length ?? 0} checks / ${firewallHistory.json?.historyPath ?? "no path"}`,
  );

  check(
    "the firewall block preserves the real TCP probe failure",
    /TCP .*:9443/.test(firewallHostStatus?.tcpError ?? "") &&
      !/not listening|bound only/i.test(firewallHostStatus?.tcpError ?? ""),
    firewallHostStatus?.tcpError,
  );
  check(
    "the firewall status response exposes no private key material",
    !/PRIVATE KEY|server\.key/.test(firewallOverview.text),
  );

  const firewallPlan = await call("praetor.plan");
  const firewallPending = firewallPlan.json?.pending?.[0];
  check(
    "praetor.plan keeps the firewalled host pending",
    firewallPlan.isError === false &&
      firewallPlan.json?.totalHosts === 1 &&
      firewallPlan.json?.pending?.length === 1 &&
      firewallPending?.hostId === "praetor-firewall-host" &&
      firewallPending?.state === "error" &&
      firewallPending?.firewallBlocked === true &&
      /TCP 9443 blocked by the Proxmox firewall/.test(firewallPending?.detail ?? ""),
    `${firewallPending?.state}: ${firewallPending?.detail ?? "no pending host"}`,
  );

  // ---- PRAETOR status: non-root firewall readability ----------------------
  // The normal probe reports unreadable firewall evidence. The second status
  // pass must carry sudo -n and only then reveal the active blocking rule.
  await firewallSsh.close();
  const unreadableStatus = unreadableFirewallStatus(praetor.json.expectedSha);
  firewallSsh = await startMockSsh(firewallHost, (script) =>
    /sudo -n/.test(script) ? firewallStatus(praetor.json.expectedSha) : unreadableStatus,
  );
  gateConfig.sshHosts[0].port = firewallSsh.port;
  writeFileSync(configPath, `${JSON.stringify(gateConfig, null, 2)}\n`, { mode: 0o600 });
  const elevatedOverview = await call("praetor.overview");
  const elevatedHost = elevatedOverview.json?.hosts?.find((host) => host.hostId === "praetor-firewall-host");
  check(
    "non-root status retries unreadable firewall rules with sudo -n",
    elevatedOverview.isError === false &&
      elevatedHost?.firewallBlocked === true &&
      elevatedHost?.firewallActive === true &&
      elevatedHost?.firewallAllow === false &&
      /no TCP 9443 allow rule was found/.test(elevatedHost?.firewallDetail ?? "") &&
      firewallSsh.scripts.length === 2 &&
      !/sudo -n/.test(firewallSsh.scripts[0] ?? "") &&
      /sudo -n/.test(firewallSsh.scripts[1] ?? ""),
    `${firewallSsh.scripts.length} passes / ${elevatedHost?.firewallDetail ?? "no host"}`,
  );

  const overview = await call("fleet.overview", { host: hostId });
  check(
    "fleet.overview reaches Proxmox and returns live hardware",
    overview.json?.host?.health === "online" && overview.json?.nodes?.length === 2,
    `${overview.json?.nodes?.length} nodes / ${overview.json?.vms?.total} guests`,
  );
  check("fleet.overview counts guests", overview.json?.vms?.running === 2 && overview.json?.vms?.total === 3);
  check("fleet.overview surfaces a failed task", (overview.json?.failedTasks ?? []).length >= 1);

  const node = await call("node.detail", { host: hostId, node: "pve-smoke" });
  check("node.detail returns CPU model + kernel + PVE version", /EPYC/.test(node.json?.cpuModel ?? "") && !!node.json?.kernel && !!node.json?.pveVersion);
  check("node.detail reports disks with health", (node.json?.disks ?? []).some((disk) => disk.health === "PASSED"));
  check("node.detail lists storage pools with usage", (node.json?.storage ?? []).length === 2);
  check("node.detail samples RRD history", (node.json?.rrd ?? []).length >= 10);

  const rrd = await call("node.rrd", { host: hostId, node: "pve-smoke", timeframe: "day" });
  check("node.rrd returns a series", (rrd.json?.series ?? []).length >= 10, `${rrd.json?.points} points`);

  const vms = await call("vms.list", { host: hostId });
  check("vms.list returns every guest", vms.json?.count === 3, JSON.stringify(vms.json?.vms?.map((vm) => vm.vmid)));
  const running = await call("vms.list", { host: hostId, status: "running" });
  check("vms.list filters by status", running.json?.count === 2);

  const detail = await call("vm.detail", { host: hostId, vmid: 100 });
  check("vm.detail returns config + guest-agent interfaces", detail.json?.config?.cores === 4 && detail.json?.guestAgent?.[0]?.ips?.length >= 1);
  check("vm.detail returns snapshots", (detail.json?.snapshots ?? []).length === 2);

  const tasks = await call("tasks.list", { host: hostId, state: "error" });
  check("tasks.list filters failed tasks", tasks.json?.count >= 1 && tasks.json?.tasks?.every((task) => task.state === "error"), tasks.json?.tasks?.[0]?.upid);
  const taskLog = await call("task.log", {
    host: hostId,
    node: "pve-smoke",
    upid: tasks.json?.tasks?.[0]?.upid,
  });
  check("task.log returns log lines", (taskLog.json?.lines ?? []).length === 4);

  // ---- full agent run 1: read-only health sweep ---------------------------
  const sweepStarted = await call("pipeline.run", { pipeline: "health-sweep", host: hostId, waitSeconds: 25 });
  check(
    "pipeline.run executes a read-only sweep end to end",
    sweepStarted.json?.status === "ok",
    `${sweepStarted.json?.status}: ${sweepStarted.json?.error ?? ""}`,
  );
  check(
    "health-sweep records every step",
    (sweepStarted.json?.steps ?? []).length === 3 && sweepStarted.json.steps.every((step) => step.status === "ok"),
    JSON.stringify((sweepStarted.json?.steps ?? []).map((step) => `${step.id}:${step.status}:${step.error ?? ""}`)),
  );

  // ---- full agent run 2: approval-gated fleet backup ---------------------
  const backupStarted = await call("pipeline.run", { pipeline: "backup-fleet", host: hostId, vars: { storage: "local" } });
  const backupRunId = backupStarted.json?.id;
  check("pipeline.run returns a run id immediately", typeof backupRunId === "string", backupRunId);
  const gated = await waitFor(
    async () => {
      const run = await status(backupRunId);
      return run?.status === "waiting-approval" ? run : undefined;
    },
    20000,
    "backup-fleet approval gate",
  );
  check("destructive pipeline steps pause for a human", gated.status === "waiting-approval" && gated.approval?.tool === "backup.run", gated.approval?.title);

  const declined = await call("pipeline.cancel", { runId: backupRunId });
  check("pipeline.cancel stops a paused run", declined.json?.status === "cancelled", declined.json?.status);

  const approvedStart = await call("pipeline.run", { pipeline: "backup-fleet", host: hostId, vars: { storage: "local" } });
  const approvedRunId = approvedStart.json?.id;
  await waitFor(
    async () => {
      const run = await status(approvedRunId);
      return run?.status === "waiting-approval" ? run : undefined;
    },
    20000,
    "second backup approval gate",
  );
  const approved = await call("pipeline.approve", { runId: approvedRunId, approve: true });
  check("pipeline.approve resumes the gated run", approved.json?.status === "running", approved.json?.status);
  const finished = await waitFor(
    async () => {
      const run = await status(approvedRunId);
      return run?.status === "ok" ? run : undefined;
    },
    30000,
    "fleet backup completion",
  );
  const backupStep = finished.steps.find((step) => step.id === "backup");
  check("fleet backup backs up every running guest", Array.isArray(backupStep?.output) && backupStep.output.length === 2, `${backupStep?.output?.length} guests`);
  check(
    "the approval decision is written to the run log",
    (finished.log ?? []).some((entry) => /approved/i.test(entry.message)),
  );

  // ---- direct PVE tools ---------------------------------------------------
  const stopped = await call("vm.action", { host: hostId, vmid: 102, action: "stop" });
  check("vm.action refuses a destructive action without confirm", stopped.isError === true, stopped.json?.error);
  const stopConfirmed = await call("vm.action", { host: hostId, vmid: 102, action: "stop", confirm: true });
  check("vm.action executes once confirmed", stopConfirmed.isError === false && stopConfirmed.json?.accepted === true);

  const snap = await call("snapshot.create", { host: hostId, vmid: 100, name: "smoke1", description: "smoke test" });
  check("snapshot.create creates a checkpoint", snap.isError === false && snap.json?.snapshot === "smoke1");
  const rollback = await call("snapshot.rollback", { host: hostId, vmid: 100, name: "smoke1", confirm: true });
  check("snapshot.rollback requires and accepts confirm", rollback.isError === false && rollback.json?.rolledBackTo === "smoke1");
  const snapDeleteRefused = await call("snapshot.delete", { host: hostId, vmid: 100, name: "smoke1" });
  check("snapshot.delete is gated", snapDeleteRefused.isError === true);
  const snapDelete = await call("snapshot.delete", { host: hostId, vmid: 100, name: "smoke1", confirm: true });
  check("snapshot.delete removes the checkpoint", snapDelete.isError === false);

  const backupRun = await call("backup.run", { host: hostId, node: "pve-smoke", vmid: 100, storage: "local" });
  check("backup.run starts a vzdump task", backupRun.isError === false && String(backupRun.json?.upid ?? "").startsWith("UPID:"), backupRun.json?.upid);

  const backups = await call("backup.list", { host: hostId });
  check("backup.list enumerates archives", (backups.json?.archives ?? []).length >= 2, `${backups.json?.count} archives`);
  const archive = backups.json?.archives?.[0]?.volid;
  const restore = await call("backup.restore", {
    host: hostId,
    node: "pve-smoke",
    vmid: 300,
    archive,
    storage: "local",
    type: "qemu",
    confirm: true,
  });
  check("backup.restore starts a restore task", restore.isError === false && String(restore.json?.upid ?? "").startsWith("UPID:"));

  const schedule = await call("backup.schedule.save", {
    host: hostId,
    node: "pve-smoke",
    storage: "local",
    schedule: "03:15",
    mode: "snapshot",
    compress: "zstd",
    comment: "smoke nightly",
  });
  check("backup.schedule.save persists a cluster job", schedule.isError === false && !!schedule.json?.id, schedule.json?.id);
  const scheduleDeleteRefused = await call("backup.schedule.delete", { host: hostId, id: schedule.json?.id });
  check("backup.schedule.delete is gated", scheduleDeleteRefused.isError === true);
  const scheduleDelete = await call("backup.schedule.delete", {
    host: hostId,
    id: schedule.json?.id,
    confirm: true,
  });
  check("backup.schedule.delete removes the job", scheduleDelete.isError === false);

  const bundle = await call("incident.bundle", { host: hostId, note: "smoke evidence" });
  check("incident.bundle writes an evidence file", bundle.isError === false && existsSync(bundle.json?.file), path.basename(bundle.json?.file ?? ""));

  // ---- self-development tools --------------------------------------------
  const tree = await call("dev.tree", { depth: 1 });
  check("dev.tree lists the app source", (tree.json?.files ?? []).includes("package.json"));
  const read = await call("dev.read_file", { path: "package.json" });
  check("dev.read_file reads the app manifest", read.json?.content?.includes("\"nexus-pve\""));
  const boundary = await call("dev.read_file", { path: "../outside.txt" });
  check("dev tools refuse to escape the app directory", boundary.isError === true);

  // ---- audit --------------------------------------------------------------
  const audit = await call("audit.tail", { limit: 200 });
  const auditedTools = new Set((audit.json?.entries ?? []).map((entry) => entry.tool));
  check(
    "audit.tail records every mutation",
    ["vm.action", "snapshot.create", "backup.run", "backup.restore", "pipeline.approve"].every((name) => auditedTools.has(name)),
    `${audit.json?.count} entries`,
  );
  check("audit entries are timestamped and capture failures", (audit.json?.entries ?? []).every((entry) => typeof entry.at === "string") && (audit.json?.entries ?? []).some((entry) => entry.ok === false));

  // ---- mock actually saw the Proxmox calls --------------------------------
  const actions = mock.state.actions;
  check("mock received vzdump backups for both guests", actions.filter((action) => action.type === "vzdump").length >= 3);
  check("mock received a qmrestore", actions.some((action) => action.type === "restore"));
  check("mock received the snapshot lifecycle", actions.some((action) => action.type === "snapshot") && actions.some((action) => action.type === "rollback"));
  check("mock received the confirmed VM stop", actions.some((action) => action.type === "status" && action.vmid === 102 && action.action === "stop"));
  check("mock received schedule create + delete", /POST \/api2\/json\/cluster\/backup/.test(mock.state.requests.join("\n")) && /DELETE \/api2\/json\/cluster\/backup/.test(mock.state.requests.join("\n")));

  // ---- error handling -----------------------------------------------------
  let unknownFailed = false;
  try {
    await rpc("tools/call", { name: "does.not.exist", arguments: {} });
  } catch (error) {
    unknownFailed = error.code === -32602 || /Unknown tool/.test(error.message);
  }
  check("unknown tool calls fail with a JSON-RPC error", unknownFailed);

  const missingArg = await call("backup.run", { host: hostId });
  check("tools validate required arguments", missingArg.isError === true, missingArg.json?.error);

  const pipelines = await call("pipeline.list");
  check("pipeline.list exposes every built-in pipeline", (pipelines.json?.pipelines ?? []).length >= 5);
} catch (error) {
  check("test harness completed without throwing", false, error?.stack ?? String(error));
} finally {
  if (checks.some((entry) => !entry.ok) && stderr) {
    console.log("\n--- MCP server stderr ---");
    console.log(stderr.split("\n").slice(-40).join("\n"));
  }
  await cleanup();
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((entry) => entry.name).join(" | ")}`);
  process.exit(1);
}
