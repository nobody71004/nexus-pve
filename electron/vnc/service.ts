import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RawData, WebSocketServer as Wss } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import { Client } from "ssh2";
import type { ClientChannel } from "ssh2";
import type { ConfigStore } from "../config";
import { configStore } from "../config";
import { runRemote, sshArgs } from "../ssh/probe";
import { keyMaterial } from "../ssh/transport";
import type { VncPreflight, VncSession, VncSetupResult } from "../../shared/fabric-types";
import { ensureTerminalVnc } from "./setup";

interface ActiveSession {
  public: VncSession;
  server: Wss;
  ssh?: Client;
  child?: ChildProcessWithoutNullStreams;
  token: string;
  expiry: ReturnType<typeof setTimeout>;
  socket?: WebSocket;
  stream?: ClientChannel;
  closed: boolean;
}

function socketPath(url: string | undefined): string {
  try {
    return new URL(url ?? "", "ws://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

/** Read-only probe: listening sockets in 5900-5999 plus any VNC daemon. */
const PREFLIGHT_COMMAND = [
  `printf 'hostname=%s\\n' "$(hostname 2>/dev/null || echo unknown)"`,
  `ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E ':(59[0-9]{2})$' | sort -u | sed 's/^/listen=/' || true`,
  `ps -eo args 2>/dev/null | grep -Ei '(x11vnc|wayvnc|Xvnc|tigervnc|vncserver)' | grep -v grep | head -3 | sed 's/^/daemon=/' || true`,
  // Whether the installer can become root at all. A key-auth host has no
  // stored password to feed sudo, so the panel can ask before a doomed run.
  `if [ "$(id -u 2>/dev/null || echo 1)" = 0 ]; then printf 'elevation=root\\n'; elif ! command -v sudo >/dev/null 2>&1; then printf 'elevation=none\\n'; elif sudo -n true >/dev/null 2>&1; then printf 'elevation=nopasswd\\n'; else printf 'elevation=password\\n'; fi`,
  "exit 0",
].join("\n");

const WILDCARD_ADDRESSES = new Set(["0.0.0.0", "*", "::", "[::]", ""]);

function isLoopbackAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  return value === "127.0.0.1" || value.startsWith("127.") || value === "::1" || value === "localhost";
}

function isWildcardAddress(address: string): boolean {
  return WILDCARD_ADDRESSES.has(address.trim().toLowerCase());
}

function parsePreflight(stdout: string): {
  hostname?: string;
  entries: Array<{ address: string; port: number }>;
  daemon?: string;
  elevation?: string;
} {
  let hostname: string | undefined;
  const entries: Array<{ address: string; port: number }> = [];
  let daemon: string | undefined;
  let elevation: string | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("hostname=")) {
      const value = line.slice("hostname=".length).trim();
      if (value) hostname = value;
    } else if (line.startsWith("listen=")) {
      const value = line.slice("listen=".length).trim();
      const split = value.lastIndexOf(":");
      if (split < 1) continue;
      const port = Number(value.slice(split + 1));
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      entries.push({ address: value.slice(0, split).replace(/^\[/, "").replace(/\]$/, ""), port });
    } else if (line.startsWith("daemon=")) {
      const value = line.slice("daemon=".length).trim();
      if (value && !daemon) {
        const first = value.split(/\s+/)[0] || value;
        daemon = first.split(/[\\/]/).pop() || first;
      }
    } else if (line.startsWith("elevation=")) {
      const value = line.slice("elevation=".length).trim();
      if (value) elevation = value;
    }
  }
  return { hostname, entries, daemon, elevation };
}

function execCapture(conn: Client, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    timer = setTimeout(() => finish(() => reject(new Error("VNC preflight timed out"))), timeoutMs);
    conn.exec(command, (err, stream) => {
      if (err) {
        finish(() => reject(err));
        return;
      }
      let out = "";
      stream.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      stream.stderr.on("data", () => undefined);
      stream.on("close", () => finish(() => resolve(out)));
      stream.on("error", (streamError: Error) => finish(() => reject(streamError)));
    });
  });
}

function listen(server: Wss): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("VNC bridge did not bind a loopback port"));
    }, 5_000);
    const done = (port: number) => {
      clearTimeout(timer);
      resolve(port);
    };
    server.once("listening", () => {
      const address = server.address();
      if (address && typeof address === "object") done(address.port);
      else {
        clearTimeout(timer);
        reject(new Error("VNC bridge returned no listening address"));
      }
    });
    server.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function connectSsh(store: ConfigStore, hostId: string): Promise<Client> {
  const host = store.sshHost(hostId);
  if (!host) return Promise.reject(new Error(`Unknown Linux host: ${hostId}`));
  const password = host.authMode === "password" ? store.sshSecretFor(host.id) : undefined;
  const privateKey = host.authMode === "key" ? keyMaterial({ host: host.host, port: host.port, username: host.username, keyPath: host.keyPath }) : undefined;
  const agent =
    host.authMode === "key" && !privateKey
      ? process.platform === "win32"
        ? "pageant"
        : process.env.SSH_AUTH_SOCK
      : undefined;

  if (host.authMode === "password" && !password) {
    return Promise.reject(new Error(`${host.label}: stored password is missing`));
  }
  if (host.authMode === "key" && !privateKey && !agent) {
    return Promise.reject(new Error(`${host.label}: no private key or SSH agent is available for the VNC tunnel`));
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const timer = setTimeout(() => finish(new Error("VNC SSH tunnel timed out")), 25_000);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try {
          conn.end();
        } catch {
          /* already closed */
        }
        reject(error);
      } else {
        resolve(conn);
      }
    };

    conn.once("ready", () => finish());
    conn.once("error", (error: Error) => finish(error));
    conn.once("close", () => finish(new Error("SSH connection closed before the VNC tunnel was ready")));
    conn.connect({
      host: host.host,
      port: host.port,
      username: host.username,
      password,
      privateKey,
      agent,
      readyTimeout: 20_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      tryKeyboard: false,
    });
  });
}

/**
 * VNC stays private: noVNC talks to a loopback WebSocket, and this bridge carries
 * the RFB byte stream through the same authenticated SSH connection used by the
 * host console. The renderer receives a one-time token, never the SSH secret.
 */
export class VncService {
  private readonly sessions = new Map<string, ActiveSession>();

  constructor(private readonly store: ConfigStore = configStore) {}

  async setup(hostId: string, sudoPassword?: string): Promise<VncSetupResult> {
    return ensureTerminalVnc(this.store, hostId, sudoPassword);
  }

  async open(hostId: string, rawPort?: number): Promise<VncSession> {
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    const port = Number(rawPort ?? 5900);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("VNC port must be between 1 and 65535");

    await this.closeHost(hostId);

    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
    let boundPort: number;
    try {
      boundPort = await listen(server);
    } catch (err) {
      server.close();
      throw err;
    }

    // Key-based hosts go through the system OpenSSH client, which honours the
    // user's agent and config (the same path as the rest of the app). Password
    // hosts use ssh2 because the system client cannot take a password
    // non-interactively.
    const ssh =
      host.authMode === "password"
        ? await connectSsh(this.store, hostId).catch((err) => {
            server.close();
            throw err;
          })
        : undefined;

    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + 8 * 60 * 60_000;
    const session: ActiveSession = {
      public: {
        id,
        hostId: host.id,
        wsUrl: `ws://127.0.0.1:${boundPort}/${token}`,
        expiresAt,
      },
      server,
      ssh,
      token,
      expiry: setTimeout(() => void this.close(id), Math.max(1, expiresAt - Date.now())),
      closed: false,
    };
    session.expiry.unref?.();
    this.sessions.set(id, session);

    server.on("connection", (ws, request) => {
      if (session.closed || session.socket) {
        ws.close(1008, "session already attached");
        return;
      }
      if (socketPath(request.url) !== `/${token}`) {
        ws.close(1008, "invalid session token");
        return;
      }

      session.socket = ws;
      let stream: ClientChannel | undefined;
      let child: ChildProcessWithoutNullStreams | undefined;
      const pending: Buffer[] = [];
      let wsGone = false;
      let ended = false;

      const end = () => {
        if (ended) return;
        ended = true;
        pending.length = 0;
        try {
          stream?.close();
        } catch {
          /* already closed */
        }
        try {
          child?.kill();
        } catch {
          /* already exited */
        }
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      };

      // noVNC sends the RFB version as soon as the socket opens. Keep those
      // bytes until the transport is ready instead of dropping the handshake.
      ws.on("message", (data) => {
        const chunk = rawToBuffer(data);
        if (stream?.writable) stream.write(chunk);
        else if (child?.stdin.writable) child.stdin.write(chunk);
        else if (!wsGone && !ended) pending.push(chunk);
      });
      ws.on("close", () => {
        wsGone = true;
        if (session.socket === ws) session.socket = undefined;
        if (session.stream) session.stream = undefined;
        end();
      });
      ws.on("error", () => {
        wsGone = true;
        end();
      });

      if (!session.ssh) {
        const args = sshArgs({
          host: host.host,
          port: host.port,
          username: host.username,
          keyPath: host.keyPath,
          timeoutMs: 15_000,
        });
        const target = args.pop();
        if (!target) {
          ws.close(1011, "SSH target is missing");
          return;
        }
        args.push("-T", "-W", `127.0.0.1:${port}`, target);
        child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        session.child = child;
        child.stdin.on("error", () => undefined);
        let stderr = "";
        let received = false;
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < 1_000) stderr += chunk.toString("utf8");
        });
        child.stdout.on("data", (chunk: Buffer) => {
          received = true;
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
        });
        child.on("error", (error) => {
          if (!ended) ws.close(1011, error.message.slice(0, 120));
          end();
        });
        child.on("close", () => {
          if (!ended && !received) {
            const reason = stderr.trim().split(/\r?\n/).filter(Boolean).pop();
            ws.close(1011, (reason || "SSH tunnel closed").slice(0, 120));
          }
          end();
        });
        for (const chunk of pending) {
          if (child.stdin.writable) child.stdin.write(chunk);
        }
        pending.length = 0;
        return;
      }

      session.ssh.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (err, next) => {
        if (err) {
          ws.close(1011, err.message.slice(0, 120));
          return;
        }
        if (session.closed || wsGone || ended) {
          next.close();
          return;
        }
        stream = next;
        session.stream = next;
        for (const chunk of pending) {
          if (next.writable) next.write(chunk);
        }
        pending.length = 0;

        next.on("data", (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
        });
        next.on("close", () => {
          if (session.stream === next) session.stream = undefined;
          end();
        });
        next.on("error", end);
      });
    });

    server.on("error", () => {
      void this.close(id);
    });

    return session.public;
  }

  /** Public session metadata only; the WebSocket token never leaves open(). */
  list(): VncSession[] {
    return [...this.sessions.values()]
      .map((session) => session.public)
      .sort((left, right) => left.expiresAt - right.expiresAt);
  }

  async preflight(hostId: string): Promise<VncPreflight> {
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    const started = Date.now();
    const base = {
      hostId,
      host: host.host,
      checkedAt: started,
      ports: [] as number[],
      loopbackPorts: [] as number[],
      exposedPorts: [] as number[],
      suggestedPort: 5900,
      ok: false,
    };
    let conn: Client | undefined;
    try {
      let stdout: string;
      if (host.authMode === "password") {
        conn = await connectSsh(this.store, hostId);
        stdout = await execCapture(conn, PREFLIGHT_COMMAND, 15_000);
      } else {
        const result = await runRemote(
          { host: host.host, port: host.port, username: host.username, keyPath: host.keyPath, timeoutMs: 15_000 },
          PREFLIGHT_COMMAND,
          "bash",
        );
        if (!result.ok && !result.stdout.trim()) {
          throw new Error(result.stderr.trim() || `SSH exited with code ${result.code ?? "unknown"}`);
        }
        stdout = result.stdout;
      }
      const parsed = parsePreflight(stdout);
      const elevation: VncPreflight["elevation"] =
        parsed.elevation === "root" || parsed.elevation === "nopasswd" || parsed.elevation === "password" || parsed.elevation === "none"
          ? parsed.elevation
          : "unknown";
      const byPort = new Map<number, string[]>();
      for (const entry of parsed.entries) {
        const addresses = byPort.get(entry.port) ?? [];
        addresses.push(entry.address);
        byPort.set(entry.port, addresses);
      }
      const ports = [...byPort.keys()].sort((a, b) => a - b);
      const loopbackPorts = ports.filter((port) => (byPort.get(port) ?? []).some(isLoopbackAddress));
      const wildcardPorts = ports.filter((port) => (byPort.get(port) ?? []).some(isWildcardAddress));
      const exposedPorts = ports.filter((port) => (byPort.get(port) ?? []).some((address) => !isLoopbackAddress(address)));
      const suggestedPort = loopbackPorts[0] ?? wildcardPorts[0] ?? 5900;
      const ok = loopbackPorts.length > 0 || wildcardPorts.length > 0;
      const suffix = parsed.daemon ? ` (${parsed.daemon})` : "";
      const detail = loopbackPorts.length
        ? `${loopbackPorts.map((port) => `127.0.0.1:${port}`).join(", ")}${suffix} reachable through the SSH tunnel.`
        : wildcardPorts.length
          ? `${wildcardPorts.map((port) => `0.0.0.0:${port}`).join(", ")}${suffix} works through the tunnel but is reachable beyond loopback; bind it to 127.0.0.1.`
          : exposedPorts.length
            ? `Port ${exposedPorts.join(", ")} is bound to a non-loopback address; the SSH tunnel cannot reach it.`
            : "No VNC listener on ports 5900-5999. Start a daemon bound to 127.0.0.1.";
      return {
        ...base,
        hostname: parsed.hostname,
        checkedAt: Date.now(),
        latencyMs: Date.now() - started,
        ports,
        loopbackPorts,
        exposedPorts,
        suggestedPort,
        daemon: parsed.daemon,
        elevation,
        // The stored SSH password doubles as the sudo secret on password-auth
        // hosts; a key-auth host has nothing to pipe, so it must be typed.
        needsSudoPassword: !ok && elevation === "password" && host.authMode !== "password",
        ok,
        detail,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        checkedAt: Date.now(),
        latencyMs: Date.now() - started,
        detail: `Preflight failed: ${message}`,
        error: message,
      };
    } finally {
      try {
        conn?.end();
      } catch {
        /* already closed */
      }
    }
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.closed = true;
    clearTimeout(session.expiry);
    this.sessions.delete(id);
    try {
      session.socket?.close();
    } catch {
      /* already closed */
    }
    try {
      session.stream?.close();
    } catch {
      /* already closed */
    }
    try {
      session.ssh?.end();
    } catch {
      /* already closed */
    }
    await new Promise<void>((resolve) => {
      session.server.close(() => resolve());
      setTimeout(resolve, 500);
    });
  }

  async closeHost(hostId: string): Promise<void> {
    const ids = [...this.sessions.values()].filter((session) => session.public.hostId === hostId).map((session) => session.public.id);
    await Promise.all(ids.map((id) => this.close(id)));
  }
}

export const vnc = new VncService();
