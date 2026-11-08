import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export type PveAuth =
  | { mode: "token"; tokenId: string; secret: string }
  | { mode: "password"; username: string; secret: string };

export interface PveClientOptions {
  baseUrl: string;
  auth: PveAuth;
  tlsVerify: boolean;
  timeoutMs?: number;
}

export type PveParams = Record<string, string | number | boolean | string[] | undefined | null>;

export class PveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PveError";
  }
}

interface RawResponse {
  status: number;
  text: string;
  fingerprint?: string;
}

function encodeParams(params: PveParams = {}): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else if (typeof value === "boolean") {
      search.append(key, value ? "1" : "0");
    } else {
      search.append(key, String(value));
    }
  }
  return search;
}

/**
 * A single Proxmox VE endpoint. Handles both API tokens (preferred: no ticket
 * lifetime, scoped permissions) and password tickets (with CSRF token).
 */
export class PveClient {
  private readonly base: URL;
  private ticket?: string;
  private csrf?: string;
  private fingerprint?: string;

  constructor(private readonly opts: PveClientOptions) {
    this.base = new URL(opts.baseUrl);
    if (!this.base.port) this.base.port = "8006";
  }

  get tlsFingerprint(): string | undefined {
    return this.fingerprint;
  }

  private async login(): Promise<void> {
    if (this.opts.auth.mode !== "password") return;
    const body = new URLSearchParams({
      username: this.opts.auth.username,
      password: this.opts.auth.secret,
    }).toString();
    const res = await this.raw("POST", "/access/ticket", undefined, body, true);
    const parsed = JSON.parse(res.text) as { data?: { ticket?: string; CSRFPreventionToken?: string } };
    if (!parsed.data?.ticket) throw new PveError("Login failed: no ticket returned", res.status, parsed);
    this.ticket = parsed.data.ticket;
    this.csrf = parsed.data.CSRFPreventionToken;
  }

  private raw(
    method: string,
    path: string,
    search?: URLSearchParams,
    body?: string,
    skipAuth = false,
  ): Promise<RawResponse> {
    const url = new URL(path, this.base);
    if (!url.pathname.startsWith("/api2/json")) url.pathname = `/api2/json${url.pathname}`;
    if (search && [...search.keys()].length > 0) url.search = search.toString();

    const isHttps = url.protocol === "https:";
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "NexusPVE/1.0",
    };

    if (!skipAuth) {
      if (this.opts.auth.mode === "token") {
        headers.Authorization = `PVEAPIToken=${this.opts.auth.tokenId}=${this.opts.auth.secret}`;
      } else if (this.ticket) {
        headers.Cookie = `PVEAuthCookie=${encodeURIComponent(this.ticket)}`;
        if (method !== "GET") headers.CSRFPreventionToken = this.csrf ?? "";
      }
    }
    if (body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(body).toString();
    }

    const transport = isHttps ? https : http;
    const reqOptions: https.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: this.opts.timeoutMs ?? 15000,
    };
    if (isHttps) {
      reqOptions.rejectUnauthorized = this.opts.tlsVerify;
      reqOptions.servername = url.hostname;
    }

    return new Promise<RawResponse>((resolve, reject) => {
      const req = transport.request(reqOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const socket = res.socket as import("node:tls").TLSSocket | null;
          if (socket && typeof socket.getPeerCertificate === "function") {
            const cert = socket.getPeerCertificate();
            if (cert && cert.fingerprint256) this.fingerprint = cert.fingerprint256;
          }
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
            fingerprint: this.fingerprint,
          });
        });
      });
      req.on("timeout", () => req.destroy(new PveError(`Request timed out after ${reqOptions.timeout} ms`)));
      req.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN") {
          reject(new PveError("TLS certificate is self-signed. Enable 'allow self-signed' for this host."));
        } else if (code === "ECONNREFUSED") {
          reject(new PveError(`Connection refused by ${url.host} — is the Proxmox web UI/API on port ${url.port}?`));
        } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
          reject(new PveError(`Host not found: ${url.hostname}`));
        } else {
          reject(err);
        }
      });
      if (body) req.write(body);
      req.end();
    });
  }

  private parse<T>(res: RawResponse): T {
    if (res.status === 401) {
      throw new PveError("Authentication rejected (401). Check the token id/secret or user password.", 401, res.text);
    }
    let parsed: unknown;
    try {
      parsed = res.text ? JSON.parse(res.text) : {};
    } catch {
      if (res.status >= 200 && res.status < 300) return res.text as unknown as T;
      throw new PveError(`HTTP ${res.status}: ${res.text.slice(0, 300)}`, res.status);
    }
    if (res.status < 200 || res.status >= 300) {
      const envelope = parsed as { errors?: Record<string, string>; message?: string };
      const detail = envelope.errors ? Object.entries(envelope.errors).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
      throw new PveError(detail || envelope.message || `HTTP ${res.status}`, res.status, parsed);
    }
    return (parsed as { data?: T }).data as T;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    params?: PveParams,
    retry = true,
  ): Promise<T> {
    if (this.opts.auth.mode === "password" && !this.ticket) await this.login();

    const encoded = encodeParams(params);
    const body = method === "GET" ? undefined : encoded.toString();
    const res = await this.raw(method, path, method === "GET" ? encoded : undefined, body);

    if (res.status === 401 && this.opts.auth.mode === "password" && retry) {
      // Ticket expired (2h default). Re-authenticate once and replay.
      this.ticket = undefined;
      await this.login();
      return this.request<T>(method, path, params, false);
    }
    return this.parse<T>(res);
  }

  get<T>(path: string, params?: PveParams): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  post<T>(path: string, params?: PveParams): Promise<T> {
    return this.request<T>("POST", path, params);
  }

  put<T>(path: string, params?: PveParams): Promise<T> {
    return this.request<T>("PUT", path, params);
  }

  del<T>(path: string, params?: PveParams): Promise<T> {
    return this.request<T>("DELETE", path, params);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof PveError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export const enc = encodeURIComponent;
