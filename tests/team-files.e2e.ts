import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TeamFilesService } from "../electron/team/files";
import type { TeamSyncService } from "../electron/team/sync";

const PROJECT_ROOT = process.cwd();
const TOKEN = "nexus-team-files-e2e-token-32";
const LARGE_BYTES = 12 * 1024 * 1024;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port for the file relay."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The file relay did not start.");
}

async function startRelay(home: string, port: number): Promise<{ child: ChildProcess; url: string; logs: () => string }> {
  let logs = "";
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, "scripts", "team-sync-server.mjs")], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NEXUS_SYNC_TOKEN: TOKEN,
      NEXUS_SYNC_DATA: path.join(home, "data", "state.json"),
    },
  });
  child.stdout?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url);
  return { child, url, logs: () => logs };
}

async function stopRelay(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 4_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("team relay streams unlimited files, persists them, and enforces delete ownership", { timeout: 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-files-e2e-"));
  let relay: { child: ChildProcess; url: string; logs: () => string } | undefined;
  try {
    const port = await freePort();
    relay = await startRelay(home, port);
    const target = {
      fileShareTarget: () => ({ endpoint: relay!.url, token: TOKEN }),
    } as unknown as TeamSyncService;
    const files = new TeamFilesService(target);

    const initial = await files.overview();
    assert.equal(initial.configured, true);
    assert.deepEqual(initial.files, []);

    const source = path.join(home, "large-installer.bin");
    const payload = crypto.randomBytes(LARGE_BYTES);
    fs.writeFileSync(source, payload);
    const digest = crypto.createHash("sha256").update(payload).digest("hex");

    const uploaded = await files.upload(source, { username: "owner" });
    assert.equal(uploaded.files.length, 1, "a file larger than the 8 MB sync envelope is accepted");
    const entry = uploaded.files[0];
    assert.equal(entry.name, "large-installer.bin");
    assert.equal(entry.size, LARGE_BYTES);
    assert.equal(entry.uploadedBy, "owner");

    const listed = await files.overview();
    assert.equal(listed.files[0].id, entry.id);

    const destination = path.join(home, "download.bin");
    await files.download(entry.id, destination);
    const downloaded = fs.readFileSync(destination);
    assert.equal(downloaded.length, LARGE_BYTES);
    assert.equal(crypto.createHash("sha256").update(downloaded).digest("hex"), digest);

    const range = await fetch(`${relay.url}/v1/files/${entry.id}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Range: "bytes=0-1023" },
    });
    assert.equal(range.status, 206);
    assert.match(range.headers.get("content-range") ?? "", /^bytes 0-1023\//);
    assert.equal((await range.arrayBuffer()).byteLength, 1024);

    const unauthorized = await fetch(`${relay.url}/v1/files`);
    assert.equal(unauthorized.status, 401);

    const traversal = await fetch(`${relay.url}/v1/files?name=${encodeURIComponent("../../escaped-installer.sh")}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/octet-stream",
        "x-nexus-uploader": "owner",
      },
      body: Buffer.from("echo safe\n"),
    });
    assert.equal(traversal.status, 201);
    const traversalBody = (await traversal.json()) as { file: { name: string; id: string } };
    assert.equal(traversalBody.file.name, "escaped-installer.sh");
    assert.equal(fs.existsSync(path.join(home, "escaped-installer.sh")), false);

    await assert.rejects(
      files.remove(entry.id, { username: "alice", role: "user" }),
      /uploader|admin|403/i,
      "a non-owner cannot remove the file",
    );

    // Restart against the same data directory. The index and blob must survive.
    await stopRelay(relay.child);
    relay = await startRelay(home, port);
    const afterRestart = await new TeamFilesService(target).overview();
    assert.equal(afterRestart.files.length, 2, "the file index survives a relay restart");

    const afterDelete = await files.remove(entry.id, { username: "owner", role: "superadmin" });
    assert.equal(afterDelete.files.some((file) => file.id === entry.id), false);
    assert.equal(fs.existsSync(path.join(home, "data", "files", `${entry.id}.blob`)), false);
  } finally {
    if (relay) {
      try {
        await stopRelay(relay.child);
      } catch {
        /* best effort */
      }
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
