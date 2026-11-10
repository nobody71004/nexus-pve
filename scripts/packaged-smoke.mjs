/**
 * Packaged EXE smoke test.
 *
 * 1. launches the packaged Electron executable with an isolated home and
 *    Electron user-data directory,
 * 2. lets the main process seed a local admin profile, then waits for the
 *    renderer to reach the authenticated workspace,
 * 3. validates the renderer/auth report written by the app, and
 * 4. drives the packaged MCP server over stdio.
 *
 * The test never contacts Proxmox or SSH hosts and leaves no state in the
 * user's real Nexus profile.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const exeArg = process.argv.find((arg) => arg.startsWith("--exe="));
const exe = path.resolve(
  process.env.NEXUS_PVE_EXE ??
    (exeArg ? exeArg.slice("--exe=".length) : path.join(root, "release", "win-unpacked", "NexusPVE.exe")),
);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* the cleanup path must not hide the test result */
  }
}

function removeWorkspace(target) {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (error) {
    // Electron can hold user-data handles for a moment after exit; a leftover
    // temp directory must not turn a passing run into a failing one.
    console.warn(`could not remove ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function packagedMcpServer(exePath) {
  const beside = path.join(path.dirname(exePath), "resources", "app.asar.unpacked", "dist-electron", "mcp-server.cjs");
  if (existsSync(beside)) return beside;
  return path.join(root, "release", "win-unpacked", "resources", "app.asar.unpacked", "dist-electron", "mcp-server.cjs");
}

function runMcpDiagnostic(serverPath, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: root,
      env: { ...process.env, NEXUS_PVE_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let nextId = 1;
    const pending = new Map();
    const timer = setTimeout(() => {
      stopTree(child);
      reject(new Error(`MCP diagnostic timed out\n${stderr}`));
    }, 45_000);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
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
          const item = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(item.timer);
          if (message.error) item.reject(new Error(message.error.message));
          else item.resolve(message.result);
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    const rpc = (method, params, timeoutMs = 15_000) => {
      const id = nextId++;
      return new Promise((rpcResolve, rpcReject) => {
        const rpcTimer = setTimeout(() => {
          pending.delete(id);
          rpcReject(new Error(`timeout waiting for ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve: rpcResolve, reject: rpcReject, timer: rpcTimer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    };

    (async () => {
      const init = await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "packaged-smoke", version: "1" },
      });
      const list = await rpc("tools/list", {});
      const result = await rpc("tools/call", { name: "praetor.overview", arguments: {} });
      const overview = JSON.parse(result?.content?.[0]?.text ?? "{}");
      resolve({ init, names: (list?.tools ?? []).map((tool) => tool.name), overview });
    })()
      .then(async (value) => {
        clearTimeout(timer);
        child.stdin.end();
        await Promise.race([
          new Promise((exit) => child.once("exit", exit)),
          sleep(5_000).then(() => stopTree(child)),
        ]);
        resolve(value);
      })
      .catch(async (error) => {
        clearTimeout(timer);
        stopTree(child);
        reject(error);
      });
  });
}

const workspace = mkdtempSync(path.join(tmpdir(), "nexus-packaged-smoke-"));
const home = path.join(workspace, "home");
const userData = path.join(workspace, "user-data");
const mcpHome = path.join(workspace, "mcp-home");
const reportPath = path.join(workspace, "report.json");
mkdirSync(home, { recursive: true });
mkdirSync(userData, { recursive: true });
mkdirSync(mcpHome, { recursive: true });

let child = null;
try {
  check("packaged executable exists", existsSync(exe), exe);

  child = spawn(exe, [], {
    cwd: root,
    env: {
      ...process.env,
      NEXUS_PVE_HOME: home,
      NEXUS_PVE_SMOKE_USER_DATA: userData,
      NEXUS_PVE_SMOKE_REPORT: reportPath,
      NEXUS_PVE_SMOKE_PASSWORD: "smoke-owner-password",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("error", (error) => {
    stderr += `spawn error: ${error.message}\n`;
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !existsSync(reportPath)) {
    if (child.exitCode !== null) break;
    await sleep(200);
  }
  if (!existsSync(reportPath)) {
    stopTree(child);
    throw new Error(`packaged app did not write a smoke report\n${stdout}\n${stderr}`);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`could not read smoke report: ${error instanceof Error ? error.message : String(error)}`);
  }

  check("smoke report completed", report.ok === true, report.error ?? "");
  check(
    "packaged app reports the package version",
    report.version === packageVersion,
    `${report.version ?? "missing"} / ${packageVersion}`,
  );
  check(
    "renderer loaded the packaged document",
    report.renderer?.title === "Nexus PVE" && report.renderer?.root === true && report.renderer?.bridge === true,
    report.renderer?.title,
  );
  check(
    "test profile was seeded",
    report.profile?.seeded === true &&
      report.profile?.username === "smoke-owner" &&
      report.profile?.role === "admin",
    report.profile ? `${report.profile.username}/${report.profile.role}` : "no profile report",
  );
  check(
    "renderer authenticated into the seeded profile",
    report.renderer?.auth?.initialized === true && report.renderer?.auth?.user?.username === "smoke-owner",
    report.renderer?.auth?.user?.username ?? report.renderer?.auth?.error ?? "missing auth state",
  );
  check(
    "renderer drew the workspace shell",
    typeof report.renderer?.text === "string" &&
      report.renderer.text.includes("Fleet overview") &&
      Array.isArray(report.renderer?.nav) &&
      report.renderer.nav.includes("Fleet overview") &&
      report.renderer.nav.includes("Praetor egress"),
    Array.isArray(report.renderer?.nav) ? report.renderer.nav.join(", ") : "no nav reported",
  );
  check(
    "main process reported the packaged MCP server",
    report.mcp?.serverPresent === true && report.mcp?.toolCount >= 60,
    `${report.mcp?.toolCount ?? 0} tools`,
  );

  const mcpServer = packagedMcpServer(exe);
  check("packaged MCP server file exists", existsSync(mcpServer), mcpServer);
  if (existsSync(mcpServer)) {
    const mcp = await runMcpDiagnostic(mcpServer, mcpHome);
    const required = ["praetor.overview", "praetor.plan", "praetor.profiles", "praetor.install", "praetor.install_all", "praetor.rotate"];
    check("MCP initialize identifies nexus-pve", mcp.init?.serverInfo?.name === "nexus-pve");
    check(
      "MCP exposes the PRAETOR tool surface",
      required.every((name) => mcp.names.includes(name)),
      `${mcp.names.length} tools`,
    );
    check(
      "MCP PRAETOR overview reads the packaged bundle",
      /^[a-f0-9]{64}$/.test(mcp.overview?.expectedSha ?? ""),
      mcp.overview?.error ?? "",
    );
    check(
      "app and MCP report the same tool count",
      report.mcp?.toolCount === mcp.names.length,
      `${report.mcp?.toolCount ?? 0} / ${mcp.names.length}`,
    );
  }
} catch (error) {
  check("packaged smoke harness completed", false, error instanceof Error ? error.message : String(error));
} finally {
  stopTree(child);
  removeWorkspace(workspace);
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((entry) => entry.name).join(" | ")}`);
  process.exit(1);
}
