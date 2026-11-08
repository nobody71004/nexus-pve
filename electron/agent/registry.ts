import type { ConfigStore } from "../config";
import type { NexusEvent } from "../../shared/types";
import { recordAudit, summarizeArgs } from "./audit";

export type ToolCategory = "read" | "mutate" | "destructive" | "dev";

export interface JsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  store: ConfigStore;
  hostId?: string;
  /** Ask a human (desktop dialog / MCP confirm flag) before a destructive step. */
  approve?: (request: { title: string; tool: string; args: Record<string, unknown> }) => Promise<boolean>;
  emit?: (event: NexusEvent) => void;
  signal?: AbortSignal;
  appRoot: string;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  category: ToolCategory;
  inputSchema: JsonSchema;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
    // Every non-read call is audited here rather than at each call site, so the
    // desktop IPC, the pipeline engine and the MCP server all share one trail.
    const audited: ToolDef = {
      ...def,
      run: async (args, ctx) => {
        const auditable =
          def.category === "mutate" ||
          def.category === "destructive" ||
          (def.category === "dev" && def.name !== "dev.tree" && def.name !== "dev.read_file");
        try {
          const result = await def.run(args, ctx);
          if (auditable) {
            recordAudit({ tool: def.name, category: def.category, args: summarizeArgs(args ?? {}), ok: true });
          }
          return result;
        } catch (error) {
          if (auditable) {
            recordAudit({
              tool: def.name,
              category: def.category,
              args: summarizeArgs(args ?? {}),
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
      },
    };
    this.tools.set(def.name, audited);
  }

  list(): ToolDef[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  async call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.run(args ?? {}, ctx);
  }
}

export function resolveHostId(args: Record<string, unknown>, ctx: ToolContext): string {
  const requested = typeof args.host === "string" && args.host.trim() ? args.host.trim() : undefined;
  if (requested) {
    const direct = ctx.store.host(requested);
    if (direct) return direct.id;
    const byLabel = ctx.store.hosts().find((host) => host.label.toLowerCase() === requested.toLowerCase());
    if (byLabel) return byLabel.id;
    throw new Error(`No host matches "${requested}". Use hosts.list to see configured hosts.`);
  }
  if (ctx.hostId && ctx.store.host(ctx.hostId)) return ctx.hostId;
  const hosts = ctx.store.hosts();
  if (hosts.length === 1) return hosts[0].id;
  if (hosts.length === 0) throw new Error("No Proxmox hosts configured. Add one in Nexus PVE first.");
  throw new Error(`Several hosts are configured; pass "host". Options: ${hosts.map((h) => h.label).join(", ")}`);
}

export async function confirmDestructive(
  ctx: ToolContext,
  args: Record<string, unknown>,
  request: { title: string; tool: string; args: Record<string, unknown> },
): Promise<void> {
  if (ctx.approve) {
    const ok = await ctx.approve(request);
    if (!ok) throw new Error("Cancelled: the operator declined this destructive action.");
    return;
  }
  if (args.confirm !== true) {
    throw new Error(
      `Refusing destructive action without confirmation. Re-send with "confirm": true (and prefer a dry run first).`,
    );
  }
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`"${key}" is required`);
  return value.trim();
}

export function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = Number(args[key]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`"${key}" must be a positive number`);
  return value;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  if (args[key] === undefined || args[key] === null || args[key] === "") return undefined;
  const value = Number(args[key]);
  if (!Number.isFinite(value)) throw new Error(`"${key}" must be a number`);
  return value;
}

export function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** exponent;
  return `${scaled.toFixed(scaled >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
