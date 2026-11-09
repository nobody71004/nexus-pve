import crypto from "node:crypto";
import type { RawData, WebSocketServer as Wss } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import { Client } from "ssh2";
import type { ClientChannel } from "ssh2";
import type { ConfigStore } from "../config";
import { configStore } from "../config";
import { keyMaterial } from "../ssh/transport";
import type { VncSession } from "../../shared/fabric-types";

interface ActiveSession {
  public: VncSession;
  server: Wss;
  ssh: Client;
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

    const ssh = await connectSsh(this.store, hostId).catch((err) => {
      server.close();
      throw err;
    });

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
          ws.close();
        } catch {
          /* already closed */
        }
      };

      // noVNC sends the RFB version as soon as the socket opens. Keep those
      // bytes until ssh2 finishes forwardOut instead of dropping the handshake.
      ws.on("message", (data) => {
        const chunk = rawToBuffer(data);
        if (stream?.writable) stream.write(chunk);
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
      session.ssh.end();
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
