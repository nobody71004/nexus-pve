/**
 * Raw stdio smoke example: documented PRAETOR calls against a mock fleet.
 *
 * The example seeds a temporary Nexus home with the two-host mock fleet
 * (edge-relay and demo-dedicated), starts the real compiled MCP server, and
 * writes newline-delimited JSON-RPC directly to its stdin. It exercises the
 * documented read-only calls plus the destructive confirmation gate:
 *
 *   praetor.overview, praetor.plan, praetor.profiles,
 *   praetor.install, praetor.install_all, praetor.rotate
 *
 * The mock hosts point at a closed loopback port, so the fleet probes fail
 * fast and no SSH, Proxmox, Docker, credential or live host is touched.
 * Confirmed installs and rotations are covered by `npm run smoke:praetor`.
 *
 * Run after `npm run build:main`:
 *
 *   npm run smoke:praetor:stdio
 *   node scripts/praetor-stdio-smoke.mjs --raw
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = path.join(root, "dist-electron", "mcp-server.cjs");
const raw = process.argv.includes("--raw") || process.env.PRAETOR_STDIO_RAW === "1";
const keep = process.env.PRAETOR_STDIO_KEEP === "1";

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

if (!existsSync(serverPath)) {
  console.error(`FAIL  MCP server bundle is missing: ${serverPath}`);
  console.error("      Run `npm run build:main` before this smoke example.");
  process.exit(1);
}

const PUBLIC_KEY = crypto.randomBytes(1216).toString("base64");
const MOCK_FLEET = [
  {
    id: "ssh-edge",
    label: "edge-relay",
    host: "127.0.0.1",
    port: 1,
    username: "root",
    authMode: "key",
    keyPath: "~/.ssh/nexus-mock-missing",
    hasSecret: false,
    color: "#3dffa8",
    createdAt: Date.now() - 86_400_000 * 9,
  },
  {
    id: "ssh-dedicated",
    label: "demo-dedicated",
    host: "127.0.0.1",
    port: 1,
    username: "user",
    authMode: "key",
    keyPath: "~/.ssh/nexus-mock-missing",
    hasSecret: false,
    color: "#7c5cff",
    createdAt: Date.now() - 3_600_000,
  },
];

const SUITES = [
  ["PSEAL", "mint", true],
  ["FAST", "violet", false],
  ["BOLT", "amber", false],
  ["PMARINE", "ice", false],
];

function mockProfiles(host) {
  const endpoint = `${host.host}:9443`;
  const now = new Date().toISOString();
  return SUITES.map(([suite, color, autoConnect]) => ({
    id: `nexus-${host.id}-${suite.toLowerCase()}`,
    name: `Nexus ${host.label} ${suite}`,
    description: `Seeded ${suite} PRAETOR/1 profile for ${host.label}.`,
    location: host.label,
    endpoint,
    protocol: "PRAETOR/1",
    suite,
    transport: "tcp",
    cellSize: 1024,
    serverPublicKey: PUBLIC_KEY,
    autoConnect,
    tags: ["pq", suite.toLowerCase(), "nexus"],
    color,
    createdAt: now,
    updatedAt: now,
  }));
}

function seedHome() {
  const home = mkdtempSync(path.join(tmpdir(), "nexus-praetor-stdio-"));
  const config = {
    version: 1,
    hosts: [],
    sshHosts: MOCK_FLEET,
    settings: { pollMs: 8000, accent: "cyan", reduceMotion: false, confirmDestructive: true },
  };
  writeFileSync(path.join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const profiles = {
    version: 1,
    hosts: Object.fromEntries(
      MOCK_FLEET.map((host) => [
        host.id,
        {
          label: host.label,
          endpoint: `${host.host}:9443`,
          publicKey: PUBLIC_KEY,
          profiles: mockProfiles(host),
          updatedAt: Date.now(),
        },
      ]),
    ),
  };
  mkdirSync(path.join(home, "praetor"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, "praetor", "profiles.json"), `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 });

  // The MCP runtime starts the security guardian. Disable it in this throwaway
  // profile so an unrelated scan cannot race the PRAETOR calls.
  mkdirSync(path.join(home, "security"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, "security", "policy.json"), `${JSON.stringify({ policy: { enabled: false } }, null, 2)}\n`, {
    mode: 0o600,
  });
  return home;
}

const home = seedHome();
const profilePath = path.join(home, "praetor", "profiles.json");
const profileHashBefore = crypto.createHash("sha256").update(readFileSync(profilePath)).digest("hex");

const env = { ...process.env, NEXUS_PVE_HOME: home };
for (const key of [
  "NEXUS_PVE_URL",
  "NEXUS_PVE_TOKEN",
  "NEXUS_PVE_TOKEN_ID",
  "NEXUS_PVE_TOKEN_SECRET",
  "NEXUS_PVE_LABEL",
  "NEXUS_PVE_TLS_VERIFY",
]) {
  delete env[key];
}

const child = spawn(process.execPath, [serverPath], {
  cwd: root,
  env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
child.on("error", (error) => {
  stderr += `${error.message}\n`;
});

const pending = new Map();
let nextId = 1;
let buffer = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    if (raw) console.log(`S->C ${line}`);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined || !pending.has(message.id)) continue;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message ?? "MCP error"));
    else waiter.resolve(message.result);
  }
});

child.on("exit", (code) => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`MCP server exited (${code ?? "unknown"})${stderr ? `: ${stderr.slice(-500)}` : ""}`));
  }
  pending.clear();
});

function rpc(method, params, timeoutMs = 30_000) {
  const id = nextId++;
  const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  if (raw) console.log(`C->S ${line}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}${params?.name ? ` (${params.name})` : ""}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(`${line}\n`);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

async function call(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result?.content?.[0]?.text ?? "";
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { result, text, json, isError: result?.isError === true };
}

function refused(result) {
  return result.isError === true && /confirm/i.test(result.json?.error ?? result.text);
}

let exitCode = 0;

try {
  console.log("Mock fleet: edge-relay, demo-dedicated (closed loopback SSH ports)");
  console.log("Raw stdio calls are newline-delimited JSON-RPC on stdin/stdout.");

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "praetor-stdio-smoke", version: "1" },
  });
  check("initialize identifies nexus-pve", init?.serverInfo?.name === "nexus-pve", init?.serverInfo?.name);

  const list = await rpc("tools/list", {});
  const names = (list?.tools ?? []).map((tool) => tool.name);
  const required = [
    "praetor.overview",
    "praetor.plan",
    "praetor.profiles",
    "praetor.install",
    "praetor.install_all",
    "praetor.rotate",
  ];
  const missing = required.filter((name) => !names.includes(name));
  check("tools/list exposes the PRAETOR surface", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${names.length} tools`);

  const overview = await call("praetor.overview");
  const hosts = overview.json?.hosts ?? [];
  check(
    "praetor.overview reads the two-host mock fleet",
    overview.isError === false && hosts.length === 2 && /^[a-f0-9]{64}$/.test(overview.json?.expectedSha ?? ""),
    `${hosts.length} hosts / ${overview.json?.expectedSha?.slice(0, 12)}…`,
  );
  check(
    "praetor.overview returns four pinned profiles per host",
    hosts.every(
      (host) =>
        host.profiles?.length === 4 &&
        host.profiles.every((profile) => profile.serverPublicKey === PUBLIC_KEY),
    ),
    `${hosts.reduce((total, host) => total + (host.profiles?.length ?? 0), 0)} profiles`,
  );
  check(
    "praetor.overview returns public material only",
    overview.isError === false && !/PRIVATE KEY|server\.key/.test(overview.text),
  );
  check(
    "profile store stays inside the throwaway home",
    path.resolve(overview.json?.profilesPath ?? "") === path.resolve(profilePath),
    overview.json?.profilesPath,
  );
  check(
    "praetor.overview retains TCP and firewall history",
    hosts.every(
      (host) =>
        Array.isArray(host.history) &&
        host.history.length === 1 &&
        host.history.every((entry) => entry.tcpReachable === false && typeof entry.firewallBlocked === "boolean"),
    ),
    `${hosts.reduce((total, host) => total + (host.history?.length ?? 0), 0)} checks`,
  );
  check(
    "check history stays inside the throwaway home",
    path.resolve(overview.json?.historyPath ?? "") === path.resolve(path.join(home, "praetor", "history.json")),
    overview.json?.historyPath,
  );

  const plan = await call("praetor.plan");
  check(
    "praetor.plan sees both mock hosts as pending",
    plan.isError === false && plan.json?.totalHosts === 2 && plan.json?.pending?.length === 2,
    `${plan.json?.totalHosts} hosts / ${plan.json?.pending?.length} pending`,
  );

  const profiles = await call("praetor.profiles");
  check(
    "praetor.profiles exports all eight seeded pins",
    profiles.isError === false && profiles.json?.count === 8,
    `${profiles.json?.count} profiles`,
  );

  const oneHost = await call("praetor.profiles", { host: "edge-relay" });
  check(
    "praetor.profiles resolves a host label to four pins",
    oneHost.isError === false && oneHost.json?.count === 4,
    `${oneHost.json?.count} profiles / ${oneHost.json?.hostId}`,
  );

  const installRefused = await call("praetor.install", { host: "edge-relay" });
  check("praetor.install refuses without confirm", refused(installRefused), installRefused.json?.error ?? installRefused.text.slice(0, 160));

  const fleetRefused = await call("praetor.install_all", {});
  check("praetor.install_all refuses the fleet without confirm", refused(fleetRefused), fleetRefused.json?.error ?? fleetRefused.text.slice(0, 160));

  const subsetRefused = await call("praetor.install_all", { hosts: ["edge-relay"] });
  check("praetor.install_all refuses a subset without confirm", refused(subsetRefused), subsetRefused.json?.error ?? subsetRefused.text.slice(0, 160));

  const rotateRefused = await call("praetor.rotate", { host: "edge-relay" });
  check("praetor.rotate refuses without confirm", refused(rotateRefused), rotateRefused.json?.error ?? rotateRefused.text.slice(0, 160));

  const profileHashAfter = crypto.createHash("sha256").update(readFileSync(profilePath)).digest("hex");
  check("refused calls leave the pin bundle untouched", profileHashAfter === profileHashBefore);

  const audit = await call("audit.tail", { limit: 50 });
  const audited = new Set((audit.json?.entries ?? []).map((entry) => entry.tool));
  check(
    "audit.tail records the refused destructive calls",
    ["praetor.install", "praetor.install_all", "praetor.rotate"].every((name) => audited.has(name)),
    `${audit.json?.count ?? 0} entries`,
  );

  if (!raw) {
    console.log("\nDocumented raw calls used by this example:");
    console.log('  {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"praetor.overview","arguments":{}}}');
    console.log('  {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"praetor.plan","arguments":{}}}');
    console.log('  {"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"praetor.profiles","arguments":{"host":"edge-relay"}}}');
    console.log('  {"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"praetor.rotate","arguments":{"host":"edge-relay"}}}');
    console.log("  …destructive calls omit confirm, so the MCP gate refuses them.");
    console.log("Run with --raw to print the full JSON-RPC transcript.");
  }
} catch (error) {
  check("stdio smoke completed without throwing", false, error instanceof Error ? error.message : String(error));
} finally {
  if (checks.some((entry) => !entry.ok) && stderr) {
    console.log("\n--- MCP server stderr ---");
    console.log(stderr.split("\n").slice(-40).join("\n"));
  }
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  if (keep) console.log(`KEEP home=${home}`);
  else rmSync(home, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((entry) => entry.name).join(" | ")}`);
  exitCode = 1;
}
process.exit(exitCode);
