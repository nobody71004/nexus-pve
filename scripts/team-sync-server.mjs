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
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = process.env.NEXUS_SYNC_TOKEN || "";
const DATA_FILE = path.resolve(process.env.NEXUS_SYNC_DATA || path.join(process.cwd(), ".nexus-sync", "state.json"));
const TLS_CERT = process.env.TLS_CERT || "";
const TLS_KEY = process.env.TLS_KEY || "";
const MAX_BODY = 8 * 1024 * 1024;
const FILES_DIR = path.resolve(
  process.env.NEXUS_FILES_DIR || path.join(path.dirname(DATA_FILE), "files"),
);
const FILES_INDEX = path.join(FILES_DIR, "index.json");
const configuredFileLimit = Number(process.env.NEXUS_FILES_MAX_BYTES || 0);
// Unlimited by default. Set NEXUS_FILES_MAX_BYTES only when the server owner
// wants a quota; files are always streamed and never held in memory.
const FILES_MAX = Number.isFinite(configuredFileLimit) && configuredFileLimit > 0 ? configuredFileLimit : 0;

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

fs.mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(FILES_DIR, 0o700);
} catch {
  /* Windows ACL */
}
for (const name of fs.readdirSync(FILES_DIR)) {
  if (!name.startsWith(".upload-")) continue;
  try {
    fs.rmSync(path.join(FILES_DIR, name), { force: true });
  } catch {
    /* a previous process may still own it */
  }
}

function cleanFileName(value) {
  const raw = typeof value === "string" ? value : "";
  const base = path.basename(raw.replace(/\\/g, "/"));
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 255);
  return clean || "team-file";
}

function cleanUploader(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(raw) ? raw : "team";
}

function validFileEntry(entry) {
  return Boolean(
    entry &&
      typeof entry.id === "string" &&
      /^[a-f0-9-]{36}$/.test(entry.id) &&
      typeof entry.name === "string" &&
      Number.isFinite(Number(entry.size)) &&
      Number(entry.size) >= 0 &&
      typeof entry.uploadedBy === "string" &&
      Number.isFinite(Number(entry.uploadedAt)),
  );
}

function readFiles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILES_INDEX, "utf8"));
    if (Array.isArray(parsed.files)) {
      return parsed.files.filter(validFileEntry).filter((entry) => fs.existsSync(filePath(entry.id)));
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[files] index is unreadable; starting empty", err.message);
  }
  return [];
}

function writeFiles() {
  fs.mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILES_INDEX}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, files }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILES_INDEX);
  try {
    fs.chmodSync(FILES_INDEX, 0o600);
  } catch {
    /* Windows ACL */
  }
}

function filePath(id) {
  return path.join(FILES_DIR, `${id}.blob`);
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

let files = readFiles();

function tokenMatches(header) {
  const supplied = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = Buffer.from(TOKEN);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

async function uploadFile(req, res, url) {
  const declared = Number(req.headers["content-length"] || 0);
  if (FILES_MAX > 0 && declared > FILES_MAX) {
    json(res, 413, { error: `File exceeds the server limit of ${FILES_MAX} bytes.` });
    req.resume();
    return;
  }
  const id = crypto.randomUUID();
  const tmp = path.join(FILES_DIR, `.upload-${id}`);
  const final = filePath(id);
  let size = 0;
  let stored = false;
  try {
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (FILES_MAX > 0 && size > FILES_MAX) {
          callback(new Error(`File exceeds the server limit of ${FILES_MAX} bytes.`));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(req, limiter, fs.createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
    fs.renameSync(tmp, final);
    stored = true;
    try {
      fs.chmodSync(final, 0o600);
    } catch {
      /* Windows ACL */
    }
    const entry = {
      id,
      name: cleanFileName(url.searchParams.get("name")),
      size,
      uploadedBy: cleanUploader(req.headers["x-nexus-uploader"]),
      uploadedAt: Date.now(),
      ...(typeof req.headers["content-type"] === "string" && req.headers["content-type"].startsWith("application/octet-stream")
        ? {}
        : { contentType: String(req.headers["content-type"] || "application/octet-stream").slice(0, 180) }),
    };
    files.unshift(entry);
    writeFiles();
    json(res, 201, { file: entry });
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
      if (stored) fs.rmSync(final, { force: true });
    } catch {
      /* best effort */
    }
    const message = err instanceof Error ? err.message : "upload failed";
    json(res, /limit/i.test(message) ? 413 : 400, { error: message });
  }
}

function serveFile(req, res, entry) {
  let stat;
  try {
    stat = fs.statSync(filePath(entry.id));
  } catch {
    files = files.filter((item) => item.id !== entry.id);
    writeFiles();
    json(res, 404, { error: "file not found" });
    return;
  }
  const range = byteRange(req.headers.range, stat.size);
  if (range?.invalid) {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  const length = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, {
    "Content-Type": entry.contentType || "application/octet-stream",
    "Content-Length": length,
    "Content-Disposition": contentDisposition(entry.name),
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {}),
  });
  if (req.method === "HEAD" || stat.size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath(entry.id), { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function removeFile(req, res, entry) {
  const actor = cleanUploader(req.headers["x-nexus-user"]);
  if (entry.uploadedBy !== actor && req.headers["x-nexus-admin"] !== "1") {
    json(res, 403, { error: "only the uploader or an admin can remove this file" });
    return;
  }
  try {
    fs.rmSync(filePath(entry.id), { force: true });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : "could not remove the file" });
    return;
  }
  files = files.filter((item) => item.id !== entry.id);
  writeFiles();
  json(res, 200, { removed: entry.id });
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
    json(res, 200, { ok: true, revision: state.revision, updatedAt: state.updatedAt, files: files.length });
    return;
  }
  if (!url.pathname.startsWith("/v1/")) {
    json(res, 404, { error: "not found" });
    return;
  }
  if (!tokenMatches(req.headers.authorization)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  if (url.pathname === "/v1/files") {
    if (req.method === "GET") {
      json(res, 200, { version: 1, files });
      return;
    }
    if (req.method === "POST") {
      await uploadFile(req, res, url);
      return;
    }
    res.setHeader("Allow", "GET, POST");
    json(res, 405, { error: "method not allowed" });
    return;
  }
  if (url.pathname.startsWith("/v1/files/")) {
    const id = decodeURIComponent(url.pathname.slice("/v1/files/".length));
    if (!/^[a-f0-9-]{36}$/.test(id)) {
      json(res, 404, { error: "file not found" });
      return;
    }
    const entry = files.find((item) => item.id === id);
    if (!entry) {
      json(res, 404, { error: "file not found" });
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      serveFile(req, res, entry);
      return;
    }
    if (req.method === "DELETE") {
      removeFile(req, res, entry);
      return;
    }
    res.setHeader("Allow", "GET, HEAD, DELETE");
    json(res, 405, { error: "method not allowed" });
    return;
  }
  if (url.pathname !== "/v1/state") {
    json(res, 404, { error: "not found" });
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
  console.log(`[sync] shared files ${FILES_DIR}${FILES_MAX > 0 ? ` (limit ${FILES_MAX} bytes per file)` : " (no app-level size limit)"}`);
  console.log("[sync] team snapshots contain password hashes; protect the data file and TLS key.");
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
