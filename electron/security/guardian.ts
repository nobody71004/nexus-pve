import type {
  HelperInstallResult,
  NexusEvent,
  SecurityAction,
  SecurityOverview,
  SecurityPolicy,
  SecurityResidentState,
  SecurityScan,
} from "../../shared/types";
import { configStore, type ConfigStore } from "../config";
import { runPrivileged } from "../ssh/actions";
import {
  checkHelper,
  helperAppRoot,
  installHelper,
  setHelperInstallRecorder,
  type HelperInstallAudit,
} from "../ssh/helper";
import { collectFacts } from "./audit";
import { evaluate, gradeFor, layersOf, scoreFor } from "./evaluate";
import { BaselineStore, PolicyStore, SecurityJournal } from "./state";

/**
 * Layer 4 — the guardian.
 *
 * - 24/7 scheduler: one host at a time, no overlapping scans, jittered interval,
 *   unref'd timers so a headless MCP process can still exit.
 * - Defence in depth: observe → defend → lockdown, each step opt-in.
 * - Self-protection: the guard never bans its own SSH peer or an allowlisted
 *   address, never applies a guarded fix without lockdown or an explicit click,
 *   rate-limits repeated fixes, and refuses a policy it did not sign.
 * - Every decision is written to the hash-chained journal.
 */

export const VERSION = "1.0.0";

export interface Remediation {
  label: string;
  guarded?: boolean;
  /** Baseline fingerprints this fix legitimately changes. */
  touches?: string[];
}

export const REMEDIATIONS: Record<string, Remediation> = {
  "ssh-permit-root": {
    label: "Restrict root SSH login to keys",
    touches: ["fim:/etc/ssh/sshd_config", "fim:/etc/ssh/sshd_config.d"],
  },
  "ssh-key-only": {
    label: "Disable SSH password authentication",
    guarded: true,
    touches: ["fim:/etc/ssh/sshd_config", "fim:/etc/ssh/sshd_config.d"],
  },
  "key-permissions": { label: "Tighten key and account file permissions" },
  "sudo-narrow": {
    label: "Require a password for broad sudo rules",
    // The helper edits /etc/sudoers and its drop-ins, then validates with visudo.
    touches: ["fim:/etc/sudoers", "fim:/etc/sudoers.d"],
  },
  "sysctl-hardening": { label: "Apply kernel and network hardening" },
  "unattended-upgrades": { label: "Enable unattended security updates" },
  "fail2ban-baseline": { label: "Deploy the fail2ban sshd jail" },
  "firewall-baseline": { label: "Baseline host firewall, keeping SSH reachable", guarded: true },
  "resident-install": {
    label: "Install the resident enforcer",
    // The install applies its baseline once, so it can legitimately touch sshd
    // and the systemd unit set as well as the timer files.
    touches: ["fim:/etc/ssh/sshd_config", "fim:/etc/ssh/sshd_config.d", "fim:/etc/systemd/system", "meta:units"],
  },
  // Not applied through the helper: the helper is what this fix replaces.
  "helper-refresh": { label: "Reinstall the privileged helper" },
};

const SCAN_MIN_GAP_MS = 10_000;
const ACTION_COOLDOWN_MS = 30 * 60_000;
const MAX_AUTO_ACTIONS = 4;

interface HostState {
  scan?: SecurityScan;
  current?: Record<string, string>;
  nextRunAt?: number;
  running: boolean;
  lastError?: string;
}

let emitSink: (event: NexusEvent) => void = () => {};

export function bindGuardianEmit(emit: (event: NexusEvent) => void): void {
  emitSink = emit;
}

const EMPTY_RESIDENT: SecurityResidentState = { installed: false, active: false, enforce: [], output: "" };

export class GuardianService {
  readonly policyStore = new PolicyStore();
  readonly journal = new SecurityJournal();
  readonly baselines = new BaselineStore();
  private readonly states = new Map<string, HostState>();
  private readonly inflight = new Set<string>();
  private readonly lastAction = new Map<string, number>();
  private readonly lastScan = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private bootTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: ConfigStore = configStore,
    private readonly emit: (event: NexusEvent) => void = (event) => emitSink(event),
  ) {
    // installHelper is shared by the host cards, MCP and the scheduler; one
    // recorder keeps every attempt in this tamper-evident journal.
    setHelperInstallRecorder((event) => this.recordHelperInstall(event));
  }

  /* --------------------------------------------------------------- lifecycle */

  start(): void {
    if (this.timer) return;
    this.journal.append({
      at: Date.now(),
      hostId: "*",
      label: "guardian",
      kind: "boot",
      message: `security guardian online v${VERSION}`,
    });
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref?.();
    this.bootTimer = setTimeout(() => void this.tick(), 4_000);
    this.bootTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.timer = null;
    this.bootTimer = null;
  }

  private async tick(): Promise<void> {
    const policy = this.policyStore.read();
    if (!policy.enabled) return;
    const now = Date.now();
    for (const host of this.store.sshHosts()) {
      const state = this.states.get(host.id) ?? { running: false };
      this.states.set(host.id, state);
      if (this.inflight.has(host.id)) continue;
      if (state.nextRunAt !== undefined && now < state.nextRunAt) continue;
      state.nextRunAt = now + policy.intervalSec * 1000 + Math.floor(Math.random() * 15_000);
      void this.scan(host.id, { auto: true }).catch((error) => {
        state.lastError = error instanceof Error ? error.message : String(error);
      });
    }
  }

  /* -------------------------------------------------------------- public api */

  policy(): SecurityPolicy {
    return this.policyStore.read();
  }

  setPolicy(input: Record<string, unknown>): SecurityPolicy {
    const before = this.policyStore.read();
    const patch: Partial<SecurityPolicy> = {};
    if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
    if (typeof input.autoRemediate === "boolean") patch.autoRemediate = input.autoRemediate;
    if (typeof input.resident === "boolean") patch.resident = input.resident;
    if (input.mode === "observe" || input.mode === "defend" || input.mode === "lockdown") patch.mode = input.mode;
    if (typeof input.intervalSec === "number") patch.intervalSec = input.intervalSec;
    if (typeof input.maxBansPerRun === "number") patch.maxBansPerRun = input.maxBansPerRun;
    if (typeof input.banThreshold === "number") patch.banThreshold = input.banThreshold;
    if (Array.isArray(input.allowlist)) {
      patch.allowlist = input.allowlist.filter((entry): entry is string => typeof entry === "string");
    }
    const next = this.policyStore.write(patch);
    const changes = Object.entries(patch)
      .filter(([key, value]) => JSON.stringify((before as unknown as Record<string, unknown>)[key]) !== JSON.stringify(value))
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
    this.journal.append({
      at: Date.now(),
      hostId: "*",
      label: "guardian",
      kind: "policy",
      message: changes.length > 0 ? `policy updated: ${changes.join(", ")}` : "policy re-signed with no changes",
    });
    this.emit({ type: "security", policy: next });
    return next;
  }

  overview(): SecurityOverview {
    const policy = this.policyStore.read();
    const hosts = this.store.sshHosts().map((host) => {
      const state = this.states.get(host.id);
      return {
        hostId: host.id,
        label: host.label,
        scan: state?.scan,
        nextRunAt: state?.nextRunAt,
        running: state?.running ?? false,
        lastError: state?.lastError,
      };
    });
    const chain = this.journal.verify();
    return {
      running: this.timer !== null,
      policy,
      hosts,
      chain: { ok: chain.ok, length: chain.length, brokenAt: chain.brokenAt },
      journal: this.journal.list(80),
    };
  }

  /** Appends a helper install/refresh attempt with its route and trigger. */
  recordHelperInstall(event: HelperInstallAudit): void {
    const host = this.store.sshHost(event.hostId);
    const trigger = event.trigger === "auto" ? "automatic" : "manual";
    const detail = (event.error || event.output || "").replace(/\s+/g, " ").slice(0, 180);
    this.journal.append({
      at: Date.now(),
      hostId: event.hostId,
      label: host?.label || event.hostLabel || event.hostId,
      kind: "install",
      // Structured audit fields: the journal UI filters and shows these without
      // parsing the human-readable message.
      route: event.route,
      trigger,
      message:
        `helper install (${trigger}, route ${event.route}): ` +
        `${event.beforeState} → ${event.afterState}, ${event.ok ? "ok" : "failed"}` +
        (detail ? ` — ${detail}` : ""),
    });
  }

  async scan(hostId: string, options: { auto?: boolean; fixed?: string[] } = {}): Promise<SecurityScan> {
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    if (this.inflight.has(hostId)) throw new Error("A security scan is already running for this host");
    const last = this.lastScan.get(hostId) ?? 0;
    if (options.auto !== true && Date.now() - last < SCAN_MIN_GAP_MS) {
      const existing = this.states.get(hostId)?.scan;
      if (existing) return existing;
    }

    this.inflight.add(hostId);
    this.lastScan.set(hostId, Date.now());
    const state = this.states.get(hostId) ?? { running: false };
    this.states.set(hostId, state);
    state.running = true;
    const started = Date.now();

    try {
      const policy = this.policyStore.read();
      const tampered = this.policyStore.tampered;
      const actions: SecurityAction[] = [];
      const bans: string[] = [];

      // Keep the helper in step with the app. It is our own tool, so an
      // outdated copy is repaired before any privileged fix runs. Defend and
      // lockdown maintain it; observe changes nothing and reports it as a
      // fixable finding instead. The separate autoRemediate switch governs
      // security posture fixes, not upkeep of the tool we shipped.
      let helper = await checkHelper(this.store, helperAppRoot(), hostId).catch(() => undefined);
      // A NOPASSWD grant runs the helper but cannot write a new binary over it.
      // Repair needs root or the stored sudo password; attempting it on a
      // grant-only key-auth host would journal the same failure on every scan.
      const canReplaceHelper =
        helper?.route === "root" ||
        helper?.route === "password" ||
        (helper?.route === "nopasswd" && host.authMode === "password");
      if (helper?.state === "outdated" && canReplaceHelper && policy.enabled && policy.mode !== "observe") {
        const refreshed = await installHelper(this.store, helperAppRoot(), hostId, undefined, { trigger: "auto" }).catch(
          (error): HelperInstallResult => {
            const message = error instanceof Error ? error.message : String(error);
            // A throw before installHelper can record (e.g. the host dropped)
            // still belongs in the audit trail.
            this.recordHelperInstall({
              hostId,
              hostLabel: host.label,
              trigger: "auto",
              route: helper?.route ?? "none",
              beforeState: helper?.state ?? "missing",
              afterState: helper?.state ?? "missing",
              ok: false,
              output: "",
              error: message,
            });
            return { hostId, ok: false, route: helper?.route ?? "none", output: message };
          },
        );
        actions.push({
          id: "helper-refresh",
          label: REMEDIATIONS["helper-refresh"].label,
          ok: refreshed.ok,
          at: Date.now(),
          output: refreshed.output.slice(0, 2_000),
          auto: true,
        });
        // installHelper records this attempt in the same journal with its route.
        if (refreshed.status) helper = refreshed.status;
      }

      let facts = await collectFacts(this.store, hostId);
      const trusted = this.baselines.get(hostId);
      let evaluation = evaluate({ facts, baseline: trusted, policy, policyTampered: tampered, helper });

      // A manual fix just ran and this scan re-read the host. Record the files
      // that fix is expected to change before evaluating, so its own success
      // does not leave a bogus drift finding behind.
      let accepted = false;
      for (const id of options.fixed ?? []) {
        if (REMEDIATIONS[id]?.touches?.length) {
          this.acceptTouched(hostId, id, evaluation.baseline);
          accepted = true;
        }
      }
      if (accepted) {
        evaluation = evaluate({ facts, baseline: this.baselines.get(hostId), policy, policyTampered: tampered, helper });
      }

      if (policy.mode !== "observe" && policy.autoRemediate) {
        const wanted = new Map<string, string>();
        for (const check of evaluation.checks) {
          if (check.status !== "fail" && check.status !== "warn") continue;
          if (!check.remediation || !REMEDIATIONS[check.remediation]) continue;
          // Handled above, and retrying it here would duplicate the attempt.
          if (check.remediation === "helper-refresh") continue;
          if (REMEDIATIONS[check.remediation].guarded && policy.mode !== "lockdown") continue;
          wanted.set(check.remediation, check.id);
        }
        let budget = MAX_AUTO_ACTIONS;
        for (const id of wanted.keys()) {
          if (budget <= 0) break;
          const key = `${hostId}:${id}`;
          if (Date.now() - (this.lastAction.get(key) ?? 0) < ACTION_COOLDOWN_MS) continue;
          budget -= 1;
          const action = await this.applyFix(hostId, id, true);
          actions.push(action);
          if (action.ok) this.lastAction.set(key, Date.now());
        }
      }

      if (policy.mode === "lockdown" && policy.maxBansPerRun > 0 && evaluation.candidates.length > 0) {
        const alreadyBanned = new Set(await this.bans(hostId).catch(() => []));
        for (const candidate of evaluation.candidates) {
          if (bans.length >= policy.maxBansPerRun) break;
          if (alreadyBanned.has(candidate)) continue;
          const outcome = await this.banHost(hostId, candidate);
          if (outcome.ok) bans.push(candidate);
        }
      }

      if (actions.some((action) => action.ok) || bans.length > 0) {
        // Re-read the guest so the verdict reflects what was just changed.
        try {
          facts = await collectFacts(this.store, hostId);
          // Accept the files the successful fixes intentionally touched before
          // the final verdict. Using the post-fix fingerprints is important:
          // accepting the pre-fix ones made the drift reappear on every scan.
          const fresh = evaluate({
            facts,
            baseline: this.baselines.get(hostId),
            policy,
            policyTampered: tampered,
            helper,
          });
          for (const action of actions) {
            if (action.ok && REMEDIATIONS[action.id]?.touches?.length) {
              this.acceptTouched(hostId, action.id, fresh.baseline);
            }
          }
          evaluation = evaluate({
            facts,
            baseline: this.baselines.get(hostId),
            policy,
            policyTampered: tampered,
            helper,
          });
        } catch {
          // Keep the pre-fix verdict if the host dropped mid-fix; the journal
          // still records what was applied.
        }
      }

      if (facts.privileged && !trusted["fim:/etc/passwd"]) this.baselines.save(hostId, evaluation.baseline);
      state.current = evaluation.baseline;

      const score = scoreFor(evaluation.checks);
      const scan: SecurityScan = {
        hostId,
        label: host.label,
        at: Date.now(),
        durationMs: Date.now() - started,
        mode: policy.mode,
        score,
        grade: gradeFor(score),
        checks: evaluation.checks,
        layers: layersOf(evaluation.checks),
        drift: evaluation.drift,
        actions,
        bans,
        errors: facts.errors,
        privileged: facts.privileged,
      };

      const fails = scan.checks.filter((check) => check.status === "fail").length;
      const warns = scan.checks.filter((check) => check.status === "warn").length;
      this.journal.append({
        at: scan.at,
        hostId,
        label: host.label,
        kind: "scan",
        message: `${scan.grade} ${scan.score}/100 · ${fails} fail · ${warns} warn · ${actions.filter((a) => a.ok).length} fixed · ${bans.length} banned`,
      });

      state.scan = scan;
      state.lastError = undefined;
      state.running = false;
      this.emit({ type: "security", hostId, scan });
      return scan;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.running = false;
      state.lastError = message;
      this.journal.append({
        at: Date.now(),
        hostId,
        label: host.label,
        kind: "error",
        message: `scan failed: ${message.slice(0, 200)}`,
      });
      throw error;
    } finally {
      this.inflight.delete(hostId);
    }
  }

  async enforce(hostId: string, id: string, options: { confirm?: boolean } = {}): Promise<SecurityScan> {
    const meta = REMEDIATIONS[id];
    if (!meta) throw new Error(`Unknown remediation: ${id}`);
    if (meta.guarded && options.confirm !== true) {
      throw new Error(`"${meta.label}" can lock you out — confirm it explicitly`);
    }
    const action = await this.applyFix(hostId, id, false);
    if (!action.ok) throw new Error(action.output || `${id} failed`);
    const scanned = await this.scan(hostId, { auto: true, fixed: [id] });
    return { ...scanned, actions: [action, ...scanned.actions] };
  }

  acceptBaseline(hostId: string): SecurityOverview {
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    const state = this.states.get(hostId);
    if (!state?.scan || !state.current) throw new Error("Run a scan before accepting a baseline");
    this.baselines.save(hostId, state.current);
    this.journal.append({
      at: Date.now(),
      hostId,
      label: host.label,
      kind: "policy",
      message: `baseline accepted by operator — ${Object.keys(state.current).length} fingerprints recorded`,
    });
    return this.overview();
  }

  async resident(hostId: string, enable: boolean): Promise<SecurityResidentState> {
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    const policy = this.policyStore.read();
    if (enable) {
      const mode = policy.mode === "lockdown" ? "hard" : "safe";
      const result = await this.runGuard(hostId, ["install", mode], 300_000);
      if (!result.ok) throw new Error(result.output || "resident enforcer install failed");
      this.policyStore.write({ resident: true });
      this.journal.append({
        at: Date.now(),
        hostId,
        label: host.label,
        kind: "install",
        message: `resident enforcer installed (${mode})`,
      });
    } else {
      const result = await this.runGuard(hostId, ["uninstall"], 120_000);
      if (!result.ok) throw new Error(result.output || "resident enforcer removal failed");
      this.policyStore.write({ resident: false });
      this.journal.append({
        at: Date.now(),
        hostId,
        label: host.label,
        kind: "install",
        message: "resident enforcer removed",
      });
    }
    return this.residentState(hostId);
  }

  async residentState(hostId: string): Promise<SecurityResidentState> {
    const result = await this.runGuard(hostId, ["status"], 60_000);
    if (!result.ok) return { ...EMPTY_RESIDENT, output: result.output };
    const read = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(result.output)?.[1]?.trim() ?? "";
    const enforce = read("enforce").split(",").map((item) => item.trim()).filter(Boolean);
    return {
      installed: enforce.length > 0,
      active: read("timer") === "active",
      mode: undefined,
      enforce,
      output: result.output.slice(0, 1_500),
    };
  }

  async ban(hostId: string, address: string): Promise<{ ok: boolean; output: string }> {
    const outcome = await this.banHost(hostId, address);
    if (outcome.ok) await this.scan(hostId, { auto: true }).catch(() => undefined);
    return outcome;
  }

  async bans(hostId: string): Promise<string[]> {
    const result = await this.runGuard(hostId, ["bans"], 60_000);
    if (!result.ok) return [];
    return parseBans(result.output);
  }

  /* ---------------------------------------------------------------- internals */

  /**
   * Runs one validated guard subcommand. `helper` is the sudo-only route (no
   * shell, no caller string); `command` is the same invocation for a root login
   * or a password sudo, so every host reaches the same fixed entry point.
   */
  private runGuard(hostId: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
    for (const arg of args) {
      if (!/^[A-Za-z0-9@._:/-]+$/.test(arg)) throw new Error(`refusing unsafe guard argument: ${arg}`);
    }
    const command = `/usr/local/sbin/nexus-priv guard ${args.map((arg) => `'${arg}'`).join(" ")}`;
    // Unlike service/power/backup, every guard route reaches the installed
    // helper, so an outdated build is refused here even for root or a stored
    // sudo password. The scan reports it as a fixable finding.
    return runPrivileged(this.store, hostId, command, {
      helper: ["guard", ...args],
      timeoutMs,
      requireCurrentHelper: true,
    });
  }

  private async applyFix(hostId: string, id: string, auto: boolean): Promise<SecurityAction> {
    const host = this.store.sshHost(hostId);
    const meta = REMEDIATIONS[id];
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    if (!meta) throw new Error(`Unknown remediation: ${id}`);

    // This app is signing in with a password. Turning password auth off would
    // make the very next scan unreachable (and did exactly that once). The
    // finding stays visible until the host is switched to key auth.
    if (id === "ssh-key-only" && host.authMode === "password") {
      return {
        id,
        label: meta.label,
        ok: false,
        at: Date.now(),
        output: "refusing to disable password authentication: this host is configured with password sign-in; add a key and switch it to key auth first",
        auto,
      };
    }

    // Resident installation is a guard subcommand, not a `guard apply` id.
    if (id === "resident-install") {
      try {
        const state = await this.resident(hostId, true);
        const output = (state.output || (state.active ? "timer active" : "timer not active")).slice(0, 2_000);
        return { id, label: meta.label, ok: state.installed && state.active, at: Date.now(), output, auto };
      } catch (error) {
        const output = error instanceof Error ? error.message : String(error);
        return { id, label: meta.label, ok: false, at: Date.now(), output, auto };
      }
    }

    // The helper refresh is the one fix that cannot run through the helper,
    // because the helper is what is being replaced. It uses the ordinary
    // install route (root, NOPASSWD or stored sudo password).
    if (id === "helper-refresh") {
      let installed: HelperInstallResult;
      try {
        installed = await installHelper(this.store, helperAppRoot(), hostId, undefined, {
          trigger: auto ? "auto" : "manual",
        });
      } catch (error) {
        installed = {
          hostId,
          ok: false,
          route: "none",
          output: error instanceof Error ? error.message : String(error),
        };
      }
      const output = (installed.output || (installed.ok ? "installed" : "failed")).slice(0, 2_000);
      // installHelper recorded the attempt (trigger + route) in the journal.
      return { id, label: meta.label, ok: installed.ok, at: Date.now(), output, auto };
    }

    // A blocked helper (outdated, no route) must produce a failed finding, not
    // abort the whole scan.
    let result: { ok: boolean; output: string };
    try {
      result = await this.runGuard(hostId, ["apply", id], 300_000);
    } catch (error) {
      result = { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
    const output = (result.output || (result.ok ? "applied" : "failed")).slice(0, 2_000);
    this.journal.append({
      at: Date.now(),
      hostId,
      label: host.label,
      kind: "action",
      message: `${auto ? "auto" : "manual"} ${id} (${meta.label}): ${result.ok ? "ok" : "failed"} — ${output.replace(/\s+/g, " ").slice(0, 160)}`,
    });
    return { id, label: meta.label, ok: result.ok, at: Date.now(), output, auto };
  }

  private async banHost(hostId: string, address: string): Promise<{ ok: boolean; output: string }> {
    const host = this.store.sshHost(hostId);
    if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
    const trimmed = address.trim();
    if (!/^[0-9a-fA-F:.]+$/.test(trimmed) || trimmed.length > 45) {
      return { ok: false, output: `invalid address: ${address}` };
    }
    const policy = this.policyStore.read();
    if (policy.allowlist.includes(trimmed)) {
      return { ok: false, output: `${trimmed} is allowlisted` };
    }
    const result = await this.runGuard(hostId, ["ban", trimmed], 60_000);
    this.journal.append({
      at: Date.now(),
      hostId,
      label: host.label,
      kind: "contain",
      message: result.ok ? `banned ${trimmed} for 24h` : `ban ${trimmed} refused: ${result.output.slice(0, 160)}`,
    });
    return { ok: result.ok, output: result.output };
  }

  private acceptTouched(hostId: string, id: string, current: Record<string, string>): void {
    const touches = REMEDIATIONS[id]?.touches ?? [];
    if (touches.length === 0) return;
    const baseline = { ...this.baselines.get(hostId) };
    for (const key of touches) {
      if (current[key]) baseline[key] = current[key];
    }
    this.baselines.save(hostId, baseline);
  }
}

function parseBans(output: string): string[] {
  const found = new Set<string>();
  const block = /elements\s*=\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = block.exec(output)) !== null) {
    for (const raw of match[1].split(",")) {
      const token = raw.trim().split(/\s+/)[0];
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(token) || /^[0-9a-fA-F:]{2,45}$/.test(token)) found.add(token);
    }
  }
  return [...found];
}

export const guardian = new GuardianService();
