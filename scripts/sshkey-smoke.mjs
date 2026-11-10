/**
 * End-to-end SSH-key control-plane smoke test.
 *
 * Boots a loopback SSH server whose shell is a real bash process, seeds a
 * password-authenticated Nexus host, and drives the bundled MCP server:
 * generate -> scan -> safe-refusal -> deploy -> key-auth scan -> enforce ->
 * revoke. The temporary home keeps the vault, private key and authorized_keys
 * away from the operator's real profile.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";

const { Server } = ssh2;
const { utils } = ssh2;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = path.join(root, "dist-electron", "mcp-server.cjs");
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const home = mkdtempSync(path.join(os.tmpdir(), "nexus-sshkey-smoke-"));
const sshDir = path.join(home, ".ssh");
mkdirSync(sshDir, { recursive: true, mode: 0o700 });
const windowsHome = home;
const posixHome = (() => {
  const normalized = home.replace(/\\/g, "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return match ? `/${match[1].toLowerCase()}/${match[2]}` : normalized;
})();

function toWindowsPath(value) {
  const match = /^\/([a-zA-Z])\/(.*)$/.exec(value);
  return match ? `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}` : value;
}

function encryptSecret(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${data.toString("base64")}`;
}

function startSshServer() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sockets = new Set();
  const commands = [];
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" || ctx.method === "publickey") {
        ctx.accept();
        return;
      }
      ctx.reject(["password", "publickey"]);
    });
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec) => {
        const stream = acceptExec();
        let command = "";
        stream.on("data", (chunk) => {
          command += chunk.toString();
        });
        stream.on("end", () => {
          commands.push(command);
          const child = spawn("bash", ["-s"], {
            cwd: windowsHome,
            env: {
              ...process.env,
              HOME: posixHome,
              USERPROFILE: windowsHome,
              HOMEDRIVE: path.parse(windowsHome).root.replace(/\\$/, ""),
              HOMEPATH: windowsHome.slice(path.parse(windowsHome).root.length - 1),
            },
            windowsHide: true,
          });
          child.stdin.end(command);
          child.stdout.on("data", (chunk) => stream.write(chunk));
          child.stderr.on("data", (chunk) => stream.stderr.write(chunk));
          child.on("error", (error) => {
            stream.stderr.write(`${error.message}\n`);
            stream.exit(1);
            stream.end();
          });
          child.on("close", (code) => {
            stream.exit(code ?? 1);
            stream.end();
          });
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
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      server.on("error", () => {});
      resolve({
        port: server.address().port,
        commands,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const unknown = utils.generateKeyPairSync("ed25519");
const unknownLine = `${unknown.public} smoke-unknown@example`;
const watcherUnknown = utils.generateKeyPairSync("ed25519");
const watcherUnknownLine = `${watcherUnknown.public} smoke-watcher@example`;
const unknownFingerprint = (() => {
  const blob = Buffer.from(unknown.public.split(/\s+/)[1], "base64");
  return `SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
})();
const authorizedPath = path.join(sshDir, "authorized_keys");
writeFileSync(authorizedPath, `${unknownLine}\n`, { mode: 0o600 });
chmodSync(authorizedPath, 0o600);

const masterKey = crypto.randomBytes(32);
mkdirSync(path.join(home, "keys"), { recursive: true, mode: 0o700 });
writeFileSync(path.join(home, "keys", "master.key"), masterKey, { mode: 0o600 });
const password = crypto.randomBytes(18).toString("base64url");

const sshServer = await startSshServer();
const configPath = path.join(home, "config.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      version: 1,
      hosts: [],
      sshHosts: [
        {
          id: "ssh-smoke",
          label: "ssh-smoke",
          host: "127.0.0.1",
          port: sshServer.port,
          username: "smoke",
          authMode: "password",
          hasSecret: true,
          color: "#3dffa8",
          createdAt: Date.now(),
          secretEnc: encryptSecret(password, masterKey),
        },
      ],
      settings: { pollMs: 8000, accent: "cyan", reduceMotion: false, confirmDestructive: true },
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

const child = spawn(process.execPath, [serverPath], {
  cwd: root,
  env: {
    ...process.env,
    NEXUS_PVE_HOME: home,
    HOME: posixHome,
    USERPROFILE: windowsHome,
    HOMEDRIVE: path.parse(windowsHome).root.replace(/\\$/, ""),
    HOMEPATH: windowsHome.slice(path.parse(windowsHome).root.length - 1),
    SSH_AUTH_SOCK: "",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
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

function rpc(method, params, timeoutMs = 60_000) {
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

async function waitFor(predicate, timeoutMs = 20_000, label = "condition") {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

const cleanup = async () => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  try {
    await sshServer.close();
  } catch {
    /* already closed */
  }
  rmSync(home, { recursive: true, force: true });
};

try {
  if (spawnSync("ssh", ["-V"]).error) throw new Error("OpenSSH client is required for the key-auth phase");
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "sshkey-smoke", version: "1" },
  });
  check("MCP server initializes", init?.serverInfo?.name === "nexus-pve");

  const list = await rpc("tools/list", {});
  const names = (list?.tools ?? []).map((tool) => tool.name);
  check(
    "SSH-key tool surface is registered",
    [
      "sshkey.overview",
      "sshkey.generate",
      "sshkey.deploy",
      "sshkey.scan",
      "sshkey.trust",
      "sshkey.enforce",
      "sshkey.policy",
      "sshkey.revoke",
    ].every((name) => names.includes(name)),
    `${names.filter((name) => name.startsWith("sshkey.")).length} tools`,
  );
  const enforceTool = (list?.tools ?? []).find((tool) => tool.name === "sshkey.enforce");
  const revokeTool = (list?.tools ?? []).find((tool) => tool.name === "sshkey.revoke");
  check("key enforcement and revocation are marked destructive", enforceTool?.annotations?.destructiveHint === true && revokeTool?.annotations?.destructiveHint === true);

  const policy = await call("sshkey.policy", { enabled: false, autoEnforce: false });
  check("watcher policy can be paused before mutating operations", policy.isError === false && policy.json?.enabled === false && policy.json?.autoEnforce === false);

  const generated = await call("sshkey.generate", { label: "smoke-key", owner: "smoke-operator" });
  const key = generated.json?.key;
  check("generate creates an Ed25519 public key and fingerprint", generated.isError === false && key?.algorithm === "ssh-ed25519" && /^SHA256:/.test(key?.fingerprint ?? ""));
  check("generate never returns private material", !/BEGIN .*PRIVATE KEY/.test(generated.text) && !("privateKeyEnc" in (key ?? {})));
  const statePath = path.join(home, "sshkeys", "state.json");
  const stateText = readFileSync(statePath, "utf8");
  check("private key is encrypted at rest", stateText.includes("privateKeyEnc") && !/BEGIN .*PRIVATE KEY/.test(stateText), statePath);
  check("policy has a verifiable signature", /^[a-f0-9]{64}$/.test(JSON.parse(stateText).policySig ?? ""));

  const beforeDeploy = await call("sshkey.scan", { host: "ssh-smoke" });
  check(
    "scan reads authorized_keys and finds the unmanaged key",
    beforeDeploy.isError === false &&
      beforeDeploy.json?.exists === true &&
      beforeDeploy.json?.unknown === 1 &&
      beforeDeploy.json?.keys?.[0]?.fingerprint === unknownFingerprint,
    `${beforeDeploy.json?.unknown} unmanaged`,
  );

  const unsafe = await call("sshkey.enforce", { host: "ssh-smoke", confirm: true });
  check("enforcement refuses when no managed or trusted key would remain", unsafe.isError === true && /lock out|no managed or trusted/i.test(unsafe.json?.error ?? unsafe.text));
  check("refused enforcement leaves the file untouched", readFileSync(authorizedPath, "utf8").trim() === unknownLine);

  const deployed = await call("sshkey.deploy", { host: "ssh-smoke", key: "smoke-key" });
  check("deploy appends the managed key and backs up the file", deployed.isError === false && deployed.json?.added === true, deployed.json?.path);
  const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const savedHost = savedConfig.sshHosts.find((host) => host.id === "ssh-smoke");
  check(
    "deploy switches the host to the generated private key",
    savedHost?.authMode === "key" && typeof savedHost?.keyPath === "string" && existsSync(savedHost.keyPath),
    savedHost?.keyPath,
  );
  check("authorized_keys contains both keys before enforcement", readFileSync(authorizedPath, "utf8").includes(unknownLine) && readFileSync(authorizedPath, "utf8").includes("nexus/smoke-operator/smoke-key"));

  const sshStatus = await call("ssh.status", { host: "ssh-smoke" });
  check(
    "SSH probe includes GPU and hardware telemetry surfaces",
    sshStatus.isError === false &&
      Array.isArray(sshStatus.json?.gpus) &&
      Array.isArray(sshStatus.json?.blockDevices) &&
      Array.isArray(sshStatus.json?.nics) &&
      Array.isArray(sshStatus.json?.temps),
    `${sshStatus.json?.gpus?.length ?? 0} GPUs / ${sshStatus.json?.blockDevices?.length ?? 0} disks`,
  );

  const afterDeploy = await call("sshkey.scan", { host: "ssh-smoke" });
  check(
    "key-auth scan classifies the deployed key as managed and protects the login key",
    afterDeploy.isError === false &&
      afterDeploy.json?.managed === 1 &&
      afterDeploy.json?.unknown === 1 &&
      afterDeploy.json?.loginFingerprint === key.fingerprint,
    `${afterDeploy.json?.managed} managed / ${afterDeploy.json?.unknown} unmanaged`,
  );

  const enforced = await call("sshkey.enforce", { host: "ssh-smoke", confirm: true });
  check(
    "enforce removes only the unmanaged key",
    enforced.isError === false &&
      enforced.json?.removed?.length === 1 &&
      enforced.json?.kept === 1 &&
      !readFileSync(authorizedPath, "utf8").includes(unknownLine) &&
      readFileSync(authorizedPath, "utf8").includes("nexus/smoke-operator/smoke-key"),
    `${enforced.json?.removed?.length} removed`,
  );
  check(
    "enforce leaves a backup",
    typeof enforced.json?.backup === "string" && existsSync(toWindowsPath(enforced.json.backup)),
    enforced.json?.backup,
  );

  const afterEnforce = await call("sshkey.scan", { host: "ssh-smoke" });
  check("post-enforcement scan is clean", afterEnforce.isError === false && afterEnforce.json?.unknown === 0 && afterEnforce.json?.managed === 1);

  // The 24/7 watcher itself must notice and remove a new unmanaged key. The
  // policy change resets the initial scan timer, so this takes a few seconds.
  writeFileSync(authorizedPath, `${readFileSync(authorizedPath, "utf8")}${watcherUnknownLine}\n`, { mode: 0o600 });
  const seeded = await call("sshkey.scan", { host: "ssh-smoke" });
  check("a new unmanaged key appears in the next scan", seeded.isError === false && seeded.json?.unknown === 1);
  const eventsBeforeWatcher = (await call("sshkey.overview")).json?.events?.length ?? 0;
  const watcherPolicy = await call("sshkey.policy", { enabled: true, autoEnforce: true, intervalSec: 30 });
  check("auto-enforcement can be explicitly enabled", watcherPolicy.isError === false && watcherPolicy.json?.autoEnforce === true && watcherPolicy.json?.enabled === true);
  const watched = await waitFor(async () => {
    const next = await call("sshkey.overview");
    const report = next.json?.hosts?.find((host) => host.hostId === "ssh-smoke");
    return report?.unknown === 0 && (next.json?.events?.length ?? 0) > eventsBeforeWatcher ? next : null;
  }, 20_000, "the 24/7 watcher to enforce");
  const watchedHost = watched.json?.hosts?.find((host) => host.hostId === "ssh-smoke");
  check(
    "the 24/7 watcher removes the unmanaged key",
    watchedHost?.unknown === 0 &&
      watchedHost?.managed === 1 &&
      !readFileSync(authorizedPath, "utf8").includes(watcherUnknownLine) &&
      !!watched.json?.events?.some((event) => event.kind === "enforce" && event.ok === true),
    `${watchedHost?.managed} managed / ${watchedHost?.unknown} unmanaged`,
  );
  await call("sshkey.policy", { enabled: false, autoEnforce: false });

  const revoked = await call("sshkey.revoke", { key: key.id, confirm: true });
  const retired = revoked.json?.keys?.find((entry) => entry.id === key.id);
  check("revoke removes the key from the host and retires it", revoked.isError === false && retired?.status === "retired" && readFileSync(authorizedPath, "utf8").trim() === "");
  check("revoke deletes the materialised private key", !existsSync(path.join(home, "sshkeys", `${key.id}.key`)));

  const finalOverview = await call("sshkey.overview");
  check(
    "overview reports the watcher and no private material",
    finalOverview.isError === false &&
      finalOverview.json?.running === true &&
      finalOverview.json?.keys?.every((entry) => !("privateKeyEnc" in entry)) &&
      !/BEGIN .*PRIVATE KEY/.test(finalOverview.text),
  );
  check("the SSH fixture actually executed remote shell scripts", sshServer.commands.length >= 2, `${sshServer.commands.length} commands`);
} catch (error) {
  check("test harness completed without throwing", false, error?.stack ?? String(error));
} finally {
  if (checks.some((entry) => !entry.ok) && stderr) {
    console.log("\n--- MCP server stderr ---");
    console.log(stderr);
  }
  await cleanup();
}

const passed = checks.filter((entry) => entry.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) {
  process.exitCode = 1;
}
