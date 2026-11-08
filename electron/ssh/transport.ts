import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "ssh2";

/**
 * Password logins cannot use the system ssh binary non-interactively, so those
 * hosts go through ssh2 (pure JS, no native build required). Key-based hosts
 * keep using the operating system client, which already respects the user's
 * agent, config and known_hosts.
 */
export interface SshAuth {
  host: string;
  port: number;
  username: string;
  password?: string;
  keyPath?: string;
}

export interface ExecOutcome {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  latencyMs: number;
}

function expandHome(value: string): string {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~\\") || value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** Resolve the first usable default key when no explicit path is configured. */
function defaultKey(): string | undefined {
  for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const candidate = path.join(os.homedir(), ".ssh", name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function keyMaterial(target: SshAuth): Buffer | undefined {
  const keyPath = target.keyPath ? expandHome(target.keyPath) : defaultKey();
  if (!keyPath) return undefined;
  try {
    return fs.readFileSync(keyPath);
  } catch {
    return undefined;
  }
}

/** True when this target must use the in-process client. */
export function needsSsh2(target: SshAuth): boolean {
  return Boolean(target.password);
}

/**
 * Runs one command and resolves when the remote side closes. `feed` is written
 * to stdin, which is how the read-only probe script is delivered.
 */
export function execSsh2(
  target: SshAuth,
  command: string,
  options: { timeoutMs?: number; feed?: string } = {},
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (ok: boolean, code: number | null, extra?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.end();
      } catch {
        /* already closed */
      }
      resolve({ ok, code, stdout, stderr: extra ? `${stderr}\n${extra}` : stderr, latencyMs: Date.now() - started });
    };

    const conn = new Client();
    const timer = setTimeout(() => finish(false, null, `timed out after ${options.timeoutMs ?? 30_000} ms`), options.timeoutMs ?? 30_000);

    conn.on("ready", () => {
      conn.exec(command, (error, stream) => {
        if (error) {
          finish(false, null, error.message);
          return;
        }
        stream.on("data", (chunk: Buffer) => {
          if (stdout.length < 512_000) stdout += chunk.toString("utf8");
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < 32_000) stderr += chunk.toString("utf8");
        });
        stream.on("close", (code: number | null) => finish(code === 0, code ?? null));
        if (options.feed) stream.end(options.feed);
      });
    });
    conn.on("error", (error: Error) => finish(false, null, error.message));

    const privateKey = target.keyPath ? keyMaterial(target) : undefined;
    conn.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      privateKey,
      readyTimeout: Math.min(20_000, options.timeoutMs ?? 20_000),
      keepaliveInterval: 5_000,
      // Older dedicated boxes still ship modern-enough KEX, but this keeps
      // negotiation permissive without weakening host verification.
      tryKeyboard: false,
    });
  });
}
