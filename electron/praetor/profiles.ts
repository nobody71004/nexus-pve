import fs from "node:fs";
import path from "node:path";
import type { PraetorProfile, PraetorProfileColor, PraetorSuite, SshHostSummary } from "../../shared/types";
import { nexusHome } from "../paths";

const PRAETOR_PORT = 9443;
const PROFILE_VERSION = 1;

interface ProfileFile {
  version: number;
  hosts: Record<string, {
    label: string;
    endpoint: string;
    publicKey: string;
    profiles: PraetorProfile[];
    updatedAt: number;
  }>;
}

const SUITES: Array<{
  suite: PraetorSuite;
  description: string;
  tags: string[];
  color: PraetorProfileColor;
  autoConnect: boolean;
}> = [
  {
    suite: "PSEAL",
    description: "Default PRAETOR/1 profile: SIV + commitment record protection over a pinned hybrid X-Wing handshake.",
    tags: ["pq", "siv", "default", "nexus"],
    color: "mint",
    autoConnect: true,
  },
  {
    suite: "FAST",
    description: "Throughput-sensitive routing profile; the current egress negotiates PSEAL.",
    tags: ["pq", "aes-gcm", "opt-in", "nexus"],
    color: "violet",
    autoConnect: false,
  },
  {
    suite: "BOLT",
    description: "Lower per-cell cost routing profile; the current egress negotiates PSEAL.",
    tags: ["pq", "aegis", "opt-in", "nexus"],
    color: "amber",
    autoConnect: false,
  },
  {
    suite: "PMARINE",
    description: "Experimental PMARINE (PSEAL/2) preset over AEGIS-256; the current egress negotiates PSEAL.",
    tags: ["pq", "aegis-256", "experimental", "nexus"],
    color: "ice",
    autoConnect: false,
  },
];

export function profilesPath(): string {
  return path.join(nexusHome(), "praetor", "profiles.json");
}

function emptyState(): ProfileFile {
  return { version: PROFILE_VERSION, hosts: {} };
}

function readState(): ProfileFile {
  const file = profilesPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProfileFile>;
    if (parsed.version !== PROFILE_VERSION || !parsed.hosts || typeof parsed.hosts !== "object") return emptyState();
    return { version: PROFILE_VERSION, hosts: parsed.hosts };
  } catch {
    return emptyState();
  }
}

function writeState(state: ProfileFile): void {
  const file = profilesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function profileEndpoint(host: SshHostSummary): string {
  const raw = host.host.trim();
  const bracketed = raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw;
  return `${bracketed}:${PRAETOR_PORT}`;
}

export function readHostProfiles(hostId: string): PraetorProfile[] {
  const entry = readState().hosts[hostId];
  return Array.isArray(entry?.profiles) ? entry.profiles : [];
}

export function readProfilesForHosts(hostIds: string[]): Record<string, PraetorProfile[]> {
  const state = readState();
  const result: Record<string, PraetorProfile[]> = {};
  for (const id of hostIds) result[id] = Array.isArray(state.hosts[id]?.profiles) ? state.hosts[id].profiles : [];
  return result;
}

export function buildProfiles(host: SshHostSummary, publicKey: string, previous: PraetorProfile[] = []): PraetorProfile[] {
  const key = publicKey.replace(/\s+/g, "");
  if (!key || Buffer.from(key, "base64").length !== 1216) {
    throw new Error("PRAETOR server public key is not a 1,216-byte X-Wing public key");
  }
  const now = new Date().toISOString();
  const bySuite = new Map(previous.map((profile) => [profile.suite, profile]));
  return SUITES.map((entry) => {
    const old = bySuite.get(entry.suite);
    return {
      id: `nexus-${host.id}-${entry.suite.toLowerCase()}`,
      name: `Nexus ${host.label} ${entry.suite}`.slice(0, 80),
      description: entry.description.slice(0, 300),
      location: host.label.slice(0, 80),
      endpoint: profileEndpoint(host),
      protocol: "PRAETOR/1",
      suite: entry.suite,
      transport: "tcp",
      cellSize: 1024,
      serverPublicKey: key,
      autoConnect: entry.autoConnect,
      tags: entry.tags,
      color: entry.color,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
  });
}

export function saveHostProfiles(host: SshHostSummary, profiles: PraetorProfile[]): void {
  const state = readState();
  state.hosts[host.id] = {
    label: host.label,
    endpoint: profileEndpoint(host),
    publicKey: profiles[0]?.serverPublicKey ?? "",
    profiles,
    updatedAt: Date.now(),
  };
  writeState(state);
}

/** Return only profiles that still map to a configured host. */
export function allProfiles(): PraetorProfile[] {
  const state = readState();
  return Object.values(state.hosts).flatMap((entry) => entry.profiles);
}
