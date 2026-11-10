import { useMemo, useState } from "react";
import type { McpStatus, PipelineDef, PipelineRun } from "../../shared/types";
import { cx, dateTime, duration } from "../lib/format";
import { Icon, type IconName } from "./Icon";
import { Chip, MiniBar, Panel } from "./ui";

const CATEGORY_TONE: Record<PipelineDef["category"], "info" | "violet" | "warn" | "ok" | "muted"> = {
  health: "info",
  backup: "ok",
  maintenance: "warn",
  incident: "violet",
  dev: "muted",
};

const STATUS_TONE: Record<PipelineRun["status"], "ok" | "err" | "warn" | "info" | "muted"> = {
  ok: "ok",
  error: "err",
  "waiting-approval": "warn",
  running: "info",
  cancelled: "muted",
};

const STEP_ICON: Record<string, IconName> = {
  pending: "clock",
  running: "activity",
  "waiting-approval": "alert",
  ok: "check",
  error: "alert",
  skipped: "chevron",
};

export function PipelineStudio({
  hostLabel,
  pipelines,
  runs,
  activeRun,
  mcp,
  storageOptions,
  onRun,
  onSelectRun,
  onApprove,
  onCancel,
  onWriteMcp,
  onCopy,
}: {
  hostLabel: string;
  pipelines: PipelineDef[];
  runs: PipelineRun[];
  activeRun: PipelineRun | null;
  mcp: McpStatus | null;
  storageOptions: string[];
  onRun: (pipeline: PipelineDef, vars: Record<string, unknown>) => Promise<void>;
  onSelectRun: (run: PipelineRun) => void;
  onApprove: (runId: string, approved: boolean) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
  onWriteMcp: (target: "claude" | "cursor" | "vscode") => Promise<void>;
  onCopy: (text: string) => void;
}) {
  const [vars, setVars] = useState<Record<string, { storage: string; note: string; command: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<PipelineDef["category"], PipelineDef[]>();
    for (const pipeline of pipelines) {
      const list = map.get(pipeline.category) ?? [];
      list.push(pipeline);
      map.set(pipeline.category, list);
    }
    return [...map.entries()];
  }, [pipelines]);

  const valueFor = (id: string) =>
    vars[id] ?? {
      storage: storageOptions[0] ?? "",
      note: "",
      command: id === "fleet-command" ? "uptime" : "",
    };

  return (
    <div className="pipeline-layout">
      <div className="stack">
        {grouped.map(([category, defs]) => (
          <Panel key={category} eyebrow={`${category.toUpperCase()} PIPELINES`} title={undefined}>
            <div className="pipeline-grid">
              {defs.map((def) => {
                const current = valueFor(def.id);
                return (
                  <article className="pipeline-card" key={def.id}>
                    <header>
                      <div className="pipeline-title">
                        <span className={cx("pipeline-orb", def.category)} />
                        <div>
                          <strong>{def.name}</strong>
                          <span className="mono subtle">
                            {def.steps.length} steps · {def.builtIn ? "built-in" : "custom"}
                          </span>
                        </div>
                      </div>
                      <Chip tone={CATEGORY_TONE[def.category]}>{def.category}</Chip>
                    </header>
                    <p className="pipeline-desc">{def.description}</p>
                    <ol className="step-preview">
                      {def.steps.map((step) => (
                        <li key={step.id}>
                          <span className={cx("step-dot", step.approval && step.approval !== "never" ? "guard" : "")} />
                          {step.title}
                          {step.approval && step.approval !== "never" ? <em className="guard-label">approval</em> : null}
                        </li>
                      ))}
                    </ol>
                    {def.id === "backup-fleet" ? (
                      <label className="field compact">
                        <span>Target storage</span>
                        <select
                          value={current.storage}
                          onChange={(event) =>
                            setVars((previous) => ({ ...previous, [def.id]: { ...current, storage: event.target.value } }))
                          }
                        >
                          {storageOptions.map((storage) => (
                            <option key={storage} value={storage}>
                              {storage}
                            </option>
                          ))}
                          {storageOptions.length === 0 ? <option value="">default</option> : null}
                        </select>
                      </label>
                    ) : null}
                    {def.id === "incident-capture" ? (
                      <label className="field compact">
                        <span>Note</span>
                        <input
                          placeholder="what is being investigated"
                          value={current.note}
                          onChange={(event) =>
                            setVars((previous) => ({ ...previous, [def.id]: { ...current, note: event.target.value } }))
                          }
                        />
                      </label>
                    ) : null}
                    {def.id === "fleet-command" ? (
                      <label className="field compact">
                        <span>Command</span>
                        <input
                          placeholder="uptime"
                          value={current.command}
                          onChange={(event) =>
                            setVars((previous) => ({ ...previous, [def.id]: { ...current, command: event.target.value } }))
                          }
                        />
                      </label>
                    ) : null}
                    <footer>
                      <button
                        className="btn small primary"
                        disabled={busy === def.id}
                        onClick={async () => {
                          setBusy(def.id);
                          try {
                            await onRun(def, {
                              storage: current.storage || undefined,
                              note: current.note || undefined,
                              command: current.command || undefined,
                            });
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        <Icon name="play" size={12} /> {busy === def.id ? "Starting…" : "Run"}
                      </button>
                      <span className="mono subtle">host: {hostLabel}</span>
                    </footer>
                  </article>
                );
              })}
            </div>
          </Panel>
        ))}
      </div>

      <div className="stack pipeline-side">
        <Panel
          eyebrow="LIVE RUN"
          title={activeRun ? activeRun.name : "No active run"}
          actions={
            activeRun && (activeRun.status === "running" || activeRun.status === "waiting-approval") ? (
              <button className="btn small ghost danger" onClick={() => onCancel(activeRun.id)}>
                Cancel run
              </button>
            ) : null
          }
        >
          {!activeRun ? (
            <div className="empty-inline">
              <Icon name="agent" size={20} />
              <div>
                <strong>Agent idle</strong>
                <p>Start a pipeline. Destructive steps pause here for an explicit approval.</p>
              </div>
            </div>
          ) : (
            <div className="run-view">
              <div className="run-head">
                <Chip tone={STATUS_TONE[activeRun.status]} dot>
                  {activeRun.status}
                </Chip>
                <span className="mono subtle">
                  started {dateTime(activeRun.startedAt)}
                  {activeRun.endedAt ? ` · ${duration((activeRun.endedAt - activeRun.startedAt) / 1000)}` : ""}
                </span>
              </div>

              {activeRun.approval ? (
                <div className="approval-card">
                  <div className="approval-head">
                    <Icon name="shield" size={16} />
                    <div>
                      <strong>Human approval required</strong>
                      <span>
                        {activeRun.approval.tool} · step {activeRun.approval.stepId}
                      </span>
                    </div>
                  </div>
                  <pre className="approval-args">{JSON.stringify(activeRun.approval.args, null, 2)}</pre>
                  <div className="approval-actions">
                    <button className="btn primary" onClick={() => onApprove(activeRun.id, true)}>
                      <Icon name="check" size={13} /> Approve step
                    </button>
                    <button className="btn ghost danger" onClick={() => onApprove(activeRun.id, false)}>
                      Decline
                    </button>
                  </div>
                </div>
              ) : null}

              <ol className="run-steps">
                {activeRun.steps.map((step) => (
                  <li key={step.id} className={cx("run-step", step.status)}>
                    <span className="step-icon">
                      <Icon name={STEP_ICON[step.status] ?? "clock"} size={12} />
                    </span>
                    <div>
                      <strong>{step.title}</strong>
                      <span className="mono subtle">
                        {step.tool}
                        {step.attempts > 1 ? ` · attempt ${step.attempts}` : ""}
                      </span>
                      {step.error ? <em className="warn-text small">{step.error}</em> : null}
                    </div>
                    <Chip tone={step.status === "ok" ? "ok" : step.status === "error" ? "err" : step.status === "waiting-approval" ? "warn" : "muted"}>
                      {step.status}
                    </Chip>
                  </li>
                ))}
              </ol>

              <div className="run-log">
                {activeRun.log.slice(-60).map((entry, index) => (
                  <div className={cx("log-line", entry.level)} key={`${entry.at}-${index}`}>
                    <span className="mono log-time">{new Date(entry.at).toLocaleTimeString()}</span>
                    <span>{entry.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel eyebrow="HISTORY" title="Recent runs">
          <div className="run-history">
            {runs.slice(0, 8).map((run) => (
              <button key={run.id} className={cx("history-row", activeRun?.id === run.id && "active")} onClick={() => onSelectRun(run)}>
                <Chip tone={STATUS_TONE[run.status]} dot>
                  {run.status}
                </Chip>
                <span className="history-name">{run.name}</span>
                <span className="mono subtle">{dateTime(run.startedAt)}</span>
                <MiniBar
                  value={
                    run.steps.length === 0
                      ? 0
                      : (run.steps.filter((step) => step.status === "ok").length / run.steps.length) * 100
                  }
                  tone={run.status === "ok" ? "green" : run.status === "error" ? "red" : "cyan"}
                />
              </button>
            ))}
            {runs.length === 0 ? <p className="subtle small">No runs recorded yet.</p> : null}
          </div>
        </Panel>

        <Panel eyebrow="AGENT ACCESS" title="MCP server">
          {mcp ? (
            <div className="mcp-panel">
              <div className="mcp-stats">
                <div>
                  <span>Tools</span>
                  <strong>{mcp.toolCount}</strong>
                </div>
                <div>
                  <span>Hosts</span>
                  <strong>{mcp.hostCount}</strong>
                </div>
                <div>
                  <span>Transport</span>
                  <strong className="mono">stdio</strong>
                </div>
              </div>
              <label className="field">
                <span>Launch command</span>
                <div className="copy-row">
                  <code className="mono">{`${mcp.command} "${mcp.serverPath}"`}</code>
                  <button className="btn icon ghost" onClick={() => onCopy(`${mcp.command} "${mcp.serverPath}"`)} title="Copy">
                    <Icon name="copy" size={13} />
                  </button>
                </div>
              </label>
              <p className="hint">
                Register once and any MCP client can read the fleet, run backups, drive pipelines and even build this app via the{" "}
                <code>dev.*</code> tools.
              </p>
              <div className="mcp-actions">
                <button className="btn small" onClick={() => onWriteMcp("claude")}>
                  <Icon name="plus" size={12} /> Claude Desktop
                </button>
                <button className="btn small" onClick={() => onWriteMcp("cursor")}>
                  <Icon name="plus" size={12} /> Cursor
                </button>
                <button className="btn small" onClick={() => onWriteMcp("vscode")}>
                  <Icon name="plus" size={12} /> VS Code
                </button>
              </div>
              <span className="subtle small mono">{mcp.toolCount} tool schemas live · config: {mcp.configPath}</span>
            </div>
          ) : (
            <p className="subtle small">Reading MCP status…</p>
          )}
        </Panel>
      </div>
    </div>
  );
}
