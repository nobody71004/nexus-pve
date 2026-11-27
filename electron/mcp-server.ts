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
const VERSION = "1.3.0";
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

Read tools: hosts.list, fleet.overview, node.detail, node.rrd, vms.list, vm.detail, sshkey.overview,
tasks.list, task.log, backup.list, snapshot.list, pipeline.list, pipeline.status, audit.tail,
praetor.overview, praetor.plan, praetor.profiles.

Mutating tools: vm.action, snapshot.create, backup.run, backup.schedule.save, pipeline.run.
Destructive tools (require "confirm": true): vm.action for stop/reset/reboot/shutdown,
snapshot.rollback, snapshot.delete, backup.restore, backup.remove, backup.schedule.delete,
praetor.install, praetor.install_all, praetor.rotate.

Start a pipeline with pipeline.run { pipeline, host, vars, waitSeconds } (waitSeconds
caps at 60). Pipelines pause on destructive steps: inspect with pipeline.status, then
continue with pipeline.approve { runId, approve: true }. Never approve a step you have
not read. audit.tail shows every mutation already applied by this agent.
Linux hosts: ssh.hosts, ssh.status, ssh.speedtest, ssh.helper are safe reads. ssh.helper.install
installs the root helper and sudoers drop-in (gated). ssh.power, ssh.service, ssh.backup and
ssh.exec are gated too.
Service install and lifecycle (the way to add a service a host does not have yet):
ssh.services is a safe read of every systemd unit (active/enabled), failed unit, docker container
and compose project. ssh.service.status and ssh.service.logs are safe reads too.
ssh.service.install apt-installs a package and then enables and starts the unit it ships;
ssh.service.create writes a unit from an exec line, enables and starts it;
ssh.service.remove deletes a unit Nexus wrote (refusing distro units); ssh.pkg runs apt
install/remove/update/upgrade; ssh.docker applies and manages docker compose projects under
/opt/nexus and lists or controls containers. ssh.service.control does start/stop/restart/
enable/disable. All of those mutations and removals require "confirm": true, and every
privileged step runs through /usr/local/sbin/nexus-priv, so a key-only host needs the helper
installed and current (ssh.helper, ssh.helper.install). A package whose unit name differs
from its package name needs "unit"; when no unit matches, the install says so rather than
reporting a service that is not running.
Machine control spans Linux hosts and Proxmox nodes: machines.list is a safe read. machines.shell is the
full SSH surface: any bash command, pipes/redirection/here-docs, cwd, env and stdin, on "ssh:<host-id>"
or "pve:<endpoint>/<node>" (a Proxmox node needs a matching Linux host; the API cannot run commands).
Set elevate:"auto" to run as root through root, a NOPASSWD grant or the stored password (sudo -S on
stdin); elevate:"none" (default) runs as the login account. The role argument applies the permission
matrix: system/superadmin/admin are unrestricted with elevation, moderator is unrestricted without
elevation, user is read-only diagnostics. machines.shell.policy prints the matrix, the member
allowlist and the audit fields. Every call is recorded in audit.jsonl with host, role, command,
route, exit code and duration, including refusals. machines.exec uses the same engine.
machines.vnc.preflight is a safe read; machines.vnc.setup installs the loopback terminal
console; machines.vnc.open returns a loopback-only ws://127.0.0.1 URL with a one-time token
that grants interactive console control, so treat it as a credential. open, setup and exec
require "confirm": true. machines.shell and machines.exec require "confirm": true too. machines.vnc.sessions and machines.vnc.close manage only the local
bridge. Fleet pipelines: console-sweep (read-only VNC readiness across every machine) and
fleet-command (gated command on every mapped Linux host and Proxmox node). Start either with
pipeline.run { pipeline, host: "fleet", vars: { command, shell } }.
DDoS shield: ddos.overview, ddos.status, ddos.rules and ddos.journal are read-only. ddos.mode changes the edge posture; ddos.config pushes rate limits, forwards or the allowlist; ddos.unban and ddos.allow edit containment. ddos.install re-images the edge daemon and ddos.ban adds a source to the drop set; both require "confirm": true. The shield runs on the edge itself, so protection continues with this app closed. The edge host is auto-selected from SSH hosts labelled edge, relay, or shield.
security.enforce (fixed remediation ids), security.resident and security.policy change a
host; security.contain bans an address. security.enforce and security.contain require
"confirm": true. The guard refuses to ban loopback, link-local or any address holding a
live SSH session, and refuses a policy file it did not sign.
SSH key control plane: sshkey.overview, sshkey.generate, sshkey.deploy, sshkey.scan,
sshkey.trust and sshkey.policy manage the encrypted Ed25519 vault, per-host
authorized_keys inventory, trust baseline and 24/7 watcher. Private keys never leave the
local vault. Deploying appends the public key and points the host at the managed private
key. sshkey.enforce removes unmanaged keys after a backup, always protects the current
login key, and refuses if no managed/trusted key would remain. sshkey.enforce and
sshkey.revoke require "confirm": true; automatic enforcement is opt-in.
Security tools: security.overview, security.scan, security.journal are safe reads/runs.
PRAETOR egress: praetor.overview, praetor.plan and praetor.profiles are read-only.
praetor.install pushes the egress, per-host X-Wing key, systemd units, firewall rule
(including an idempotent Proxmox host rule) and four client profiles to one SSH host;
praetor.install_all does the same across the fleet. praetor.rotate regenerates one host's
X-Wing keypair and overwrites every client pin location (host profiles.json and the four
local profiles); it restores the old keypair and pins if the egress does not come back.
A host whose TCP 9443 endpoint stays blocked is reported as a failed rollout.
praetor.install, praetor.install_all and praetor.rotate require "confirm": true. Proxmox
nodes need a matching SSH inventory entry; the tools never invent one.
App and inventory tools: app.overview reports version, paths, runtime and counts; app.settings and
app.settings.save read or patch uiScale, pollMs, accent, motion and GPU alert thresholds.
fleet.inventory returns every configured Proxmox endpoint and SSH host without secrets. hosts.save
creates or updates a Proxmox endpoint (secret encrypted, never returned); hosts.remove deletes one.
ssh.hosts.save creates or updates an SSH inventory entry; ssh.hosts.remove deletes it. Both removals
require "confirm": true.
Team tools: team.directory reads accounts, roles, statuses, machines and grants straight from
team.sqlite without a password and without writing, so it is safe while the desktop app is open.
team.user.create, team.user.update, team.user.grant and team.user.delete act as the workspace
super admin through an audited headless session (auth.agent); they refuse to run while the desktop
app is open because the app flushes its in-memory database on exit. team.user.delete requires
"confirm": true.
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
