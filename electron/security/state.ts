import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SecurityJournalEntry, SecurityPolicy, SecurityVerify } from "../../shared/types";
import { nexusHome } from "../paths";
import { signPayload } from "../vault";

/**
 * Layer 1 — the guard's own state is tamper-evident.
 *
 * The policy is signed with a key derived from the machine-local vault key, so
 * editing policy.json by hand (for example flipping lockdown back to observe)
 * is detected and the guard refuses to run with the downgraded copy. The
 * journal is a SHA-256 hash chain: deleting or rewriting one line breaks every
 * later link.
 */

export const securityDir = () => path.join(nexusHome(), "security");

export function defaultPolicy(): SecurityPolicy {
  return {
    enabled: true,
    mode: "defend",
    intervalSec: 300,
    autoRemediate: false,
    resident: false,
    allowlist: [],
    maxBansPerRun: 3,
    banThreshold: 20,
    updatedAt: 0,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function ensureDir(): void {
  fs.mkdirSync(securityDir(), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(securityDir(), 0o700);
  } catch {
    /* Windows ACLs govern here. */
  }
}

export class PolicyStore {
  readonly file = path.join(securityDir(), "policy.json");
  private tamper = false;

  get tampered(): boolean {
    return this.tamper;
  }

  read(): SecurityPolicy {
    ensureDir();
    let parsed: { policy?: Partial<SecurityPolicy>; sig?: string };
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as typeof parsed;
    } catch {
      return defaultPolicy();
    }
    const merged: SecurityPolicy = { ...defaultPolicy(), ...(parsed.policy ?? {}) };
    const expected = signPayload(canonical(merged));
    if (!parsed.sig || parsed.sig !== expected) {
      // A policy the guard did not sign is attacker-controlled: keep the
      // feature visible but stop enforcing until a human re-saves it.
      this.tamper = true;
      return { ...merged, enabled: false, autoRemediate: false, resident: false };
    }
    this.tamper = false;
    return merged;
  }

  write(patch: Partial<SecurityPolicy>): SecurityPolicy {
    ensureDir();
    const current = this.read();
    const next: SecurityPolicy = { ...current, ...patch, updatedAt: Date.now() };
    if (!Number.isFinite(next.intervalSec) || next.intervalSec < 60) next.intervalSec = 60;
    if (next.intervalSec > 86_400) next.intervalSec = 86_400;
    if (!Number.isFinite(next.maxBansPerRun) || next.maxBansPerRun < 0) next.maxBansPerRun = 0;
    if (next.maxBansPerRun > 50) next.maxBansPerRun = 50;
    if (!Number.isFinite(next.banThreshold) || next.banThreshold < 3) next.banThreshold = 3;
    if (!Array.isArray(next.allowlist)) next.allowlist = [];
    next.allowlist = next.allowlist
      .map((item) => item.trim())
      .filter((item) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(item))
      .slice(0, 64);
    const payload = canonical(next);
    fs.writeFileSync(this.file, JSON.stringify({ policy: next, sig: signPayload(payload) }, null, 2), { mode: 0o600 });
    this.tamper = false;
    return next;
  }
}

const GENESIS = "genesis";

function entryHash(prev: string, entry: Omit<SecurityJournalEntry, "hash">): string {
  const base = `${prev}|${entry.seq}|${entry.at}|${entry.hostId}|${entry.kind}|${entry.message}`;
  // Records written before installs carried structured audit fields hash the
  // base only. Appending the extra fields solely when present keeps those
  // historical links valid instead of breaking the chain on upgrade.
  const audit = entry.route || entry.trigger ? `|${entry.route ?? ""}|${entry.trigger ?? ""}` : "";
  return crypto.createHash("sha256").update(base + audit).digest("hex");
}

export class SecurityJournal {
  readonly file = path.join(securityDir(), "journal.jsonl");

  list(limit = 200): SecurityJournalEntry[] {
    const entries = this.readAll();
    return entries.slice(Math.max(0, entries.length - Math.max(1, limit)));
  }

  append(input: Omit<SecurityJournalEntry, "seq" | "prev" | "hash">): SecurityJournalEntry {
    ensureDir();
    const entries = this.readAll();
    const prev = entries.length > 0 ? entries[entries.length - 1].hash : GENESIS;
    const draft: Omit<SecurityJournalEntry, "hash"> = {
      ...input,
      seq: (entries[entries.length - 1]?.seq ?? 0) + 1,
      prev,
    };
    const entry: SecurityJournalEntry = { ...draft, hash: entryHash(prev, draft) };
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }

  verify(): SecurityVerify {
    const entries = this.readAll();
    const corrupt = this.corruptLines();
    if (corrupt > 0) {
      return { ok: false, length: entries.length, brokenAt: corrupt, detail: "journal contains unparseable records" };
    }
    let prev = GENESIS;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const { hash: _hash, ...rest } = entry;
      const expected = entryHash(prev, rest);
      if (entry.prev !== prev || entry.hash !== expected || entry.seq !== index + 1) {
        return {
          ok: false,
          length: entries.length,
          brokenAt: entry.seq,
          detail: `chain breaks at record ${entry.seq} (${entry.at ? new Date(entry.at).toISOString() : "unknown"})`,
        };
      }
      prev = entry.hash;
    }
    return {
      ok: true,
      length: entries.length,
      detail: entries.length === 0 ? "journal is empty" : `${entries.length} records verified end to end`,
    };
  }

  private raw(): string {
    try {
      return fs.readFileSync(this.file, "utf8");
    } catch {
      return "";
    }
  }

  private corruptLines(): number {
    let count = 0;
    for (const line of this.raw().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as SecurityJournalEntry;
        if (typeof parsed.hash !== "string" || typeof parsed.seq !== "number") count += 1;
      } catch {
        count += 1;
      }
    }
    return count;
  }

  private readAll(): SecurityJournalEntry[] {
    const entries: SecurityJournalEntry[] = [];
    for (const line of this.raw().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as SecurityJournalEntry;
        if (typeof parsed.hash === "string" && typeof parsed.seq === "number") entries.push(parsed);
      } catch {
        // Malformed records are counted by corruptLines(), which fails verify().
      }
    }
    return entries;
  }

}

/* ---------------------------------------------------------------- baselines */

export type BaselineFile = Record<string, { updatedAt: number; values: Record<string, string> }>;

export class BaselineStore {
  readonly file = path.join(securityDir(), "baselines.json");

  read(): BaselineFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as BaselineFile;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  get(hostId: string): Record<string, string> {
    return this.read()[hostId]?.values ?? {};
  }

  save(hostId: string, values: Record<string, string>): void {
    ensureDir();
    const all = this.read();
    all[hostId] = { updatedAt: Date.now(), values };
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
  }
}
