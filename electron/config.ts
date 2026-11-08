import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configPath, nexusHome } from "./paths";
import { decryptSecret, encryptSecret } from "./vault";
import type { HostInput, HostSummary, SshHostInput, SshHostSummary } from "../shared/types";

export interface StoredHost extends HostSummary {
  secretEnc?: string;
}

export interface StoredSshHost extends SshHostSummary {
  /** Password for authMode "password", AES-256-GCM like the Proxmox token. */
  secretEnc?: string;
}

function publicSshHost(host: StoredSshHost): SshHostSummary {
  const { secretEnc: _secretEnc, ...rest } = host;
  return rest;
}

export interface AppSettings {
  pollMs: number;
  accent: "cyan" | "violet" | "amber";
  reduceMotion: boolean;
  confirmDestructive: boolean;
}

export interface StoredConfig {
  version: 1;
  activeHostId?: string;
  hosts: StoredHost[];
  sshHosts: StoredSshHost[];
  settings: AppSettings;
}

const DEFAULTS: AppSettings = {
  pollMs: 8000,
  accent: "cyan",
  reduceMotion: false,
  confirmDestructive: true,
};

function blank(): StoredConfig {
  return { version: 1, hosts: [], sshHosts: [], settings: { ...DEFAULTS } };
}

export function normalizeBaseUrl(raw: string): string {
  let value = (raw || "").trim();
  if (!value) throw new Error("Host address is required");
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Host address must use http or https");
  }
  if (!url.port) url.port = url.protocol === "https:" ? "8006" : "8006";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function publicHost(host: StoredHost): HostSummary {
  const { secretEnc: _secretEnc, ...rest } = host;
  return rest;
}

/**
 * Optional headless host, so the MCP server can run on a server with no
 * desktop profile: NEXUS_PVE_URL plus NEXUS_PVE_TOKEN=user@realm!token=secret
 * (or NEXUS_PVE_TOKEN_ID / NEXUS_PVE_TOKEN_SECRET). It is never persisted.
 */
const ENV_HOST_ID = "env-host";
let envSecret: string | undefined;

function envHost(): StoredHost | null {
  const rawUrl = process.env.NEXUS_PVE_URL;
  if (!rawUrl) {
    envSecret = undefined;
    return null;
  }
  let tokenId = process.env.NEXUS_PVE_TOKEN_ID;
  let secret = process.env.NEXUS_PVE_TOKEN_SECRET;
  const composite = process.env.NEXUS_PVE_TOKEN;
  if (composite) {
    const split = composite.indexOf("=");
    if (split > 0) {
      tokenId = composite.slice(0, split);
      secret = composite.slice(split + 1);
    }
  }
  envSecret = secret;
  let baseUrl = rawUrl;
  try {
    baseUrl = normalizeBaseUrl(rawUrl);
  } catch {
    return null;
  }
  return {
    id: ENV_HOST_ID,
    label: process.env.NEXUS_PVE_LABEL || new URL(baseUrl).hostname,
    baseUrl,
    authMode: "token",
    tokenId,
    tlsVerify: process.env.NEXUS_PVE_TLS_VERIFY === "1",
    color: "#38f2ff",
    hasSecret: Boolean(secret),
    createdAt: 0,
  };
}

export class ConfigStore {
  readonly file = configPath();

  constructor(private readonly dir = nexusHome()) {}

  private ensure() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.dir, "pipelines"), { recursive: true });
  }

  /**
   * Always reads from disk. The desktop app, the MCP server and any agent all
   * share this one file, so an in-memory copy goes stale the moment another
   * process saves a host — and the next write would then erase its changes.
   * The file is a few kilobytes; re-reading is cheaper than losing a host.
   */
  read(): StoredConfig {
    this.ensure();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<StoredConfig>;
      const config: StoredConfig = {
        version: 1,
        activeHostId: raw.activeHostId,
        hosts: Array.isArray(raw.hosts) ? raw.hosts : [],
        sshHosts: Array.isArray(raw.sshHosts) ? raw.sshHosts : [],
        settings: { ...DEFAULTS, ...(raw.settings ?? {}) },
      };
      return config;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return blank();
      // Never destroy a corrupt file: move it aside so the user can recover tokens.
      const bad = path.join(this.dir, `config.corrupt-${Date.now()}.json`);
      try {
        fs.renameSync(this.file, bad);
      } catch {
        /* best effort */
      }
      return blank();
    }
  }

  write(config: StoredConfig): void {
    this.ensure();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows */
    }
  }

  hosts(): StoredHost[] {
    const configured = this.read().hosts;
    if (configured.length > 0) return configured;
    const headless = envHost();
    return headless ? [headless] : [];
  }

  host(id: string): StoredHost | undefined {
    return this.hosts().find((h) => h.id === id);
  }

  secretFor(id: string): string | undefined {
    if (id === ENV_HOST_ID) {
      envHost();
      return envSecret;
    }
    const enc = this.host(id)?.secretEnc;
    if (!enc) return undefined;
    return decryptSecret(enc);
  }

  saveHost(input: HostInput): HostSummary {
    const config = this.read();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const existing = input.id ? config.hosts.find((h) => h.id === input.id) : undefined;
    const id = existing?.id ?? crypto.randomUUID();
    const tokenId = input.tokenId?.trim() || undefined;
    const username = input.username?.trim() || undefined;

    if (input.authMode === "token" && !tokenId) throw new Error("API token id is required (user@realm!token)");
    if (input.authMode === "password" && !username) throw new Error("Username is required (user@realm)");
    if (!existing && !input.secret) throw new Error("Token secret or password is required");
    if (input.authMode === "token" && tokenId && !/^[^@\s]+@[^!\s]+![^!\s]+$/.test(tokenId)) {
      throw new Error("Token id must look like user@realm!tokenname");
    }

    const host: StoredHost = {
      id,
      label: input.label?.trim() || new URL(baseUrl).hostname,
      baseUrl,
      authMode: input.authMode,
      tokenId,
      username,
      tlsVerify: input.tlsVerify,
      color: input.color || existing?.color || pickColor(config.hosts.length),
      hasSecret: Boolean(input.secret) || Boolean(existing?.secretEnc),
      createdAt: existing?.createdAt ?? Date.now(),
      lastSeenAt: existing?.lastSeenAt,
      secretEnc: input.secret ? encryptSecret(input.secret) : existing?.secretEnc,
    };

    if (existing) {
      config.hosts = config.hosts.map((h) => (h.id === id ? host : h));
    } else {
      config.hosts = [...config.hosts, host];
    }
    if (!config.activeHostId) config.activeHostId = id;
    this.write(config);
    return publicHost(host);
  }

  removeHost(id: string): void {
    const config = this.read();
    config.hosts = config.hosts.filter((h) => h.id !== id);
    if (config.activeHostId === id) config.activeHostId = config.hosts[0]?.id;
    this.write(config);
  }

  /* ------------------------------------------------------- linux hosts */

  sshHosts(): StoredSshHost[] {
    return [...this.read().sshHosts].sort((left, right) => left.createdAt - right.createdAt);
  }

  sshSecretFor(id: string): string | undefined {
    const enc = this.read().sshHosts.find((host) => host.id === id)?.secretEnc;
    return enc ? decryptSecret(enc) : undefined;
  }

  sshHost(id: string): StoredSshHost | undefined {
    const direct = this.read().sshHosts.find((host) => host.id === id);
    if (direct) return direct;
    const needle = id.trim().toLowerCase();
    return this.read().sshHosts.find(
      (host) => host.label.toLowerCase() === needle || host.host.toLowerCase() === needle,
    );
  }

  saveSshHost(input: SshHostInput): SshHostSummary {
    const config = this.read();
    const hostname = (input.host || "").trim().replace(/^ssh:\/\//, "");
    if (!hostname || /\s/.test(hostname)) throw new Error("Host name or IP is required and cannot contain spaces");
    const port = Number(input.port ?? 22);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("Port must be 1-65535");
    const username = (input.username || "").trim();
    if (!username) throw new Error("SSH username is required");
    if (/\s/.test(username)) throw new Error("SSH username cannot contain spaces");
    const existing = input.id ? config.sshHosts.find((host) => host.id === input.id) : undefined;
    const id = existing?.id ?? crypto.randomUUID();
    const authMode = input.authMode === "password" ? "password" : "key";
    if (authMode === "key" && !input.keyPath?.trim()) {
      // Blank key path is meaningful: ssh falls back to the agent and default keys.
    }
    if (authMode === "password" && !input.password && !existing?.secretEnc) {
      throw new Error("Password is required for password authentication");
    }

    const host: StoredSshHost = {
      id,
      label: input.label?.trim() || hostname,
      host: hostname,
      port,
      username,
      authMode,
      keyPath: authMode === "key" ? input.keyPath?.trim() || undefined : undefined,
      hasSecret: Boolean(input.password) || Boolean(existing?.secretEnc && authMode === "password"),
      color: input.color || existing?.color || pickColor(config.sshHosts.length + 2),
      createdAt: existing?.createdAt ?? Date.now(),
      lastSeenAt: existing?.lastSeenAt,
      secretEnc:
        authMode === "password"
          ? input.password
            ? encryptSecret(input.password)
            : existing?.secretEnc
          : undefined,
    };

    config.sshHosts = existing
      ? config.sshHosts.map((entry) => (entry.id === id ? host : entry))
      : [...config.sshHosts, host];
    this.write(config);
    return publicSshHost(host);
  }

  publicSshHost(host: StoredSshHost): SshHostSummary {
    return publicSshHost(host);
  }

  removeSshHost(id: string): void {
    const config = this.read();
    config.sshHosts = config.sshHosts.filter((host) => host.id !== id);
    this.write(config);
  }

  touchSshHost(id: string): void {
    const config = this.read();
    config.sshHosts = config.sshHosts.map((host) => (host.id === id ? { ...host, lastSeenAt: Date.now() } : host));
    this.write(config);
  }

  touchHost(id: string): void {
    const config = this.read();
    config.hosts = config.hosts.map((h) => (h.id === id ? { ...h, lastSeenAt: Date.now() } : h));
    this.write(config);
  }

  setActive(id: string): void {
    const config = this.read();
    if (config.hosts.some((h) => h.id === id)) {
      config.activeHostId = id;
      this.write(config);
    }
  }

  settings(): AppSettings {
    return this.read().settings;
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    const config = this.read();
    config.settings = { ...config.settings, ...patch };
    this.write(config);
    return config.settings;
  }
}

const PALETTE = ["#38f2ff", "#7c5cff", "#3dffa8", "#ffb347", "#ff5c8a", "#5cc8ff"];
function pickColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

export const configStore = new ConfigStore();
