import fs from "node:fs";
import path from "node:path";
import { nexusHome } from "../paths";
import type { ToolRegistry } from "./registry";

/**
 * Append-only audit trail of every mutating, destructive or dev tool call.
 * One JSON object per line, mode 0600, rotated once at 2 MB. This is what lets
 * an operator answer "what did the agent actually do to my cluster?" after a run
 * and is deliberately separate from pipeline history, which only covers runs.
 */
export type AuditCategory = "mutate" | "destructive" | "dev";

export interface AuditEntry {
  at: number;
  tool: string;
  category: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

const MAX_BYTES = 2 * 1024 * 1024;

export const auditPath = () => path.join(nexusHome(), "audit.jsonl");

/** Keep argument excerpts small and never persist file bodies. */
export function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (key === "content" && typeof value === "string") {
      out.contentBytes = Buffer.byteLength(value);
      continue;
    }
    if (key === "password" || key === "secret" || key === "token") {
      out[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string" && value.length > 240) {
      out[key] = `${value.slice(0, 240)}…`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function recordAudit(entry: Omit<AuditEntry, "at">): void {
  try {
    const file = auditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        fs.renameSync(file, path.join(path.dirname(file), "audit.prev.jsonl"));
      }
    } catch {
      /* file does not exist yet */
    }
    fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    /* auditing must never break the action it records */
  }
}

export function readAudit(limit = 100): AuditEntry[] {
  try {
    const raw = fs.readFileSync(auditPath(), "utf8");
    const entries: AuditEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* skip a torn line after a crash */
      }
    }
    return entries.slice(-Math.max(1, Math.min(limit, 1000)));
  } catch {
    return [];
  }
}

export function registerAuditTools(registry: ToolRegistry): void {
  registry.register({
    name: "audit.tail",
    title: "Read the tool audit trail",
    description:
      "Chronological log of every mutating, destructive and dev tool call this app has made, including argument excerpts, success/failure and error text. Read-only.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Most recent N entries, default 100 (max 1000)" } },
    },
    async run(args) {
      const limit = Math.max(1, Math.min(1000, Number(args.limit ?? 100)));
      const entries = readAudit(limit);
      return {
        file: auditPath(),
        count: entries.length,
        entries: entries.map((entry) => ({
          ...entry,
          at: new Date(entry.at).toISOString(),
        })),
      };
    },
  });
}
