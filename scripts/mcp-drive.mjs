/**
 * Drive the live MCP server with a plan of tool calls, in one session.
 *
 *   node scripts/mcp-drive.mjs '[{"name":"ssh.hosts","args":{}}]'
 *   node scripts/mcp-drive.mjs --file plan.json --full
 *
 * Each call runs in order against the real config (NEXUS_PVE_HOME). A failed
 * call is reported and the plan continues, so one broken step does not hide the
 * rest; the exit code is non-zero when anything failed.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = path.join(root, "dist-electron", "mcp-server.cjs");
const argv = process.argv.slice(2);
const full = argv.includes("--full");
const fileIndex = argv.indexOf("--file");
const planText = fileIndex >= 0 ? readFileSync(argv[fileIndex + 1], "utf8") : argv.find((arg) => arg.trim().startsWith("["));
if (!planText) {
  console.error("usage: node scripts/mcp-drive.mjs '[{\"name\":\"ssh.hosts\",\"args\":{}}]'");
  process.exit(2);
}
if (!existsSync(serverPath)) {
  console.error(`missing ${serverPath} — run: npm run build:main`);
  process.exit(2);
}

const plan = JSON.parse(planText);
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
    waiter(message);
  }
});

function rpc(method, params, timeoutMs = 900_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    waiters.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const results = [];
try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-drive", version: "1" } });
  for (const step of plan) {
    const started = Date.now();
    const message = await rpc("tools/call", { name: step.name, arguments: step.args ?? {} });
    const ms = Date.now() - started;
    const text = message.result?.content?.[0]?.text ?? JSON.stringify(message.error ?? {});
    const isError = message.result?.isError === true || Boolean(message.error);
    const payload = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    })();
    results.push({ name: step.name, ok: !isError, ms, payload });
    const label = `${step.name} ${step.args?.host ? `(${step.args.host})` : ""}`;
    if (isError) {
      console.log(`FAIL  ${label}  ${ms}ms`);
      console.log(`      ${(payload.error ?? text).toString().slice(0, 700).replace(/\n/g, "\n      ")}`);
    } else {
      console.log(`PASS  ${label}  ${ms}ms  ${summary(payload)}`);
      if (full) console.log(JSON.stringify(payload, null, 2));
    }
  }
} catch (error) {
  console.error(`drive failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  await new Promise((resolve) => setTimeout(resolve, 200));
  child.kill();
}

function summary(payload) {
  if (payload === null || typeof payload !== "object") return String(payload ?? "");
  const keys = Object.keys(payload);
  if ("output" in payload) return String(payload.output).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 160);
  if ("lines" in payload) return `${payload.lines.length} log line(s)`;
  if ("systemd" in payload) {
    return `${payload.systemd.total} units (${payload.systemd.running} running, ${payload.systemd.failed} failed), ${payload.docker?.containers?.length ?? 0} container(s)`;
  }
  if ("unit" in payload) return `${payload.unit} state=${payload.state ?? payload.active ?? "?"} enabled=${payload.enabled ?? "?"}`;
  if ("packages" in payload) return `${payload.action ?? "packages"}: ${payload.packages.join(",")}`;
  return keys.slice(0, 6).join(",").slice(0, 160);
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length > 0) process.exitCode = 1;
