#!/usr/bin/env node
/**
 * Local preflight with a machine-readable report.
 *
 * This is the local substitute for CI while GitHub Actions is unavailable. It
 * runs the same core checks, records exactly what ran, and hashes the build
 * outputs so a later release review can compare them. It is not a replacement
 * for a green workflow: the report says so explicitly.
 *
 * Usage:
 *   npm run preflight:local
 *   npm run preflight:local:packaged
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "artifacts", "preflight");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportPath = path.join(outDir, `local-preflight-${stamp}.json`);
const latestPath = path.join(outDir, "latest.json");
const withPackage = process.argv.includes("--packaged");
const startedAt = Date.now();
const steps = [];
const artifacts = {};

const npmCli = process.env.npm_execpath;
const npm = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const npmPrefix = npmCli ? [npmCli] : [];
const useShell = !npmCli && process.platform === "win32";

function tail(value, limit = 6000) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `…[${text.length - limit} chars omitted]…\n${text.slice(-limit)}`;
}

function run(name, command, args, { core = true, timeoutMs = 600_000 } = {}) {
  const start = Date.now();
  console.log(`\n[preflight] ${name}`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
    shell: useShell,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const step = {
    name,
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal ?? null,
    durationMs: Date.now() - start,
    error: result.error?.message ?? null,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
  };
  steps.push(step);
  const ok = result.status === 0 && !result.error;
  console.log(`[preflight] ${ok ? "PASS" : "FAIL"} ${name} (${(step.durationMs / 1000).toFixed(1)}s)`);
  if (!ok) {
    if (step.stderr) console.error(step.stderr);
    if (step.error) console.error(step.error);
  }
  return { ok, core };
}

function skipped(name) {
  steps.push({ name, status: "skipped", durationMs: 0, reason: "earlier core step failed" });
  console.log(`[preflight] SKIP ${name}`);
}

function installedVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

function commandVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", shell: useShell });
  return result.status === 0 ? result.stdout.trim() : null;
}

function hashFile(relativePath) {
  const file = path.join(root, relativePath);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(file));
    return { path: relativePath, bytes: stat.size, sha256: hash.digest("hex") };
  } catch {
    return null;
  }
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

const auditRuntime = run("audit:runtime", npm, [...npmPrefix, "audit", "--omit=dev", "--audit-level=high"], { core: false });
const auditFull = run("audit:full", npm, [...npmPrefix, "audit", "--audit-level=high"], { core: false });

let coreFailed = false;
const coreSteps = [
  ["typecheck", ["run", "typecheck"]],
  ["build", ["run", "build"]],
  ["tests", ["test"]],
  ["smoke", ["run", "smoke"]],
  ["smoke:agent-fabric", ["run", "smoke:agent-fabric"]],
];

for (const [name, args] of coreSteps) {
  if (coreFailed) {
    skipped(name);
    continue;
  }
  const result = run(name, npm, [...npmPrefix, ...args]);
  if (!result.ok) coreFailed = true;
}

if (withPackage) {
  for (const [name, args] of [
    ["package", ["run", "package"]],
    ["smoke:packaged", ["run", "smoke:packaged"]],
  ]) {
    if (coreFailed) {
      skipped(name);
      continue;
    }
    const result = run(name, npm, [...npmPrefix, ...args]);
    if (!result.ok) coreFailed = true;
  }
}

for (const file of [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "dist-electron/mcp-server.cjs",
  "dist/index.html",
]) {
  const hashed = hashFile(file);
  if (hashed) artifacts[file] = hashed;
}

if (withPackage) {
  const releaseDir = path.join(root, "release");
  try {
    for (const name of fs.readdirSync(releaseDir)) {
      if (!name.endsWith(".exe")) continue;
      const hashed = hashFile(path.join("release", name));
      if (hashed) artifacts[`release/${name}`] = hashed;
    }
  } catch {
    /* no release directory */
  }
}

const statusLines = (git(["status", "--porcelain"]) ?? "").split(/\r?\n/).filter(Boolean).length;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  host: {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    npm: commandVersion(npm, [...npmPrefix, "--version"]),
  },
  git: {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    head: git(["rev-parse", "HEAD"]),
    dirty: statusLines > 0,
    statusLines,
    diffFiles: (git(["diff", "--name-only"]) ?? "").split(/\r?\n/).filter(Boolean).length,
  },
  toolchain: {
    electron: installedVersion("electron"),
    electronBuilder: installedVersion("electron-builder"),
    esbuild: installedVersion("esbuild"),
    vite: installedVersion("vite"),
    typescript: installedVersion("typescript"),
  },
  packaged: withPackage,
  steps,
  artifacts,
  summary: {
    passed: steps.filter((step) => step.status === 0).length,
    failed: steps.filter((step) => step.status !== 0 && step.status !== "skipped").length,
    skipped: steps.filter((step) => step.status === "skipped").length,
    ok: steps.every((step) => step.status === 0),
  },
  note: "Local evidence only. This does not replace a green CI workflow or a signed release.",
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
fs.copyFileSync(reportPath, latestPath);

console.log(`\n[preflight] report: ${path.relative(root, reportPath)}`);
console.log(
  `[preflight] ${report.summary.ok ? "PASS" : "FAIL"}: ${report.summary.passed} passed, ` +
    `${report.summary.failed} failed, ${report.summary.skipped} skipped`,
);
if (!report.summary.ok) process.exitCode = 1;
