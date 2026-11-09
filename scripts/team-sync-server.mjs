#!/usr/bin/env node
/**
 * Minimal, self-hosted team sync relay.
 *
 * One token protects one team workspace. The relay only stores the latest
 * snapshot and its revision; all merging happens in the Nexus main process.
 * Keep this service behind TLS when it is reachable beyond loopback.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = process.env.NEXUS_SYNC_TOKEN || "";
const DATA_FILE = path.resolve(process.env.NEXUS_SYNC_DATA || path.join(process.cwd(), ".nexus-sync", "state.json"));
const TLS_CERT = process.env.TLS_CERT || "";
const TLS_KEY = process.env.TLS_KEY || "";
const MAX_BODY = 8 * 1024 * 1024;

if (TOKEN.length < 16) {
  console.error("NEXUS_SYNC_TOKEN must be at least 16 characters.");
  process.exit(1);
}
if (!TLS_CERT && !["127.0.0.1", "localhost", "::1"].includes(HOST)) {
  console.error("Refusing to expose the sync relay over plaintext HTTP. Set TLS_CERT and TLS_KEY.");
  process.exit(1);
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (parsed && Number.isInteger(parsed.revision) && (parsed.snapshot === null || typeof parsed.snapshot === "object")) {
      return { revision: parsed.revision, updatedAt: Number(parsed.updatedAt) || 0, snapshot: parsed.snapshot };
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[sync] state file is unreadable; starting empty", err.message);
  }
  return { revision: 0, updatedAt: 0, snapshot: null };
}

let state = readState();

function writeState(next) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
  try {
    fs.chmodSync(DATA_FILE, 0o600);
  } catch {
    /* Windows ACL */
  }
}

function tokenMatches(header) {
  const supplied = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = Buffer.from(TOKEN);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function validSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1) return false;
  if (typeof snapshot.workspaceName !== "string" || !Array.isArray(snapshot.users) || !Array.isArray(snapshot.machines)) return false;
  if (!Array.isArray(snapshot.activity) || !Array.isArray(snapshot.userTombstones)) return false;
  if (snapshot.machineTombstones !== undefined && !Array.isArray(snapshot.machineTombstones)) return false;
  if (snapshot.users.length > 500 || snapshot.machines.length > 1000 || snapshot.activity.length > 5000) return false;
  return snapshot.users.every(
    (user) =>
      user &&
      typeof user.username === "string" &&
      typeof user.passwordHash === "string" &&
      typeof user.passwordSalt === "string" &&
      typeof user.role === "string",
  );
}

function body(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const handler = async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/health") {
    json(res, 200, { ok: true, revision: state.revision, updatedAt: state.updatedAt });
    return;
  }
  if (url.pathname !== "/v1/state") {
    json(res, 404, { error: "not found" });
    return;
  }
  if (!tokenMatches(req.headers.authorization)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  if (req.method === "GET") {
    json(res, 200, state);
    return;
  }
  if (req.method !== "PUT") {
    res.setHeader("Allow", "GET, PUT");
    json(res, 405, { error: "method not allowed" });
    return;
  }
  try {
    const payload = JSON.parse(await body(req));
    if (!Number.isInteger(payload.baseRevision) || !validSnapshot(payload.snapshot)) {
      json(res, 400, { error: "invalid sync envelope" });
      return;
    }
    if (payload.baseRevision !== state.revision) {
      json(res, 409, { error: "revision conflict", revision: state.revision, snapshot: state.snapshot });
      return;
    }
    state = {
      revision: state.revision + 1,
      updatedAt: Date.now(),
      snapshot: payload.snapshot,
    };
    writeState(state);
    json(res, 200, { revision: state.revision, updatedAt: state.updatedAt });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : "bad request" });
  }
};

const server = TLS_CERT && TLS_KEY
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handler)
  : http.createServer(handler);

server.listen(PORT, HOST, () => {
  const scheme = TLS_CERT && TLS_KEY ? "https" : "http";
  console.log(`[sync] listening on ${scheme}://${HOST}:${PORT}`);
  console.log(`[sync] data file ${DATA_FILE}`);
  console.log("[sync] team snapshots contain password hashes; protect the data file and TLS key.");
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
