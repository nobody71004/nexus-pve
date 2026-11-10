import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipelinesDir, runsPath } from "../paths";
import type { ConfigStore } from "../config";
import type {
  NexusEvent,
  PipelineDef,
  PipelineLogEntry,
  PipelineRun,
  PipelineStepDef,
  PipelineStepState,
} from "../../shared/types";
import { resolveHostId, sleep, type ToolContext, type ToolRegistry } from "./registry";

export interface PipelineDeps {
  store: ConfigStore;
  registry: ToolRegistry;
  appRoot: string;
  emit: (event: NexusEvent) => void;
}

const BUILT_INS: PipelineDef[] = [
  {
    id: "health-sweep",
    name: "Fleet health sweep",
    description:
      "Pull the live fleet overview, drill into every node's hardware, then surface recent failed tasks. Read-only.",
    category: "health",
    builtIn: true,
    steps: [
      { id: "overview", title: "Fleet overview", tool: "fleet.overview", args: { host: "{{args.host}}" } },
      {
        id: "nodes",
        title: "Node hardware detail",
        tool: "node.detail",
        args: { host: "{{args.host}}", node: "{{item.node}}" },
        forEach: "steps.overview.output.nodes",
      },
      {
        id: "failures",
        title: "Recent failed tasks",
        tool: "tasks.list",
        args: { host: "{{args.host}}", state: "error", limit: 15 },
      },
    ],
  },
  {
    id: "backup-fleet",
    name: "Protect the fleet",
    description:
      "Snapshot every running guest to the selected storage, then list the archives that now exist. Bulk action; ask before running.",
    category: "backup",
    builtIn: true,
    steps: [
      { id: "guests", title: "Enumerate running guests", tool: "vms.list", args: { host: "{{args.host}}", status: "running" } },
      {
        id: "backup",
        title: "Back up each guest",
        tool: "backup.run",
        approval: "always",
        forEach: "steps.guests.output.vms",
        args: {
          host: "{{args.host}}",
          node: "{{item.node}}",
          vmid: "{{item.vmid}}",
          storage: "{{args.storage}}",
          mode: "snapshot",
          compress: "zstd",
          notes: "Nexus PVE protected-fleet pipeline",
        },
      },
      { id: "archives", title: "Verify archives exist", tool: "backup.list", args: { host: "{{args.host}}" } },
    ],
  },
  {
    id: "rolling-reboot",
    name: "Rolling reboot",
    description:
      "Gracefully shut down each guest one at a time, pause, boot it again, and pause before the next. Every guest is approved individually.",
    category: "maintenance",
    builtIn: true,
    steps: [
      { id: "guests", title: "Enumerate guests", tool: "vms.list", args: { host: "{{args.host}}", status: "running" } },
      {
        id: "shutdown",
        title: "Graceful shutdown",
        tool: "vm.action",
        approval: "always",
        forEach: "steps.guests.output.vms",
        args: { host: "{{args.host}}", vmid: "{{item.vmid}}", action: "shutdown" },
      },
      { id: "settle", title: "Wait for shutdown", tool: "util.sleep", args: { seconds: 20 } },
      {
        id: "start",
        title: "Start again",
        tool: "vm.action",
        forEach: "steps.guests.output.vms",
        args: { host: "{{args.host}}", vmid: "{{item.vmid}}", action: "start" },
      },
    ],
  },
  {
    id: "incident-capture",
    name: "Incident capture",
    description:
      "Write a full evidence bundle (hardware, inventory, configs) and pull logs for every failed task. Read-only against Proxmox.",
    category: "incident",
    builtIn: true,
    steps: [
      {
        id: "bundle",
        title: "Capture evidence bundle",
        tool: "incident.bundle",
        args: { host: "{{args.host}}", note: "{{args.note}}", includeVmConfigs: true },
      },
      { id: "failed", title: "Find failed tasks", tool: "tasks.list", args: { host: "{{args.host}}", state: "error", limit: 10 } },
      {
        id: "logs",
        title: "Read failure logs",
        tool: "task.log",
        forEach: "steps.failed.output.tasks",
        args: { host: "{{args.host}}", node: "{{item.node}}", upid: "{{item.upid}}", tail: 40 },
      },
    ],
  },
  {
    id: "dev-release",
    name: "Agent dev release gate",
    description: "Typecheck the app, build it, then run the end-to-end mock/MCP smoke suite. This is the pipeline the agent uses on itself.",
    category: "dev",
    builtIn: true,
    steps: [
      { id: "typecheck", title: "Typecheck", tool: "dev.typecheck" },
      { id: "build", title: "Production build", tool: "dev.build" },
      { id: "smoke", title: "E2E smoke suite", tool: "dev.smoke" },
    ],
  },
  {
    id: "console-sweep",
    name: "Console readiness sweep",
    description:
      "Enumerate every Linux host and Proxmox node, then probe each VNC console through its mapped SSH transport. Read-only; nodes without an SSH mapping are reported explicitly.",
    category: "health",
    builtIn: true,
    steps: [
      {
        id: "machines",
        title: "Enumerate Linux and Proxmox machines",
        tool: "machines.list",
        args: { includeLinkedLinux: false },
      },
      {
        id: "preflight",
        title: "Probe VNC console",
        tool: "machines.vnc.preflight",
        forEach: "steps.machines.output.machines",
        args: { target: "{{item.target}}" },
      },
    ],
  },
  {
    id: "fleet-command",
    name: "Run a command across the fleet",
    description:
      "Run one command over SSH on every mapped Linux host and Proxmox node. The operator approves the command step once before anything executes.",
    category: "maintenance",
    builtIn: true,
    steps: [
      {
        id: "machines",
        title: "Enumerate mapped machines",
        tool: "machines.list",
        args: { mappedOnly: true, includeLinkedLinux: false },
      },
      {
        id: "command",
        title: "Run command on each machine",
        tool: "machines.exec",
        approval: "always",
        forEach: "steps.machines.output.machines",
        args: { target: "{{item.target}}", command: "{{args.command}}", shell: "{{args.shell}}" },
      },
    ],
  },
];

export class PipelineService {
  private readonly defs = new Map<string, PipelineDef>();
  private readonly runs = new Map<string, PipelineRun>();
  private readonly listeners = new Set<(run: PipelineRun) => void>();
  private readonly approvals = new Map<string, (ok: boolean) => void>();
  private readonly aborts = new Map<string, AbortController>();
  /** step ids whose human gate has already been answered, per run */
  private readonly approvedSteps = new Map<string, Set<string>>();

  constructor(private readonly deps: PipelineDeps) {
    for (const def of BUILT_INS) this.defs.set(def.id, def);
    this.loadUserDefs();
    this.loadRuns();
    this.registerTools();
  }

  private loadUserDefs(): void {
    try {
      fs.mkdirSync(pipelinesDir(), { recursive: true });
      for (const file of fs.readdirSync(pipelinesDir())) {
        if (!file.endsWith(".json")) continue;
        try {
          const def = JSON.parse(fs.readFileSync(path.join(pipelinesDir(), file), "utf8")) as PipelineDef;
          if (!def.id || !Array.isArray(def.steps)) continue;
          this.defs.set(def.id, {
            ...def,
            builtIn: false,
            category: def.category ?? "maintenance",
          });
        } catch {
          /* ignore an invalid pipeline file, keep the rest */
        }
      }
    } catch {
      /* directory is created lazily */
    }
  }

  private loadRuns(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(runsPath(), "utf8")) as PipelineRun[];
      for (const run of raw.slice(0, 40)) {
        if (run.status === "running" || run.status === "waiting-approval") {
          run.status = "error";
          run.error = "Interrupted by an application restart";
          run.approval = undefined;
          run.steps = run.steps.map((step) =>
            step.status === "running" || step.status === "waiting-approval" ? { ...step, status: "error" } : step,
          );
        }
        this.runs.set(run.id, run);
      }
    } catch {
      /* first run */
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(runsPath()), { recursive: true });
      const list = [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 40);
      fs.writeFileSync(runsPath(), JSON.stringify(list, null, 2), { mode: 0o600 });
    } catch {
      /* history is best-effort; never break a run for it */
    }
  }

  definitions(): PipelineDef[] {
    return [...this.defs.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  history(): PipelineRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 25);
  }

  get(runId: string): PipelineRun | undefined {
    return this.runs.get(runId);
  }

  subscribe(listener: (run: PipelineRun) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(run: PipelineRun): void {
    this.persist();
    for (const listener of this.listeners) {
      try {
        listener(run);
      } catch {
        /* a broken listener must not break the run */
      }
    }
    this.deps.emit({ type: "pipeline", run, hostId: run.hostId });
  }

  private log(run: PipelineRun, level: PipelineLogEntry["level"], message: string, stepId?: string): void {
    run.log.push({ at: Date.now(), level, message, stepId });
    if (run.log.length > 400) run.log.shift();
  }

  start(pipelineId: string, hostId: string, vars: Record<string, unknown> = {}): PipelineRun {
    const def = this.defs.get(pipelineId);
    if (!def) throw new Error(`Unknown pipeline: ${pipelineId}`);
    const fleet = hostId === "fleet";
    const host = fleet ? undefined : this.deps.store.host(hostId);
    if (!fleet && !host) throw new Error("Choose a configured host first");
    const hostLabel = fleet ? "all machines" : host!.label;

    const run: PipelineRun = {
      id: crypto.randomUUID(),
      pipelineId,
      name: def.name,
      hostId: fleet ? "fleet" : hostId,
      status: "running",
      startedAt: Date.now(),
      steps: def.steps.map<PipelineStepState>((step) => ({
        id: step.id,
        title: step.title,
        tool: step.tool,
        status: "pending",
        attempts: 0,
      })),
      context: {
        args: { ...vars, host: fleet ? "fleet" : host!.label },
        hostId: fleet ? "fleet" : hostId,
        hostLabel,
      },
      log: [],
    };
    this.runs.set(run.id, run);
    this.approvedSteps.set(run.id, new Set());
    this.log(run, "info", `Run started on ${hostLabel}`, undefined);
    this.publish(run);

    const controller = new AbortController();
    this.aborts.set(run.id, controller);
    void this.execute(run, def, controller.signal).catch((err) => {
      run.status = run.status === "cancelled" ? "cancelled" : "error";
      run.error = err instanceof Error ? err.message : String(err);
      run.endedAt = Date.now();
      this.log(run, "error", `Run failed: ${run.error}`);
      this.publish(run);
    });

    return structuredClone(run);
  }

  approve(runId: string, approved: boolean): PipelineRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error("Unknown run");
    const resolver = this.approvals.get(runId);
    if (!resolver) throw new Error("This run is not waiting for approval");
    this.approvals.delete(runId);
    run.approval = undefined;
    run.status = "running";
    this.log(run, approved ? "ok" : "warn", approved ? "Operator approved the step" : "Operator declined the step");
    this.publish(run);
    resolver(approved);
    return structuredClone(run);
  }

  cancel(runId: string): PipelineRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error("Unknown run");
    this.aborts.get(runId)?.abort();
    this.approvals.get(runId)?.(false);
    this.approvals.delete(runId);
    run.status = "cancelled";
    run.endedAt = Date.now();
    run.approval = undefined;
    for (const step of run.steps) {
      if (step.status === "pending" || step.status === "running" || step.status === "waiting-approval") step.status = "skipped";
    }
    this.log(run, "warn", "Run cancelled by the operator");
    this.publish(run);
    return structuredClone(run);
  }

  private async waitForApproval(run: PipelineRun, step: PipelineStepState, def: PipelineStepDef, args: Record<string, unknown>) {
    step.status = "waiting-approval";
    run.status = "waiting-approval";
    run.approval = {
      stepId: step.id,
      title: def.title,
      tool: def.tool,
      args,
      requestedAt: Date.now(),
    };
    this.log(run, "warn", `Approval required: ${def.title}`, step.id);
    this.publish(run);
    const decision = await new Promise<boolean>((resolve) => {
      this.approvals.set(run.id, resolve);
    });
    if (!decision) throw new Error("Step declined by the operator");
    // A step gated by the pipeline is already approved: a destructive tool inside
    // it must not open a second, identical confirmation dialog.
    this.approvedSteps.get(run.id)?.add(step.id);
    step.status = "running";
    run.status = "running";
  }

  private async execute(run: PipelineRun, def: PipelineDef, signal: AbortSignal): Promise<void> {
    const ctx: ToolContext = {
      store: this.deps.store,
      hostId: run.hostId,
      appRoot: this.deps.appRoot,
      signal,
      emit: this.deps.emit,
      approve: async (request) => {
        const step = run.steps.find((entry) => entry.tool === request.tool && entry.status === "running");
        if (!step) return false;
        if (this.approvedSteps.get(run.id)?.has(step.id)) return true;
        const defStep = def.steps.find((entry) => entry.id === step.id);
        if (!defStep) return false;
        await this.waitForApproval(run, step, defStep, request.args);
        return true;
      },
    };

    for (let index = 0; index < def.steps.length; index += 1) {
      if (run.status === "cancelled") return;
      const defStep = def.steps[index];
      const state = run.steps[index];
      if (signal.aborted) throw new Error("cancelled");

      if (defStep.when) {
        const expression = defStep.when.includes("{{") ? defStep.when : `{{${defStep.when}}}`;
        const truthy = Boolean(this.resolve(expression, run, undefined));
        if (!truthy) {
          state.status = "skipped";
          this.log(run, "info", `Skipped ${defStep.title} (condition false)`, defStep.id);
          this.publish(run);
          continue;
        }
      }

      state.status = "running";
      state.startedAt = Date.now();
      this.log(run, "info", `Running ${defStep.title}`, defStep.id);
      this.publish(run);

      const tool = this.deps.registry.get(defStep.tool);
      if (!tool) throw new Error(`Pipeline references unknown tool ${defStep.tool}`);

      const needsApproval =
        defStep.approval === "always" ||
        (defStep.approval === "destructive" && (tool.category === "destructive" || tool.category === "mutate"));
      if (needsApproval) {
        await this.waitForApproval(run, state, defStep, this.rawArgs(defStep, run, undefined));
      }

      const attempts = Math.max(1, (defStep.retries ?? 0) + 1);
      try {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          state.attempts = attempt;
          try {
            const output = await this.runStep(defStep, run, ctx, tool.run.bind(tool));
            state.output = output;
            state.status = "ok";
            state.endedAt = Date.now();
            this.log(run, "ok", `${defStep.title} finished`, defStep.id);
            break;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (attempt < attempts && !signal.aborted) {
              this.log(run, "warn", `${defStep.title} failed (${message}); retrying ${attempt}/${attempts - 1}`, defStep.id);
              await sleep(800 * attempt, signal);
              continue;
            }
            throw err;
          }
        }
      } catch (err) {
        state.endedAt = Date.now();
        // Read through a wide type: the status can change while this step awaits approval.
        const currentStatus: string = run.status;
        if (currentStatus === "cancelled") {
          // The operator cancelled while this step was awaiting approval; keep the
          // run cancelled instead of relabelling the decline as a failure.
          state.status = "skipped";
          return;
        }
        state.status = "error";
        state.error = err instanceof Error ? err.message : String(err);
        this.log(run, "error", `${defStep.title}: ${state.error}`, defStep.id);
        if (!defStep.continueOnError) {
          run.status = "error";
          run.error = state.error;
          run.endedAt = Date.now();
          this.publish(run);
          return;
        }
      }
      run.context[defStep.id] = { output: state.output };
      this.publish(run);
    }

    if (run.status !== "cancelled") {
      run.status = "ok";
      run.endedAt = Date.now();
      this.log(run, "ok", "Run completed");
      this.publish(run);
    }
  }

  private async runStep(
    defStep: PipelineStepDef,
    run: PipelineRun,
    ctx: ToolContext,
    call: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>,
  ): Promise<unknown> {
    if (!defStep.forEach) {
      const args = this.rawArgs(defStep, run, undefined);
      return call(args, ctx);
    }
    // forEach is authored as a bare path (steps.overview.output.nodes); resolve it
    // as an expression unless the pipeline already wrote the braces.
    const path = defStep.forEach.trim();
    const expression = path.includes("{{") ? path : `{{${path}}}`;
    const list = this.resolve(expression, run, undefined);
    if (!Array.isArray(list)) throw new Error(`forEach path ${defStep.forEach} did not resolve to a list`);
    const output: unknown[] = [];
    for (let index = 0; index < list.length; index += 1) {
      if (ctx.signal?.aborted) throw new Error("cancelled");
      const item = list[index];
      const args = this.rawArgs(defStep, run, { item, index });
      const label = typeof item === "object" && item !== null ? describeItem(item as Record<string, unknown>) : String(item);
      this.log(run, "info", `${defStep.title} → ${label}`, defStep.id);
      output.push(await call(args, ctx));
    }
    return output;
  }

  private rawArgs(defStep: PipelineStepDef, run: PipelineRun, extra: { item?: unknown; index?: number } | undefined) {
    const resolved = this.resolve(defStep.args ?? {}, run, extra);
    if (resolved === null || typeof resolved !== "object" || Array.isArray(resolved)) return {};
    return resolved as Record<string, unknown>;
  }

  private resolve(value: unknown, run: PipelineRun, extra: { item?: unknown; index?: number } | undefined): unknown {
    if (typeof value === "string") {
      const full = /^\{\{([^}]+)\}\}$/.exec(value.trim());
      if (full) return lookup(full[1], run, extra);
      return value.replace(/\{\{([^}]+)\}\}/g, (_match, expr: string) => {
        const found = lookup(expr.trim(), run, extra);
        return found === undefined || found === null ? "" : String(found);
      });
    }
    if (Array.isArray(value)) return value.map((entry) => this.resolve(entry, run, extra));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = this.resolve(entry, run, extra);
      }
      return out;
    }
    return value;
  }

  private registerTools(): void {
    const registry = this.deps.registry;

    registry.register({
      name: "util.sleep",
      title: "Wait",
      description: "Pause the pipeline for a number of seconds (max 300). Used for pacing between disruptive steps.",
      category: "dev",
      inputSchema: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] },
      async run(args, ctx) {
        const seconds = Math.min(300, Math.max(1, Number(args.seconds ?? 1)));
        await sleep(seconds * 1000, ctx.signal);
        return { waitedSeconds: seconds };
      },
    });

    registry.register({
      name: "util.assert",
      title: "Assert a value",
      description: "Fail the step when a pipeline expression is false; useful as a guard between destructive actions.",
      category: "dev",
      inputSchema: {
        type: "object",
        properties: { value: { type: "boolean" }, message: { type: "string" } },
        required: ["value"],
      },
      async run(args) {
        if (args.value !== true) throw new Error(typeof args.message === "string" ? args.message : "Assertion failed");
        return { ok: true };
      },
    });

    registry.register({
      name: "pipeline.list",
      title: "List pipelines",
      description: "Every built-in and user pipeline with its steps, plus recent runs.",
      category: "read",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        return {
          pipelines: this.definitions().map((def) => ({
            id: def.id,
            name: def.name,
            category: def.category,
            description: def.description,
            steps: def.steps.map((step) => ({ id: step.id, title: step.title, tool: step.tool, approval: step.approval ?? "never" })),
          })),
          recentRuns: this.history().slice(0, 5).map((run) => ({
            id: run.id,
            pipelineId: run.pipelineId,
            status: run.status,
            startedAt: new Date(run.startedAt).toISOString(),
          })),
        };
      },
    });

    registry.register({
      name: "pipeline.run",
      title: "Start a pipeline",
      description:
        "Start a multi-step pipeline against a host. Returns immediately with the run id unless waitSeconds is given. Destructive steps pause for pipeline.approve.",
      category: "mutate",
      inputSchema: {
        type: "object",
        properties: {
          pipeline: { type: "string" },
          host: {
            type: "string",
            description: "Configured Proxmox host, or \"fleet\" for a fleet-wide pipeline that enumerates every Linux host and Proxmox node.",
          },
          vars: { type: "object", description: "Variables such as storage, note or command" },
          waitSeconds: { type: "number", description: "Block up to 60s for completion" },
        },
        required: ["pipeline"],
      },
      run: async (args, ctx) => {
        const pipelineId = String(args.pipeline ?? "");
        const fleet = args.host === "fleet";
        const hostId = fleet ? "fleet" : resolveHostId(args, ctx);
        const vars = (args.vars && typeof args.vars === "object" ? args.vars : {}) as Record<string, unknown>;
        const run = this.start(pipelineId, hostId, vars);
        const waitSeconds = Math.min(60, Math.max(0, Number(args.waitSeconds ?? 0)));
        if (waitSeconds > 0) {
          const deadline = Date.now() + waitSeconds * 1000;
          while (Date.now() < deadline) {
            await sleep(400);
            const current = this.runs.get(run.id);
            if (!current) break;
            if (["ok", "error", "cancelled", "waiting-approval"].includes(current.status)) return summarizeRun(current);
          }
        }
        const current = this.runs.get(run.id);
        return current ? summarizeRun(current) : run;
      },
    });

    registry.register({
      name: "pipeline.status",
      title: "Pipeline run status",
      description: "Current status, step states and log tail for a run.",
      category: "read",
      inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
      run: async (args) => {
        const run = this.runs.get(String(args.runId ?? ""));
        if (!run) throw new Error("Unknown run id");
        return { ...summarizeRun(run), log: run.log.slice(-30) };
      },
    });

    registry.register({
      name: "pipeline.approve",
      title: "Approve or decline a paused step",
      description: "Unblock a pipeline waiting for human approval, or decline to stop it.",
      category: "mutate",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "string" }, approve: { type: "boolean" } },
        required: ["runId", "approve"],
      },
      run: async (args) => {
        const updated = this.approve(String(args.runId ?? ""), args.approve === true);
        return summarizeRun(updated);
      },
    });

    registry.register({
      name: "pipeline.cancel",
      title: "Cancel a pipeline",
      description: "Abort a running or paused pipeline.",
      category: "mutate",
      inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
      run: async (args) => {
        return summarizeRun(this.cancel(String(args.runId ?? "")));
      },
    });
  }
}

function lookup(expr: string, run: PipelineRun, extra: { item?: unknown; index?: number } | undefined): unknown {
  const clean = expr.replace(/^\$\./, "");
  const parts = clean.split(".").filter(Boolean);
  let cursor: unknown;
  if (parts[0] === "steps") {
    // Step outputs live directly on the run context: steps.<id>.output...
    cursor = run.context;
    parts.shift();
  } else if (parts[0] === "args") {
    cursor = run.context.args;
    parts.shift();
  } else if (parts[0] === "item") {
    cursor = extra?.item;
    parts.shift();
  } else if (parts[0] === "index") {
    return extra?.index;
  } else {
    cursor = run.context;
  }
  for (const part of parts) {
    if (cursor === undefined || cursor === null) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(part);
      cursor = Number.isFinite(index) ? cursor[index] : undefined;
    } else if (typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function describeItem(item: Record<string, unknown>): string {
  const name = item.name ?? item.title ?? item.id ?? item.vmid ?? "item";
  return String(name);
}

function summarizeRun(run: PipelineRun) {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : null,
    error: run.error ?? null,
    approval: run.approval ?? null,
    steps: run.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      attempts: step.attempts,
      error: step.error ?? null,
      output: step.output ?? null,
    })),
  };
}
