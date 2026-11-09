/**
 * MCP integration test: confirmed PRAETOR fleet install.
 *
 * The test owns two disposable Ubuntu systemd containers with OpenSSH. It seeds
 * a temporary Nexus home with two password-auth hosts, starts the real compiled
 * MCP server, and calls praetor.install_all twice:
 *
 *   1. without confirm -> the MCP gate must refuse and leave both hosts untouched;
 *   2. with confirm    -> the real SSH installer must install PRAETOR on both,
 *                         start each egress unit, write four profiles per host,
 *                         and return ready with a distinct key per host.
 *
 * Each container publishes its own TCP 9443 on a loopback alias so the external
 * probe can verify both fleet members read as ready. The fixture is destroyed
 * in finally. No live host, desktop profile or real credential is touched.
 * Docker is required; the test skips when it is missing unless
 * PRAETOR_TEST_REQUIRE_DOCKER=1 is set. If the socket is denied or the daemon
 * is stopped, the preflight prints the exact commands that restore access.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
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
  containers: [],
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

function dockerPreflight() {
  const result = run("docker", ["info", "--format", "{{.OSType}}"], { timeoutMs: 15_000 });
  if (result.error) {
    return { kind: result.error.code === "ENOENT" ? "missing" : "error" };
  }
  if (result.status === 0) return { kind: "ok", ostype: (result.stdout ?? "").trim() };
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (/permission denied/i.test(detail) && /(docker\.sock|docker API|docker daemon socket|unix:\/\/)/i.test(detail)) {
    return { kind: "permission", user: currentUser() };
  }
  if (
    /(cannot connect to the docker daemon|failed to connect to the docker (daemon|api)|is the docker daemon running)/i.test(detail) ||
    (/(docker\.sock|unix:\/\/)/i.test(detail) && /(no such file or directory|connection refused)/i.test(detail))
  ) {
    return { kind: "stopped" };
  }
  return { kind: "error" };
}

function currentUser() {
  try {
    return userInfo().username || "your-user";
  } catch {
    return "your-user";
  }
}

function dockerDaemonMessage() {
  return [
    "Docker daemon is not running; the PRAETOR test needs a running Linux Docker daemon.",
    "Fix: sudo systemctl start docker",
    "Verify: systemctl is-active docker",
    "        docker info --format '{{.OSType}}'",
  ].join("\n");
}

function dockerPermissionMessage(user) {
  const shellUser = /^[A-Za-z0-9._-]+$/.test(user) ? user : "<your-user>";
  return [
    `Docker socket access denied for user "${user}"; the PRAETOR test needs disposable Linux SSH containers.`,
    `Fix: sudo usermod -aG docker ${shellUser}`,
    "Then sign out and back in (or run: newgrp docker) and retry.",
    "Verify: docker info --format '{{.OSType}}'",
  ].join("\n");
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

function seedHome(hosts) {
  const home = mkdtempSync(path.join(tmpdir(), "nexus-praetor-smoke-"));
  const keyDir = path.join(home, "keys");
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  writeFileSync(path.join(keyDir, "master.key"), key, { mode: 0o600 });
  const config = {
    version: 1,
    hosts: [],
    sshHosts: hosts.map((host, index) => ({
      id: host.id,
      label: host.label,
      host: host.bind,
      port: host.sshPort,
      username: "root",
      authMode: "password",
      hasSecret: true,
      color: host.color,
      createdAt: Date.now() + index,
      secretEnc: encryptSecret(host.password, key),
    })),
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
  return { home, configPath };
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

function startContainer(image, fixture) {
  const name = `nexus-praetor-smoke-${fixture.id}-${process.pid}-${Date.now()}`;
  state.containers.push(name);
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
      `${fixture.bind}::22`,
      "-p",
      `${fixture.bind}:9443:9443`,
      image,
    ],
    { timeoutMs: 60_000 },
  );
  return name;
}

function waitForSystemd(container) {
  let last = "";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = run("docker", ["exec", container, "systemctl", "is-system-running"], {
      timeoutMs: 5_000,
    });
    last = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (/^(running|degraded)$/m.test(last)) return last;
    sleepSync(1_000);
  }
  throw new Error(`systemd did not become ready in ${container}\n${last.slice(-1000)}`);
}

function waitForPort(container) {
  let last = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = run("docker", ["port", container, "22/tcp"], { timeoutMs: 5_000 });
    last = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const portText = last.trim().split(":").pop()?.trim();
    const port = Number(portText);
    if (portText && Number.isInteger(port) && port > 0) return port;
    sleepSync(500);
  }
  throw new Error(`SSH port was not published by ${container}\n${last}`);
}

function startSsh(container, password) {
  const passwordResult = run("docker", ["exec", "-i", container, "chpasswd"], {
    input: `root:${password}\n`,
    timeoutMs: 15_000,
  });
  if (passwordResult.error) throw passwordResult.error;
  if (passwordResult.status !== 0) {
    throw new Error(`could not set the fixture root password\n${passwordResult.stderr ?? ""}`);
  }

  const started = run("docker", ["exec", container, "systemctl", "start", "ssh.service"], {
    timeoutMs: 30_000,
  });
  if (started.status !== 0) {
    throw new Error(`fixture ssh.service did not start\n${started.stdout ?? ""}\n${started.stderr ?? ""}`);
  }

  const sshd = run("docker", ["exec", container, "sshd", "-T"], { timeoutMs: 15_000 });
  const effective = `${sshd.stdout ?? ""}\n${sshd.stderr ?? ""}`;
  if (sshd.status !== 0 || !/^permitrootlogin yes$/m.test(effective) || !/^passwordauthentication yes$/m.test(effective)) {
    throw new Error(`fixture sshd did not expose password root login\n${effective.slice(-1500)}`);
  }
}

async function waitForSsh(host, port, password) {
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
      conn.connect({ host, port, username: "root", password, readyTimeout: 4_000 });
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
  if (!keepFixture) {
    for (const container of state.containers) {
      run("docker", ["rm", "-f", container], { timeoutMs: 30_000 });
    }
  }
  if (state.image && !keepFixture) {
    run("docker", ["rmi", "-f", state.image], { timeoutMs: 30_000 });
  }
  if (state.home && !keepFixture) rmSync(state.home, { recursive: true, force: true });
  if (state.fixtureDir) rmSync(state.fixtureDir, { recursive: true, force: true });
  if (keepFixture) {
    console.log(
      `KEEP  containers=${state.containers.join(",") || "(none)"} home=${state.home || "(none)"} image=${state.image || "(none)"}`,
    );
  }
}

function fixtureLogs() {
  for (const container of state.containers) {
    const logs = run("docker", ["logs", "--tail", "80", container], { timeoutMs: 20_000 });
    const text = `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`.trim();
    if (text) {
      console.log(`\n--- disposable host logs: ${container} ---`);
      console.log(text.split("\n").slice(-80).join("\n"));
    }
  }
}

function containerFile(container, file) {
  const result = run("docker", ["exec", container, "cat", file], { timeoutMs: 10_000 });
  return { ok: result.status === 0, text: (result.stdout ?? "").trim(), error: (result.stderr ?? "").trim() };
}

function parseContainerJson(container, file) {
  const result = containerFile(container, file);
  try {
    return { ok: result.ok, json: JSON.parse(result.text), error: result.error };
  } catch (error) {
    return { ok: false, json: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const dockerStatus = dockerPreflight();
if (dockerStatus.kind === "permission") {
  skipOrFail(dockerPermissionMessage(dockerStatus.user));
}
if (dockerStatus.kind === "stopped") {
  skipOrFail(dockerDaemonMessage());
}
if (dockerStatus.kind !== "ok") {
  skipOrFail("Docker is not available; the PRAETOR install integration test needs disposable Linux SSH containers.");
}
if (dockerStatus.ostype !== "linux") {
  skipOrFail(`Docker is using ${dockerStatus.ostype} containers; the PRAETOR fixture needs Linux containers.`);
}
if (!existsSync(serverPath)) {
  console.error(`FAIL  MCP server bundle is missing: ${serverPath}. Run npm run build:main first.`);
  process.exit(1);
}

try {
  const image = buildFixture();
  const fixtures = [
    { id: "praetor-smoke-a", label: "praetor-smoke-a", bind: "127.0.0.1", color: "#38f2ff" },
    { id: "praetor-smoke-b", label: "praetor-smoke-b", bind: "127.0.0.2", color: "#7c5cff" },
  ];
  for (const fixture of fixtures) {
    fixture.password = crypto.randomBytes(18).toString("base64url");
    fixture.container = startContainer(image, fixture);
  }
  for (const fixture of fixtures) {
    fixture.systemd = waitForSystemd(fixture.container);
    fixture.sshPort = waitForPort(fixture.container);
    startSsh(fixture.container, fixture.password);
    await waitForSsh(fixture.bind, fixture.sshPort, fixture.password);
  }
  check(
    "two disposable Ubuntu fixtures reach systemd",
    fixtures.every((fixture) => /^(running|degraded)$/m.test(fixture.systemd)),
    fixtures.map((fixture) => `${fixture.id}:${fixture.systemd}`).join(" / "),
  );
  check(
    "both disposable SSH hosts accept the seeded root logins",
    true,
    fixtures.map((fixture) => `${fixture.bind}:${fixture.sshPort}`).join(", "),
  );

  const seeded = seedHome(fixtures);
  state.home = seeded.home;
  const configText = readFileSync(seeded.configPath, "utf8");
  check(
    "both seeded SSH passwords are encrypted at rest",
    fixtures.every((fixture) => !configText.includes(fixture.password)),
  );
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
  check(
    "MCP exposes the PRAETOR fleet tools",
    ["praetor.overview", "praetor.install_all", "praetor.rotate"].every((name) => names.includes(name)),
  );

  const plan = await state.call("praetor.plan");
  check(
    "fleet plan sees both disposable hosts",
    plan.isError === false && plan.json?.totalHosts === 2 && plan.json?.pending?.length === 2,
    `${plan.json?.totalHosts} hosts / ${plan.json?.pending?.length} pending`,
  );

  const refused = await state.call("praetor.install_all", {});
  check(
    "unconfirmed fleet install is refused by the MCP gate",
    refused.isError === true && /confirm/i.test(refused.json?.error ?? refused.text),
    refused.json?.error ?? refused.text.slice(0, 200),
  );
  const untouched = fixtures.map((fixture) =>
    run("docker", ["exec", fixture.container, "sh", "-c", "test ! -e /opt/praetor-egress"], {
      timeoutMs: 10_000,
    }),
  );
  check("refused install leaves both hosts untouched", untouched.every((result) => result.status === 0));
  const refusedProfiles = await state.call("praetor.profiles");
  check("refused fleet install writes no local pins", refusedProfiles.json?.count === 0);

  const installed = await state.call("praetor.install_all", { confirm: true }, 900_000);
  const results = installed.json?.results ?? [];
  const resultByHost = new Map(results.map((result) => [result.hostId, result]));
  check(
    "confirmed two-host fleet install succeeds",
    installed.isError === false &&
      installed.json?.ok === true &&
      installed.json?.total === 2 &&
      installed.json?.installed === 2 &&
      installed.json?.failed === 0,
    installed.isError ? installed.text.slice(-800) : `${installed.json?.installed}/${installed.json?.total} installed`,
  );
  check(
    "both hosts return ready with four profiles and distinct keys",
    results.length === 2 &&
      fixtures.every((fixture) => resultByHost.has(fixture.id)) &&
      results.every((result) => result.ok === true && result.state === "ready" && result.profileCount === 4 && Boolean(result.publicKey)) &&
      new Set(results.map((result) => result.publicKey)).size === 2,
    results.map((result) => `${result.label}:${result.publicKey?.slice(0, 10)}…`).join(" / "),
  );

  const privateKeyHashes = fixtures.map((fixture) => {
    const digest = run("docker", ["exec", fixture.container, "sha256sum", "/opt/praetor-egress/server.key"], {
      timeoutMs: 10_000,
    });
    return digest.status === 0 ? digest.stdout.trim().split(/\s+/)[0] : "";
  });
  check(
    "each host generated a distinct private key",
    privateKeyHashes.every(Boolean) && new Set(privateKeyHashes).size === 2,
  );

  for (const fixture of fixtures) {
    const result = resultByHost.get(fixture.id);
    const remotePub = containerFile(fixture.container, "/opt/praetor-egress/server.pub");
    check(
      `host ${fixture.label} serves its own public key`,
      remotePub.ok && remotePub.text === result?.publicKey,
      `${remotePub.text.slice(0, 10)}…`,
    );

    const remotePins = parseContainerJson(fixture.container, "/opt/praetor-egress/profiles.json");
    check(
      `host ${fixture.label} pins four profiles to that key`,
      remotePins.ok &&
        Array.isArray(remotePins.json) &&
        remotePins.json.length === 4 &&
        remotePins.json.every((profile) => profile.serverPublicKey === result?.publicKey),
      `${Array.isArray(remotePins.json) ? remotePins.json.length : 0} profiles`,
    );

    const keyMode = run("docker", ["exec", fixture.container, "stat", "-c", "%a", "/opt/praetor-egress/server.key"], {
      timeoutMs: 10_000,
    });
    check(
      `host ${fixture.label} private key is mode 0600`,
      keyMode.status === 0 && keyMode.stdout.trim() === "600",
      keyMode.stdout.trim(),
    );

    const active = run("docker", ["exec", fixture.container, "systemctl", "is-active", "praetor-egress.service"], {
      timeoutMs: 15_000,
    });
    check(
      `host ${fixture.label} egress is active`,
      active.status === 0 && active.stdout.trim() === "active",
      active.stdout.trim(),
    );

    const listening = run("docker", ["exec", fixture.container, "sh", "-c", "ss -lnt 2>/dev/null | grep -q ':9443 '"], {
      timeoutMs: 10_000,
    });
    check(`host ${fixture.label} listens on TCP 9443`, listening.status === 0);
  }

  const localPath = path.join(seeded.home, "praetor", "profiles.json");
  const localStore = JSON.parse(readFileSync(localPath, "utf8"));
  const localHosts = localStore.hosts ?? {};
  check(
    "local store keeps four pins per host with matching keys",
    fixtures.every((fixture) => {
      const entry = localHosts[fixture.id];
      const expected = resultByHost.get(fixture.id)?.publicKey;
      return (
        entry?.publicKey === expected &&
        entry.profiles?.length === 4 &&
        entry.profiles.every((profile) => profile.serverPublicKey === expected)
      );
    }),
    fixtures.map((fixture) => `${fixture.id}:${localHosts[fixture.id]?.profiles?.length ?? 0}`).join(" / "),
  );
  check(
    "local pins keep the two host keys separate",
    new Set(fixtures.map((fixture) => localHosts[fixture.id]?.publicKey)).size === 2,
  );

  const overview = await state.call("praetor.overview");
  const overviewHosts = overview.json?.hosts ?? [];
  const overviewByHost = new Map(overviewHosts.map((host) => [host.hostId, host]));
  check(
    "fleet status reports both hosts ready with per-host pins",
    overview.isError === false &&
      overviewHosts.length === 2 &&
      fixtures.every((fixture) => {
        const host = overviewByHost.get(fixture.id);
        const expected = resultByHost.get(fixture.id)?.publicKey;
        return (
          host?.state === "ready" &&
          host.profilesOnHost === true &&
          host.profiles?.length === 4 &&
          host.installedSha === overview.json?.expectedSha &&
          host.publicKey === expected &&
          host.profiles.every((profile) => profile.serverPublicKey === expected)
        );
      }),
    overviewHosts.map((host) => `${host.label}:${host.state}`).join(" / "),
  );
  check(
    "fleet status keeps a TCP and firewall check per host",
    fixtures.every((fixture) => {
      const history = overviewByHost.get(fixture.id)?.history ?? [];
      const last = history.at(-1);
      return history.length >= 1 && last?.tcpReachable === true && last?.firewallBlocked === false;
    }),
    fixtures.map((fixture) => `${fixture.id}:${overviewByHost.get(fixture.id)?.history?.length ?? 0}`).join(" / "),
  );
  check("fleet status does not expose private key material", !/PRIVATE KEY/.test(overview.text));

  const profiles = await state.call("praetor.profiles");
  check(
    "profile export returns eight pins across two keys",
    profiles.isError === false &&
      profiles.json?.count === 8 &&
      new Set((profiles.json?.profiles ?? []).map((profile) => profile.serverPublicKey)).size === 2,
    `${profiles.json?.count} profiles`,
  );

  const scoped = [];
  for (const fixture of fixtures) scoped.push(await state.call("praetor.profiles", { host: fixture.label }));
  check(
    "profile export scopes four pins to each host",
    scoped.every((entry, index) => {
      const expected = resultByHost.get(fixtures[index].id)?.publicKey;
      return (
        entry.isError === false &&
        entry.json?.count === 4 &&
        entry.json?.profiles?.every((profile) => profile.serverPublicKey === expected)
      );
    }),
    scoped.map((entry) => `${entry.json?.hostId}:${entry.json?.count}`).join(" / "),
  );

  const audit = await state.call("audit.tail", { limit: 100 });
  const entries = audit.json?.entries ?? [];
  const installEntries = entries.filter((entry) => entry.tool === "praetor.install_all");
  const refusedEntry = installEntries.find((entry) => entry.ok === false);
  const confirmedEntry = installEntries.find((entry) => entry.ok === true);
  check(
    "audit records the refused gate and the confirmed fleet install",
    installEntries.length === 2 &&
      Boolean(refusedEntry) &&
      Boolean(confirmedEntry) &&
      /confirm/i.test(refusedEntry.error ?? "") &&
      confirmedEntry.args?.confirm === true,
    `${installEntries.length} install_all entries`,
  );
  check(
    "audit entries contain no private keys or SSH passwords",
    !/PRIVATE KEY/.test(audit.text) && fixtures.every((fixture) => !audit.text.includes(fixture.password)),
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
