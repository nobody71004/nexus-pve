#!/usr/bin/env node
import path from "node:path";
import type { NexusEvent } from "../shared/types";
import { createRuntime } from "./agent/runtime";
import type { ToolContext } from "./agent/registry";

/**
 * Nexus PVE MCP server — stdio transport, JSON-RPC 2.0, newline-delimited.
 * It runs headless and shares the same config/vault as the desktop app, so an
 * agent can drive Proxmox (and build this app) with the window closed.
 */
const VERSION = "1.0.0";
const PROTOCOL = "2024-11-05";
const appRoot = path.resolve(__dirname, "..");

const emit = (event: NexusEvent) => {
  if (event.type === "pipeline" && event.run) {
    log(`pipeline ${event.run.name}: ${event.run.status}`);
  }
};

function log(message: string): void {
  process.stderr.write(`[nexus-mcp] ${message}\n`);
}

const runtime = createRuntime(appRoot, emit);

const ctx: ToolContext = {
  store: runtime.store,
  appRoot,
  emit,
};

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

function send(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
}

function sendResult(id: JsonRpcId, result: unknown): void {
  send({ id, result });
}

function sendError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

const INSTRUCTIONS = `Nexus PVE controls Proxmox VE hosts and this app itself.

Read tools: hosts.list, fleet.overview, node.detail, node.rrd, vms.list, vm.detail,
tasks.list, task.log, backup.list, snapshot.list, pipeline.list, pipeline.status, audit.tail.

Mutating tools: vm.action, snapshot.create, backup.run, backup.schedule.save, pipeline.run.
Destructive tools (require "confirm": true): vm.action for stop/reset/reboot/shutdown,
snapshot.rollback, snapshot.delete, backup.restore, backup.remove, backup.schedule.delete.

Start a pipeline with pipeline.run { pipeline, host, vars, waitSeconds } (waitSeconds
caps at 60). Pipelines pause on destructive steps: inspect with pipeline.status, then
continue with pipeline.approve { runId, approve: true }. Never approve a step you have
not read. audit.tail shows every mutation already applied by this agent.
Linux hosts: ssh.hosts, ssh.status, ssh.speedtest, ssh.helper are safe reads. ssh.helper.install
installs the root helper and sudoers drop-in (gated). ssh.power, ssh.service, ssh.backup and
ssh.exec are gated too.
DDoS shield: ddos.overview, ddos.status, ddos.rules and ddos.journal are read-only. ddos.mode changes the edge posture; ddos.config pushes rate limits, forwards or the allowlist; ddos.unban and ddos.allow edit containment. ddos.install re-images the edge daemon and ddos.ban adds a source to the drop set; both require "confirm": true. The shield runs on the edge itself, so protection continues with this app closed. The edge host is auto-selected from SSH hosts labelled edge, relay, or shield.
security.enforce (fixed remediation ids), security.resident and security.policy change a
host; security.contain bans an address. security.enforce and security.contain require
"confirm": true. The guard refuses to ban loopback, link-local or any address holding a
live SSH session, and refuses a policy file it did not sign.
Security tools: security.overview, security.scan, security.journal are safe reads/runs.
Development tools (dev.tree/read_file/write_file/build/typecheck/smoke/package) operate
only inside the app directory; writes are backed up under .nexus-backup/.`;

function toolList() {
  return runtime.registry.list().map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: tool.category === "read",
      destructiveHint: tool.category === "destructive",
    },
  }));
}

async function handleToolCall(id: JsonRpcId, params: Record<string, unknown> | undefined): Promise<void> {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = (params?.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
  const tool = runtime.registry.get(name);
  if (!tool) {
    sendError(id, -32602, `Unknown tool: ${name}`);
    return;
  }
  try {
    const result = await tool.run(args, ctx);
    sendResult(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`${name} failed: ${message}`);
    sendResult(id, {
      content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
      isError: true,
    });
  }
}

async function dispatch(message: JsonRpcMessage): Promise<void> {
  const id = message.id ?? null;
  const method = message.method ?? "";

  switch (method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "nexus-pve", version: VERSION },
        instructions: INSTRUCTIONS,
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      sendResult(id, {});
      return;
    case "tools/list":
      sendResult(id, { tools: toolList() });
      return;
    case "tools/call":
      await handleToolCall(id, message.params);
      return;
    case "resources/list":
      sendResult(id, { resources: [] });
      return;
    case "prompts/list":
      sendResult(id, { prompts: [] });
      return;
    default:
      if (message.id === undefined) return; // unknown notification: ignore
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

function handleLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(trimmed) as JsonRpcMessage;
  } catch {
    sendError(null, -32700, "Parse error");
    return;
  }
  void dispatch(message).catch((err) => {
    log(`dispatch failed: ${err instanceof Error ? err.stack : String(err)}`);
    if (message.id !== undefined) sendError(message.id ?? null, -32603, String(err));
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (buffer.trim()) handleLine(buffer);
  process.exit(0);
});

log(`ready — ${runtime.registry.list().length} tools, ${runtime.store.hosts().length} hosts, ${runtime.pipelines.definitions().length} pipelines`);
