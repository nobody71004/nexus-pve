import { confirmDestructive, optionalNumber, requireString, type ToolRegistry } from "./registry";
import {
  isShellRole,
  readOnlyCommandList,
  resolveShellTarget,
  runShell,
  shellPolicyFor,
  shellPolicyMatrix,
  type ShellElevation,
  type ShellRole,
} from "../ssh/shell";

function parseRole(args: Record<string, unknown>): ShellRole {
  if (args.role === undefined) return "system";
  if (!isShellRole(args.role)) {
    throw new Error('role must be one of "system", "superadmin", "admin", "moderator" or "user"');
  }
  return args.role;
}

function parseElevation(args: Record<string, unknown>, role: ShellRole): ShellElevation {
  if (args.elevate === true) return "auto";
  if (args.elevate === undefined || args.elevate === false || args.elevate === "none") return "none";
  if (args.elevate === "auto" || args.elevate === "sudo") return args.elevate;
  throw new Error('elevate must be "none", "auto", "sudo" or a boolean');
}

function parseEnv(args: Record<string, unknown>): Record<string, string> | undefined {
  const raw = args.env;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error('"env" must be an object of string values');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") throw new Error(`env.${key} must be a string`);
    env[key] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export function registerShellTools(registry: ToolRegistry): void {
  registry.register({
    name: "machines.shell",
    title: "Full shell on a Linux host or Proxmox node",
    description:
      "Run any command through bash on a Linux host or a Proxmox node's SSH transport: pipes, redirection, here-docs, multiple statements, working directory, environment and stdin. " +
      "This is the normal SSH surface — install packages, edit files, run installers, use docker/pct/qm, read services. " +
      "The role decides the boundary: system, superadmin and admin get unrestricted shell with sudo elevation; moderator gets unrestricted shell as the login account without elevation; " +
      "user gets read-only diagnostics. Destructive and gated: requires confirm:true. Every call is audit-logged with the command, role, exit code and elevation route.",
    category: "destructive",
    audit: false,
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: 'machines.list target: "ssh:<host-id>" or "pve:<endpoint>/<node>". A label or address also works.',
        },
        command: { type: "string", description: "Command text, run through bash on the host." },
        role: {
          type: "string",
          enum: ["system", "superadmin", "admin", "moderator", "user"],
          description: "Policy to enforce. Defaults to system (the agent's operator-equivalent access).",
        },
        elevate: {
          type: "string",
          enum: ["none", "auto", "sudo"],
          description:
            "none (default) runs as the login account; auto uses root, a NOPASSWD grant or the stored password; sudo requires a route and fails otherwise.",
        },
        cwd: { type: "string", description: "Working directory for the command." },
        env: { type: "object", description: "Environment variables to export before running." },
        stdin: { type: "string", description: "Text piped to the command's stdin." },
        sudoPassword: {
          type: "string",
          description: "One-time sudo password for a host with no passwordless route. Never stored or logged.",
        },
        timeoutMs: { type: "number", description: "Timeout, capped by the role policy (default 60000)." },
        confirm: { type: "boolean" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const target = resolveShellTarget(ctx.store, typeof args.target === "string" ? args.target : undefined);
      const command = requireString(args, "command");
      const role = parseRole(args);
      const elevate = parseElevation(args, role);
      await confirmDestructive(ctx, args, {
        title: `${elevate === "none" ? "Run" : "Run as root"} on ${target.label}: ${command.slice(0, 60)}`,
        tool: "machines.shell",
        args: { target: target.target, command, role, elevate },
      });
      const timeoutMs = optionalNumber(args, "timeoutMs");
      const env = parseEnv(args);
      return runShell(ctx.store, target, {
        command,
        role,
        elevate,
        ...(typeof args.cwd === "string" && args.cwd.trim() ? { cwd: args.cwd.trim() } : {}),
        ...(env ? { env } : {}),
        ...(typeof args.stdin === "string" ? { stdin: args.stdin } : {}),
        ...(typeof args.sudoPassword === "string" && args.sudoPassword ? { password: args.sudoPassword } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
    },
  });

  registry.register({
    name: "machines.shell.policy",
    title: "Shell role matrix and audit behavior",
    description:
      "Read the per-role shell permissions (unrestricted shell, elevation, output and timeout limits), the read-only command allowlist for the member role, and where shell calls are audited. Read-only.",
    category: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      return {
        roles: shellPolicyMatrix(),
        readOnlyAllowlist: readOnlyCommandList(),
        elevation: {
          routes: ["root", "nopasswd", "password"],
          detail:
            "auto uses the account's own uid, then a live NOPASSWD grant, then the stored SSH password through sudo -S on stdin. " +
            "A key-auth host with only a helper-scoped grant must supply sudoPassword once or run with elevate:none.",
        },
        audit: {
          file: "audit.jsonl (next to config.json)",
          fields: ["at", "tool", "host", "role", "command", "elevate", "route", "code", "durationMs", "ok", "error"],
          note: "Validation failures and transport failures are recorded too. Passwords and stdin content are never recorded.",
        },
      };
    },
  });
}
