import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { requireString, type ToolContext, type ToolRegistry } from "./registry";

const ALLOWED_SCRIPTS = ["build", "build:renderer", "build:main", "typecheck", "smoke", "package:dir", "mcp"];
const IGNORED = new Set(["node_modules", "dist", "dist-electron", "release", ".git", ".nexus-backup"]);

function safePath(appRoot: string, relative: string): string {
  const resolved = path.resolve(appRoot, relative);
  const root = path.resolve(appRoot);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path escapes the app directory: ${relative}`);
  }
  return resolved;
}

function run(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<{ exitCode: number | null; output: string; durationMs: number; timedOut: boolean }>((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, shell: false, env: { ...process.env, NO_COLOR: "1", CI: "1" } });
    const chunks: string[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (data: Buffer) => chunks.push(data.toString()));
    child.stderr.on("data", (data: Buffer) => chunks.push(data.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code,
        output: chunks.join("").split(/\r?\n/).filter(Boolean).slice(-160).join("\n"),
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}

async function npmRun(ctx: ToolContext, script: string) {
  if (!ALLOWED_SCRIPTS.includes(script)) {
    throw new Error(`Script not allowed. Choose one of: ${ALLOWED_SCRIPTS.join(", ")}`);
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(npm, ["run", script, "--silent"], ctx.appRoot, 600_000, ctx.signal);
}

async function walk(root: string, current: string, depth: number, maxDepth: number, out: string[]) {
  if (depth > maxDepth || out.length > 400) return;
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    out.push(entry.isDirectory() ? `${rel}/` : rel);
    if (entry.isDirectory()) await walk(root, full, depth + 1, maxDepth, out);
  }
}

export function registerDevTools(registry: ToolRegistry): void {
  registry.register({
    name: "dev.tree",
    title: "List app files",
    description: "Recursive file listing of the Nexus PVE app (node_modules, dist and .git excluded).",
    category: "dev",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Subdirectory to list, default ." },
        depth: { type: "number", description: "Max depth, default 3" },
      },
    },
    async run(args, ctx) {
      const target = safePath(ctx.appRoot, typeof args.path === "string" ? args.path : ".");
      const depth = Math.min(8, Number(args.depth ?? 3));
      const out: string[] = [];
      await walk(ctx.appRoot, target, 0, depth, out);
      return { root: ctx.appRoot, files: out };
    },
  });

  registry.register({
    name: "dev.read_file",
    title: "Read an app file",
    description: "Read a UTF-8 source file from the Nexus PVE app. Capped at 120 KB.",
    category: "dev",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async run(args, ctx) {
      const file = safePath(ctx.appRoot, requireString(args, "path"));
      const stat = await fs.stat(file);
      if (stat.size > 120_000) throw new Error(`File is ${stat.size} bytes; read a smaller file or use dev.tree.`);
      return { path: file, content: await fs.readFile(file, "utf8") };
    },
  });

  registry.register({
    name: "dev.write_file",
    title: "Write an app file",
    description:
      "Write a UTF-8 source file in the app. The previous contents are copied to .nexus-backup/ first, so edits are reversible.",
    category: "dev",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" }, create: { type: "boolean" } },
      required: ["path", "content"],
    },
    async run(args, ctx) {
      const file = safePath(ctx.appRoot, requireString(args, "path"));
      const content = typeof args.content === "string" ? args.content : "";
      let backup: string | null = null;
      try {
        const previous = await fs.readFile(file, "utf8");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        backup = path.join(ctx.appRoot, ".nexus-backup", stamp, path.relative(ctx.appRoot, file));
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.writeFile(backup, previous, "utf8");
      } catch {
        if (!args.create) throw new Error(`File does not exist: ${file} (pass create:true to make a new file)`);
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, "utf8");
      return { path: file, bytes: Buffer.byteLength(content), backup };
    },
  });

  registry.register({
    name: "dev.build",
    title: "Build the app",
    description: "Run the production build (renderer + Electron bundles) and return the tail of the output with the exit code.",
    category: "dev",
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      return npmRun(ctx, "build");
    },
  });

  registry.register({
    name: "dev.typecheck",
    title: "Typecheck the app",
    description: "Run tsc for both the renderer and Electron main projects.",
    category: "dev",
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      return npmRun(ctx, "typecheck");
    },
  });

  registry.register({
    name: "dev.smoke",
    title: "Run the end-to-end smoke test",
    description: "Run the MCP + Proxmox client smoke suite against the bundled mock server.",
    category: "dev",
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      return npmRun(ctx, "smoke");
    },
  });

  registry.register({
    name: "dev.package",
    title: "Package the Windows app",
    description: "Run electron-builder in directory mode (release/win-unpacked) without publishing anything.",
    category: "dev",
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      return npmRun(ctx, "package:dir");
    },
  });

  registry.register({
    name: "dev.run_script",
    title: "Run a whitelisted npm script",
    description: `Run one of the app's own scripts: ${ALLOWED_SCRIPTS.join(", ")}.`,
    category: "dev",
    inputSchema: {
      type: "object",
      properties: { script: { type: "string", enum: ALLOWED_SCRIPTS } },
      required: ["script"],
    },
    async run(args, ctx) {
      return npmRun(ctx, requireString(args, "script"));
    },
  });
}
