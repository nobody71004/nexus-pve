/**
 * MCP integration test: confirmed PRAETOR fleet install.
 *
 * The test owns a disposable Ubuntu systemd container with OpenSSH. It seeds a
 * temporary Nexus home with one password-auth host, starts the real compiled MCP
 * server, and calls praetor.install_all twice:
 *
 *   1. without confirm -> the MCP gate must refuse and leave the host untouched;
 *   2. with confirm    -> the real SSH installer must install PRAETOR, start the
 *                         egress unit, write four profiles and return ready.
 *
 * The fixture is destroyed in finally. No live host, desktop profile or real
 * credential is touched. Docker is required; the test skips when it is missing
 * unless PRAETOR_TEST_REQUIRE_DOCKER=1 is set.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "ssh2";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = path.join(root, "dist-electron", "mcp-server.cjs");
const keepFixture = process.env.PRAETOR_TEST_KEEP === "1";
const requireDocker = process.env.PRAETOR_TEST_REQUIRE_DOCKER === "1";

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const state = {
  container: "",
  image: "",
  fixtureDir: "",
  home: "",
  mcp: null,
  mcpStderr: "",
};

function run(command, args, options = {}) {
  const { timeoutMs = 120_000, ...rest } = options;
  return spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    ...rest,
  });
}

function docker(args, options = {}) {
  const result = run("docker", args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(`docker ${args.join(" ")} failed${result.status === null ? "" : ` (${result.status})`}\n${detail}`);
  }
  return (result.stdout ?? "").trim();
}

function dockerInfo() {
  const result = run("docker", ["info", "--format", "{{.OSType}}"], { timeoutMs: 15_000 });
  if (result.error || result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function skipOrFail(message) {
  if (requireDocker) {
    console.error(`FAIL  ${message}`);
    process.exit(1);
  }
  console.log(`SKIP  ${message}`);
  process.exit(0);
}

function encryptSecret(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${data.toString("base64")}`;
}

function seedHome(port, password) {
  const home = mkdtempSync(path.join(tmpdir(), "nexus-praetor-smoke-"));
  const keyDir = path.join(home, "keys");
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  writeFileSync(path.join(keyDir, "master.key"), key, { mode: 0o600 });
  const hostId = "praetor-smoke-host";
  const config = {
    version: 1,
    hosts: [],
    sshHosts: [
      {
        id: hostId,
        label: "praetor-smoke",
        host: "127.0.0.1",
        port,
        username: "root",
        authMode: "password",
        hasSecret: true,
        color: "#38f2ff",
        createdAt: Date.now(),
        secretEnc: encryptSecret(password, key),
      },
    ],
    settings: { pollMs: 8000, accent: "cyan", reduceMotion: false, confirmDestructive: true },
  };
  const configPath = path.join(home, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  // The MCP runtime starts the security guardian. Disable it in this throwaway
  // profile so an unrelated scan cannot race the PRAETOR install.
  mkdirSync(path.join(home, "security"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, "security", "policy.json"), JSON.stringify({ policy: { enabled: false } }, null, 2), {
    mode: 0o600,
  });
  return { home, hostId, configPath };
}

function buildFixture() {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "nexus-praetor-image-"));
  state.fixtureDir = fixtureDir;
  const image = `nexus-praetor-smoke:${process.pid}-${Date.now()}`;
  state.image = image;
  const dockerfile = `FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker
RUN echo '#!/bin/sh' > /usr/sbin/policy-rc.d && echo 'exit 101' >> /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server systemd systemd-sysv dbus ca-certificates curl xz-utils iproute2 procps && rm -rf /var/lib/apt/lists/* && ssh-keygen -A
RUN rm -f /usr/sbin/policy-rc.d
RUN rm -f /etc/ssh/sshd_config.d/*.conf && echo 'PermitRootLogin yes' > /etc/ssh/sshd_config.d/99-praetor-smoke.conf && echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config.d/99-praetor-smoke.conf && echo 'UsePAM yes' >> /etc/ssh/sshd_config.d/99-praetor-smoke.conf && (systemctl enable ssh.service >/dev/null 2>&1 || true)
EXPOSE 22
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
`;
  writeFileSync(path.join(fixtureDir, "Dockerfile"), dockerfile);
  console.log("Building disposable Ubuntu SSH fixture…");
  const result = run("docker", ["build", "--tag", image, "--file", "Dockerfile", fixtureDir], {
    timeoutMs: 600_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-4000);
    throw new Error(`could not build the PRAETOR SSH fixture\n${detail}`);
  }
  return image;
}

function startContainer(image) {
  const name = `nexus-praetor-smoke-${process.pid}-${Date.now()}`;
  state.container = name;
  docker(
    [
      "run",
      "--detach",
      "--name",
      name,
      "--privileged",
      "--cgroupns=host",
      "--security-opt",
      "seccomp=unconfined",
      "--tmpfs",
      "/run",
      "--tmpfs",
      "/run/lock",
      "-v",
      "/sys/fs/cgroup:/sys/fs/cgroup:rw",
      "-p",
      "127.0.0.1::22",
      image,
    ],
    { timeoutMs: 60_000 },
  );
  return name;
}

function waitForSystemd() {
  let last = "";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = run("docker", ["exec", state.container, "systemctl", "is-system-running"], {
      timeoutMs: 5_000,
    });
    last = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (/^(running|degraded)$/m.test(last)) return last;
    sleepSync(1_000);
  }
  throw new Error(`systemd did not become ready in the fixture\n${last.slice(-1000)}`);
}

function waitForPort() {
  let last = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = run("docker", ["port", state.container, "22/tcp"], { timeoutMs: 5_000 });
    last = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const portText = last.trim().split(":").pop()?.trim();
    const port = Number(portText);
    if (portText && Number.isInteger(port) && port > 0) return port;
    sleepSync(500);
  }
  throw new Error(`SSH port was not published by the fixture\n${last}`);
}

function startSsh(port, password) {
  const passwordResult = run("docker", ["exec", "-i", state.container, "chpasswd"], {
    input: `root:${password}\n`,
    timeoutMs: 15_000,
  });
  if (passwordResult.error) throw passwordResult.error;
  if (passwordResult.status !== 0) {
    throw new Error(`could not set the fixture root password\n${passwordResult.stderr ?? ""}`);
  }

  const started = run("docker", ["exec", state.container, "systemctl", "start", "ssh.service"], {
    timeoutMs: 30_000,
  });
  if (started.status !== 0) {
    throw new Error(`fixture ssh.service did not start\n${started.stdout ?? ""}\n${started.stderr ?? ""}`);
  }

  const sshd = run("docker", ["exec", state.container, "sshd", "-T"], { timeoutMs: 15_000 });
  const effective = `${sshd.stdout ?? ""}\n${sshd.stderr ?? ""}`;
  if (sshd.status !== 0 || !/^permitrootlogin yes$/m.test(effective) || !/^passwordauthentication yes$/m.test(effective)) {
    throw new Error(`fixture sshd did not expose password root login\n${effective.slice(-1500)}`);
  }
  return port;
}

async function waitForSsh(port, password) {
  const deadline = Date.now() + 60_000;
  let lastError = "";
  while (Date.now() < deadline) {
    const result = await new Promise((resolve) => {
      const conn = new Client();
      let settled = false;
      const finish = (ok, error) => {
        if (settled) return;
        settled = true;
        try {
          conn.end();
        } catch {
          /* already closed */
        }
        resolve({ ok, error });
      };
      conn.on("ready", () => finish(true));
      conn.on("error", (error) => finish(false, error.message));
      conn.connect({ host: "127.0.0.1", port, username: "root", password, readyTimeout: 4_000 });
      setTimeout(() => finish(false, "ready timeout"), 5_000);
    });
    if (result.ok) return;
    lastError = result.error ?? "SSH not ready";
    await sleep(1_000);
  }
  throw new Error(`fixture SSH did not accept the seeded password: ${lastError}`);
}

function startMcp(home) {
  if (!existsSync(serverPath)) {
    throw new Error(`MCP server bundle is missing: ${serverPath}. Run npm run build:main first.`);
  }
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
  state.mcp = spawn(process.execPath, [serverPath], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  state.mcp.stderr.on("data", (chunk) => {
    state.mcpStderr += chunk.toString();
  });

  let buffer = "";
  const pending = new Map();
  let nextId = 1;

  state.mcp.stdout.setEncoding("utf8");
  state.mcp.stdout.on("data", (chunk) => {
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
      if (message.id === undefined || !pending.has(message.id)) continue;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message ?? "MCP error"));
      else waiter.resolve(message.result);
    }
  });

  state.mcp.on("exit", (code) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP server exited (${code ?? "unknown"})${state.mcpStderr ? `: ${state.mcpStderr.slice(-500)}` : ""}`));
    }
    pending.clear();
  });
  state.mcp.on("error", (error) => {
    state.mcpStderr += `${error.message}\n`;
  });

  state.rpc = (method, params, timeoutMs = 30_000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}${params?.name ? ` (${params.name})` : ""}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        state.mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };
  state.call = async (name, args = {}, timeoutMs = 30_000) => {
    const result = await state.rpc("tools/call", { name, arguments: args }, timeoutMs);
    const text = result?.content?.[0]?.text ?? "";
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { result, text, json, isError: result?.isError === true };
  };
}

function stopMcp() {
  if (!state.mcp) return;
  try {
    state.mcp.kill();
  } catch {
    /* already gone */
  }
  state.mcp = null;
}

function cleanup() {
  stopMcp();
  if (state.container && !keepFixture) {
    run("docker", ["rm", "-f", state.container], { timeoutMs: 30_000 });
  }
  if (state.image && !keepFixture) {
    run("docker", ["rmi", "-f", state.image], { timeoutMs: 30_000 });
  }
  if (state.home && !keepFixture) rmSync(state.home, { recursive: true, force: true });
  if (state.fixtureDir) rmSync(state.fixtureDir, { recursive: true, force: true });
  if (keepFixture) {
    console.log(`KEEP  container=${state.container || "(none)"} home=${state.home || "(none)"} image=${state.image || "(none)"}`);
  }
}

function fixtureLogs() {
  if (!state.container) return;
  const logs = run("docker", ["logs", "--tail", "80", state.container], { timeoutMs: 20_000 });
  const text = `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`.trim();
  if (text) {
    console.log("\n--- disposable host logs ---");
    console.log(text.split("\n").slice(-80).join("\n"));
  }
}

const dockerType = dockerInfo();
if (!dockerType) {
  skipOrFail("Docker is not available; the PRAETOR install integration test needs a disposable Linux SSH container.");
}
if (dockerType !== "linux") {
  skipOrFail(`Docker is using ${dockerType} containers; the PRAETOR fixture needs Linux containers.`);
}
if (!existsSync(serverPath)) {
  console.error(`FAIL  MCP server bundle is missing: ${serverPath}. Run npm run build:main first.`);
  process.exit(1);
}

try {
  const image = buildFixture();
  startContainer(image);
  const systemd = waitForSystemd();
  check("disposable Ubuntu fixture reaches systemd", /^(running|degraded)$/m.test(systemd), systemd);
  const port = waitForPort();
  const password = crypto.randomBytes(18).toString("base64url");
  startSsh(port, password);
  await waitForSsh(port, password);
  check("disposable SSH host accepts the seeded root login", true, `127.0.0.1:${port}`);

  const seeded = seedHome(port, password);
  state.home = seeded.home;
  const configText = readFileSync(seeded.configPath, "utf8");
  check("seeded SSH password is encrypted at rest", !configText.includes(password));
  check("MCP server bundle is present", existsSync(serverPath), path.relative(root, serverPath));

  startMcp(seeded.home);
  const init = await state.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "praetor-install-smoke", version: "1" },
  });
  check("MCP initialize identifies nexus-pve", init?.serverInfo?.name === "nexus-pve", init?.serverInfo?.name);

  const tools = await state.rpc("tools/list", {});
  const names = (tools?.tools ?? []).map((tool) => tool.name);
  check("MCP exposes the PRAETOR fleet tools", names.includes("praetor.overview") && names.includes("praetor.install_all"));

  const plan = await state.call("praetor.plan");
  check(
    "fleet plan sees exactly one disposable host",
    plan.isError === false && plan.json?.totalHosts === 1 && plan.json?.pending?.length === 1,
    `${plan.json?.totalHosts} hosts / ${plan.json?.pending?.length} pending`,
  );

  const refused = await state.call("praetor.install_all", {});
  check(
    "unconfirmed fleet install is refused by the MCP gate",
    refused.isError === true && /confirm/i.test(refused.json?.error ?? refused.text),
    refused.json?.error ?? refused.text.slice(0, 200),
  );
  const untouched = run("docker", ["exec", state.container, "sh", "-c", "test ! -e /opt/praetor-egress"], {
    timeoutMs: 10_000,
  });
  check("refused install leaves the host untouched", untouched.status === 0);

  const installed = await state.call("praetor.install_all", { confirm: true }, 600_000);
  const result = installed.json?.results?.[0];
  check(
    "confirmed fleet install succeeds",
    installed.isError === false &&
      installed.json?.ok === true &&
      installed.json?.total === 1 &&
      installed.json?.installed === 1 &&
      installed.json?.failed === 0,
    installed.isError ? installed.text.slice(-800) : `${installed.json?.installed}/${installed.json?.total} installed`,
  );
  check(
    "confirmed result is ready with four profiles",
    result?.ok === true && result?.state === "ready" && result?.profileCount === 4 && Boolean(result?.publicKey),
    result?.error ?? `${result?.state} / ${result?.profileCount} profiles / route ${result?.route}`,
  );

  const overview = await state.call("praetor.overview");
  const host = overview.json?.hosts?.[0];
  check(
    "fleet status reports the installed egress as ready",
    overview.isError === false &&
      host?.state === "ready" &&
      host?.profilesOnHost === true &&
      host?.profiles?.length === 4 &&
      host?.installedSha === overview.json?.expectedSha,
    `${host?.state} / SHA ${host?.installedSha?.slice(0, 12)}… / ${host?.profiles?.length} profiles`,
  );
  check("fleet status reports the installed Node and public key", Boolean(host?.nodeVersion) && host?.publicKey === result?.publicKey);
  check("fleet status does not expose private key material", !/PRIVATE KEY/.test(overview.text));

  const profiles = await state.call("praetor.profiles");
  check("profile export returns four PRAETOR Command profiles", profiles.isError === false && profiles.json?.count === 4, `${profiles.json?.count} profiles`);

  const active = run("docker", ["exec", state.container, "systemctl", "is-active", "praetor-egress.service"], {
    timeoutMs: 15_000,
  });
  check("egress systemd unit is active", active.status === 0 && active.stdout.trim() === "active", active.stdout.trim());

  const listening = run("docker", ["exec", state.container, "sh", "-c", "ss -lnt 2>/dev/null | grep -q ':9443 '"], {
    timeoutMs: 10_000,
  });
  check("egress is listening on TCP 9443", listening.status === 0);

  const keyMode = run("docker", ["exec", state.container, "stat", "-c", "%a", "/opt/praetor-egress/server.key"], {
    timeoutMs: 10_000,
  });
  check("private egress key is mode 0600", keyMode.status === 0 && keyMode.stdout.trim() === "600", keyMode.stdout.trim());

  const audit = await state.call("audit.tail", { limit: 100 });
  const entries = audit.json?.entries ?? [];
  check(
    "audit records the refused call and the confirmed install",
    entries.some((entry) => entry.tool === "praetor.install_all" && entry.ok === false) &&
      entries.some((entry) => entry.tool === "praetor.install_all" && entry.ok === true),
    `${entries.length} entries`,
  );
} catch (error) {
  check("PRAETOR install integration completed without throwing", false, error instanceof Error ? error.message : String(error));
} finally {
  if (checks.some((entry) => !entry.ok)) fixtureLogs();
  cleanup();
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((entry) => entry.name).join(" | ")}`);
  process.exit(1);
}
