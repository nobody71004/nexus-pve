import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import path from "node:path";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import type { TeamFileEntry, TeamFilesOverview, TeamUser } from "../../shared/types";
import type { TeamSyncService } from "./sync";

const FILE_ID = /^[a-f0-9-]{36}$/;
const JSON_TIMEOUT_MS = 30_000;
const JSON_BODY_LIMIT = 2 * 1024 * 1024;

interface FileTarget {
  endpoint: string;
  token: string;
}

function parseEntry(value: unknown): TeamFileEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    !FILE_ID.test(entry.id) ||
    typeof entry.name !== "string" ||
    !Number.isFinite(Number(entry.size)) ||
    Number(entry.size) < 0 ||
    typeof entry.uploadedBy !== "string" ||
    !Number.isFinite(Number(entry.uploadedAt))
  ) {
    return null;
  }
  return {
    id: entry.id,
    name: entry.name,
    size: Number(entry.size),
    uploadedBy: entry.uploadedBy,
    uploadedAt: Number(entry.uploadedAt),
    ...(typeof entry.contentType === "string" && entry.contentType ? { contentType: entry.contentType } : {}),
  };
}

function readBody(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > JSON_BODY_LIMIT) {
        response.destroy(new Error("The share server returned an oversized response."));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.on("error", reject);
  });
}

async function responseJson(response: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(response);
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function failure(status: number | undefined, body: Record<string, unknown>): Error {
  return new Error(
    typeof body.error === "string" && body.error
      ? body.error
      : `The team share server returned HTTP ${status ?? "error"}.`,
  );
}

function transportFor(target: FileTarget): typeof http | typeof https {
  return new URL(target.endpoint).protocol === "https:" ? https : http;
}

function jsonRequest(
  target: FileTarget,
  pathname: string,
  init: { method?: string; headers?: Record<string, string | number> } = {},
): Promise<{ response: IncomingMessage; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${target.endpoint}${pathname}`);
    const req = transportFor(target).request(
      url,
      {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${target.token}`,
          Accept: "application/json",
          ...init.headers,
        },
      },
      async (response) => {
        try {
          resolve({ response, body: await responseJson(response) });
        } catch (error) {
          reject(error);
        }
      },
    );
    req.setTimeout(JSON_TIMEOUT_MS, () => req.destroy(new Error("The team share server did not answer in time.")));
    req.on("error", reject);
    req.end();
  });
}

export class TeamFilesService {
  constructor(private readonly sync: TeamSyncService) {}

  private requireTarget(): FileTarget {
    const target = this.sync.fileShareTarget();
    if (!target) {
      throw new Error("Shared files need the team sync relay. Connect Team sync to a server first.");
    }
    return target;
  }

  async overview(): Promise<TeamFilesOverview> {
    const target = this.sync.fileShareTarget();
    if (!target) return { configured: false, files: [] };
    const { response, body } = await jsonRequest(target, "/v1/files");
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
      throw failure(response.statusCode, body);
    }
    const files = Array.isArray(body.files)
      ? body.files.map(parseEntry).filter((entry): entry is TeamFileEntry => entry !== null)
      : [];
    files.sort((left, right) => right.uploadedAt - left.uploadedAt);
    return { configured: true, endpoint: target.endpoint, files };
  }

  /**
   * Stream a file to the relay. Content-Length and the HTTP stream keep memory
   * flat, so the client imposes no file-size cap.
   */
  async upload(filePath: string, actor: Pick<TeamUser, "username">): Promise<TeamFilesOverview> {
    const target = this.requireTarget();
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("Choose a regular file to share.");
    const url = new URL(`${target.endpoint}/v1/files`);
    url.searchParams.set("name", path.basename(filePath));
    const req = transportFor(target).request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        Accept: "application/json",
        "Content-Type": "application/octet-stream",
        "Content-Length": stat.size,
        "x-nexus-uploader": actor.username,
      },
    });
    const responsePromise = once(req, "response") as Promise<[IncomingMessage]>;
    // Attach a handler before writing so an early connection failure is never
    // reported as an unhandled rejection.
    responsePromise.catch(() => undefined);
    try {
      await pipeline(fs.createReadStream(filePath), req);
      const [response] = await responsePromise;
      const body = await responseJson(response);
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        throw failure(response.statusCode, body);
      }
    } catch (error) {
      req.destroy();
      throw error;
    }
    return this.overview();
  }

  /** Stream a shared file to the selected path; the partial file is removed on failure. */
  async download(id: string, targetPath: string): Promise<void> {
    if (!FILE_ID.test(id)) throw new Error("Invalid shared-file id.");
    const target = this.requireTarget();
    const url = new URL(`${target.endpoint}/v1/files/${encodeURIComponent(id)}`);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = transportFor(target).get(
        url,
        { headers: { Authorization: `Bearer ${target.token}`, Accept: "*/*" } },
        resolve,
      );
      req.on("error", reject);
    });
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
      throw failure(response.statusCode, await responseJson(response));
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    const partial = `${targetPath}.nexus-part-${crypto.randomUUID()}`;
    try {
      await pipeline(response, fs.createWriteStream(partial, { mode: 0o600 }));
      try {
        fs.renameSync(partial, targetPath);
      } catch {
        fs.rmSync(targetPath, { force: true });
        fs.renameSync(partial, targetPath);
      }
    } catch (error) {
      try {
        fs.rmSync(partial, { force: true });
      } catch {
        /* best effort */
      }
      throw error;
    }
  }

  async remove(id: string, actor: Pick<TeamUser, "username" | "role">): Promise<TeamFilesOverview> {
    if (!FILE_ID.test(id)) throw new Error("Invalid shared-file id.");
    const target = this.requireTarget();
    const { response, body } = await jsonRequest(target, `/v1/files/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: {
        "x-nexus-user": actor.username,
        "x-nexus-admin": actor.role === "user" ? "0" : "1",
      },
    });
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
      throw failure(response.statusCode, body);
    }
    return this.overview();
  }
}
