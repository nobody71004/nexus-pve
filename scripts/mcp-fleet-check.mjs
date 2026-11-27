/**
 * Live MCP connectivity check.
 *
 * Spawns the real `dist-electron/mcp-server.cjs` over stdio JSON-RPC using the
 * desktop app's own config (NEXUS_PVE_HOME), then asks the server what it can
 * see: the tool inventory, every configured Linux host and the privileged
 * helper state on each one. Read-only — it never mutates a host.
 *
 *   node scripts/mcp-fleet-check.mjs              # fleet summary
 *   node scripts/mcp-fleet-check.mjs --status     # also collect ssh.status
 *   node scripts/mcp-fleet-check.mjs --call ssh.services --args '{"host":"k80"}'
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = process.env.NEXUS_MCP_SERVER || path.join(root, "dist-electron", "mcp-server.cjs");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

if (!existsSync(serverPath)) {
  console.error(`missing ${serverPath} — run: npm run build:main`);
  process.exit(2);
}

const home = process.env.NEXUS_PVE_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "NexusPVE");
const child = spawn(process.execPath, [serverPath], {
  cwd: root,
  env: { ...process.env, NEXUS_PVE_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const waiters = new Map();
let nextId = 1;
let buffer = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const waiter = waiters.get(message.id);
    if (!waiter) continue;
    waiters.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }
});

function rpc(method, params, timeoutMs = 180_000) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    waiters.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(`${payload}\n`);
  });
}

/** Calls a tool and returns the decoded payload or throws the tool's error. */
async function callTool(name, args = {}, timeoutMs) {
  const result = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  const text = result?.content?.[0]?.text ?? "{}";
  const payload = JSON.parse(text);
  if (result.isError) throw new Error(payload.error || `${name} failed`);
  return payload;
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-fleet-check", version: "1.0.0" },
  });
  check("initialize", Boolean(init?.serverInfo?.name), `${init?.serverInfo?.name} v${init?.serverInfo?.version}`);

  const listed = await rpc("tools/list", {});
  const tools = listed?.tools ?? [];
  check("tools/list", tools.length > 0, `${tools.length} tools`);

  const oneOff = option("--call", "");
  if (oneOff) {
    const payload = await callTool(oneOff, JSON.parse(option("--args", "{}")));
    console.log(JSON.stringify(payload, null, 2));
    finish();
  } else {
    const inventory = await callTool("ssh.hosts", {});
    check("ssh.hosts", inventory.count > 0, `${inventory.count} host(s)`);

    console.log("\nHost                          Target                              Helper");
    console.log("-".repeat(92));
    for (const host of inventory.hosts) {
      const short = host.target.replace(/^.*@/, "").replace(/:\d+$/, "");
      let helper = "n/a";
      try {
        const state = await callTool("ssh.helper", { host: host.id }, 90_000);
        helper = `${state.state ?? "unknown"} (route: ${state.route ?? "none"})`;
        if (state.state !== "current" && state.state !== "outdated") {
          helper = `${helper} — ${(state.reason ?? state.error ?? "").toString().slice(0, 42)}`;
        }
      } catch (error) {
        helper = `error: ${error.message.slice(0, 40)}`;
      }
      console.log(`${host.label.padEnd(28)}  ${short.padEnd(34)}  ${helper}`);
      if (flag("--status")) {
        try {
          const status = await callTool("ssh.status", { host: host.id }, 180_000);
          console.log(
            `  status: ${status.identity?.hostname ?? "?"} · ${status.identity?.distro ?? "?"} · up ${status.identity?.uptimeHours}h · ${status.failedUnits?.length ?? 0} failed unit(s)`,
          );
        } catch (error) {
          console.log(`  status: FAILED — ${error.message.slice(0, 90)}`);
        }
      }
    }
    finish();
  }
} catch (error) {
  console.error(`\nMCP drive failed: ${error.message}`);
  if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-6).join("\n"));
  process.exitCode = 1;
  finish();
}

function finish() {
  child.stdin.end();
  setTimeout(() => {
    child.kill();
    const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    if (stderr.trim()) {
      console.log("\nserver log:");
      console.log(stderr.trim().split("\n").slice(0, 8).join("\n"));
    }
    process.exit(failed.length > 0 ? 1 : 0);
  }, 250);
}
