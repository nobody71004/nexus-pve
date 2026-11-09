import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type {
  AppInfo,
  HelperState,
  HostInput,
  HostRuntimeStatus,
  HostSummary,
  HostTestResult,
  SshAuthMode,
  SshHostInput,
  SshHostSummary,
  SshRuntimeStatus,
  SshTestResult,
} from "../../shared/types";
import { bridge } from "../lib/bridge";
import { ago, cx } from "../lib/format";
import { helperFleet, subscribeHelpers } from "../lib/helperFleet";
import { Icon } from "./Icon";
import { Chip, Panel } from "./ui";

const EMPTY: HostInput = {
  label: "",
  baseUrl: "",
  authMode: "token",
  tokenId: "",
  username: "root@pam",
  tlsVerify: false,
  secret: "",
};

const HELPER_TONE: Record<HelperState, "ok" | "warn" | "err"> = {
  ready: "ok",
  missing: "warn",
  partial: "warn",
  outdated: "warn",
  blocked: "err",
};

const HELPER_LABEL: Record<HelperState, string> = {
  ready: "helper ready",
  missing: "helper missing",
  partial: "helper partial",
  outdated: "helper outdated",
  blocked: "no root route",
};

const SSH_EMPTY: SshHostInput = {
  label: "",
  host: "",
  port: 22,
  username: "root",
  authMode: "key",
  keyPath: "~/.ssh/id_ed25519",
  password: "",
};

export function ConnectPanel({
  hosts,
  statuses,
  activeId,
  info,
  onSelect,
  onSave,
  onRemove,
  onTest,
  onOpenHosts,
}: {
  hosts: HostSummary[];
  statuses: Record<string, HostRuntimeStatus>;
  activeId: string | null;
  info: AppInfo | null;
  onSelect: (id: string) => void;
  onSave: (input: HostInput) => Promise<void>;
  onRemove: (host: HostSummary) => void | Promise<void>;
  onTest: (input: HostInput) => Promise<HostTestResult>;
  onOpenHosts?: () => void;
}) {
  const [editing, setEditing] = useState<HostInput | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<HostTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sshHosts, setSshHosts] = useState<SshHostSummary[]>([]);
  const [sshStatuses, setSshStatuses] = useState<Record<string, SshRuntimeStatus>>({});
  const [sshLoading, setSshLoading] = useState(true);
  const [sshError, setSshError] = useState<string | null>(null);
  const [sshEditing, setSshEditing] = useState<SshHostInput | null>(null);
  const [sshTesting, setSshTesting] = useState(false);
  const [sshSaving, setSshSaving] = useState(false);
  const [sshTestResult, setSshTestResult] = useState<SshTestResult | null>(null);
  const [sshFormError, setSshFormError] = useState<string | null>(null);
  const helperState = useSyncExternalStore(subscribeHelpers, helperFleet);

  const loadSsh = useCallback(async () => {
    // Render the configured inventory first; probing every host can take up to
    // the SSH timeout when one is down, and a server must not disappear while
    // its health check is still in flight.
    const list = await bridge.ssh.hosts();
    setSshHosts(list);
    setSshError(null);
    const health = await bridge.ssh.health();
    setSshStatuses(Object.fromEntries(health.map((entry) => [entry.id, { ...entry, checkedAt: Date.now() }])));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        await loadSsh();
      } catch (err) {
        if (!cancelled) setSshError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setSshLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadSsh]);

  const patch = (values: Partial<HostInput>) => setEditing((current) => (current ? { ...current, ...values } : current));

  const startNew = () => {
    setResult(null);
    setError(null);
    setSshEditing(null);
    setEditing({ ...EMPTY });
  };

  const startEdit = (host: HostSummary) => {
    setResult(null);
    setError(null);
    setSshEditing(null);
    setEditing({
      id: host.id,
      label: host.label,
      baseUrl: host.baseUrl,
      authMode: host.authMode,
      tokenId: host.tokenId ?? "",
      username: host.username ?? "root@pam",
      tlsVerify: host.tlsVerify,
      secret: "",
    });
  };

  const runTest = async () => {
    if (!editing) return;
    setTesting(true);
    setResult(null);
    setError(null);
    try {
      setResult(await onTest(editing));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(editing);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const patchSsh = (values: Partial<SshHostInput>) =>
    setSshEditing((current) => (current ? { ...current, ...values } : current));

  const startNewSsh = () => {
    setEditing(null);
    setSshTestResult(null);
    setSshFormError(null);
    setSshEditing({ ...SSH_EMPTY });
  };

  const runSshTest = async () => {
    if (!sshEditing) return;
    setSshTesting(true);
    setSshTestResult(null);
    setSshFormError(null);
    try {
      setSshTestResult(await bridge.ssh.test(sshEditing));
    } catch (err) {
      setSshFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSshTesting(false);
    }
  };

  const saveSsh = async () => {
    if (!sshEditing) return;
    setSshSaving(true);
    setSshFormError(null);
    try {
      await bridge.ssh.save(sshEditing);
      setSshEditing(null);
      setSshTestResult(null);
      await loadSsh();
    } catch (err) {
      setSshFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSshSaving(false);
    }
  };

  return (
    <div className="connections">
      <div className="stack">
        <Panel
          eyebrow="ENDPOINTS"
          title="Proxmox hosts"
          actions={
            <button className="btn small primary" onClick={startNew}>
              <Icon name="plus" size={13} /> Add host
            </button>
          }
        >
          <div className="host-cards">
            {hosts.map((host) => {
              const status = statuses[host.id];
              const health = status?.health ?? "connecting";
              return (
                <article className={cx("host-card", activeId === host.id && "active")} key={host.id} data-spot>
                  <header>
                    <span className="host-color" style={{ background: host.color }} />
                    <div>
                      <strong>{host.label}</strong>
                      <span className="mono subtle">{host.baseUrl}</span>
                    </div>
                    <Chip tone={health === "online" ? "ok" : health === "degraded" ? "warn" : health === "offline" ? "err" : "muted"} dot>
                      {health}
                    </Chip>
                  </header>
                  <div className="host-meta">
                    <span>
                      Auth <b className="mono">{host.authMode === "token" ? host.tokenId : host.username}</b>
                    </span>
                    <span>
                      TLS <b>{host.tlsVerify ? "verified" : "self-signed ok"}</b>
                    </span>
                    <span>
                      Seen <b>{ago(host.lastSeenAt)}</b>
                    </span>
                    {status?.latencyMs ? (
                      <span>
                        API <b className="mono">{status.latencyMs} ms</b>
                      </span>
                    ) : null}
                  </div>
                  {status?.error ? <p className="warn-text small">{status.error}</p> : null}
                  <footer>
                    <button className="btn small ghost" onClick={() => onSelect(host.id)}>
                      {activeId === host.id ? "Active view" : "Open console"}
                    </button>
                    <button className="btn small ghost" onClick={() => startEdit(host)}>
                      Edit
                    </button>
                    <button className="btn icon ghost danger" onClick={() => onRemove(host)} title="Remove host">
                      <Icon name="trash" size={12} />
                    </button>
                  </footer>
                </article>
              );
            })}
            {hosts.length === 0 ? (
              <div className="empty-inline">
                <Icon name="server" size={20} />
                <div>
                  <strong>No hosts yet</strong>
                  <p>Add your Proxmox endpoint and an API token. Nothing is stored in the renderer.</p>
                </div>
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel
          eyebrow="SSH FLEET"
          title="Linux servers"
          actions={
            <div className="inline-actions">
              <span className="hint small">
                {sshLoading && sshHosts.length === 0 ? "Checking…" : `${sshHosts.length} configured`}
              </span>
              <button className="btn small primary" onClick={startNewSsh}>
                <Icon name="plus" size={13} /> Add Linux host
              </button>
              {onOpenHosts ? (
                <button className="btn small ghost" onClick={onOpenHosts}>
                  <Icon name="terminal" size={13} /> Manage
                </button>
              ) : null}
            </div>
          }
        >
          <div className="host-cards">
            {sshHosts.map((host) => {
              const status = sshStatuses[host.id];
              const health = status?.health ?? "connecting";
              const helper = helperState.statuses.find((entry) => entry.hostId === host.id);
              return (
                <article className="host-card" key={host.id} data-spot>
                  <header>
                    <span className="host-color" style={{ background: host.color }} />
                    <div>
                      <strong>{host.label}</strong>
                      <span className="mono subtle">
                        {host.username}@{host.host}:{host.port}
                      </span>
                    </div>
                    <span className="host-health">
                      <Chip
                        tone={health === "online" ? "ok" : health === "degraded" ? "warn" : health === "offline" ? "err" : "muted"}
                        dot
                      >
                        {health}
                      </Chip>
                      {status?.latencyMs ? (
                        <span className="host-latency mono" title="authenticated probe round trip">
                          {Math.round(status.latencyMs)} ms
                        </span>
                      ) : null}
                    </span>
                  </header>
                  <div className="host-meta">
                    <span>
                      SSH <b>{host.authMode === "password" ? "stored password" : (host.keyPath ?? "key")}</b>
                    </span>
                    {helper ? <Chip tone={HELPER_TONE[helper.state]}>{HELPER_LABEL[helper.state]}</Chip> : null}
                    <span>
                      Seen <b>{ago(host.lastSeenAt)}</b>
                    </span>
                    {status?.checkedAt ? (
                      <span>
                        Checked <b>{ago(status.checkedAt)}</b>
                      </span>
                    ) : null}
                  </div>
                  {status?.error ? <p className="warn-text small">{status.error}</p> : null}
                  <footer>
                    {onOpenHosts ? (
                      <button className="btn small ghost" onClick={onOpenHosts}>
                        Open in Linux hosts
                      </button>
                    ) : null}
                  </footer>
                </article>
              );
            })}
            {sshHosts.length === 0 ? (
              <div className="empty-inline">
                <Icon name="terminal" size={20} />
                <div>
                  <strong>{sshLoading ? "Checking Linux servers…" : "No Linux servers yet"}</strong>
                  <p>
                    {sshError
                      ? sshError
                      : "Add a Linux host in the Linux hosts tab to manage services, power and backups over SSH."}
                  </p>
                </div>
              </div>
            ) : null}
            {sshError && sshHosts.length > 0 ? <p className="inline-error">{sshError}</p> : null}
          </div>
        </Panel>

        <Panel eyebrow="SECURITY" title="How credentials are handled">
          <ul className="security-list">
            <li>
              <Icon name="shield" size={14} /> Tokens and passwords are encrypted with AES-256-GCM under a per-user key file; they
              never cross the IPC bridge back to this window.
            </li>
            <li>
              <Icon name="shield" size={14} /> Create a dedicated API token (<code>Datacenter → Permissions → API Tokens</code>) with
              only the roles this console needs: <code>PVEAuditor</code> plus <code>VM.Backup</code>, <code>VM.PowerMgmt</code>,{" "}
              <code>VM.Snapshot</code> scoped to the guest pool.
            </li>
            <li>
              <Icon name="shield" size={14} /> Keep <code>root@pam</code> password auth for the console only. Prefer tokens for the
              MCP server.
            </li>
            <li>
              <Icon name="shield" size={14} /> Every destructive tool call is gated: interactive actions confirm in-app, MCP calls
              need <code>confirm:true</code>, and pipelines pause for an explicit approval.
            </li>
          </ul>
        </Panel>
      </div>

      <div className="stack">
        {editing ? (
          <Panel
            eyebrow={editing.id ? "EDIT HOST" : "NEW HOST"}
            title={editing.label || "Connect a Proxmox endpoint"}
            actions={
              <button className="btn icon ghost" onClick={() => setEditing(null)} title="Close form">
                <Icon name="close" size={13} />
              </button>
            }
          >
            <div className="form-grid">
              <label className="field">
                <span>Display name</span>
                <input
                  value={editing.label}
                  onChange={(event) => patch({ label: event.target.value })}
                  placeholder="demo-lab"
                />
              </label>
              <label className="field">
                <span>API address</span>
                <input
                  value={editing.baseUrl}
                  onChange={(event) => patch({ baseUrl: event.target.value })}
                  placeholder="192.0.2.10"
                />
                <em className="hint">https:// is assumed; port 8006 is added when omitted.</em>
              </label>
              <label className="field wide">
                <span>Authentication</span>
                <div className="segmented">
                  <button
                    className={cx("seg", editing.authMode === "token" && "active")}
                    onClick={() => patch({ authMode: "token" })}
                    type="button"
                  >
                    API token (recommended)
                  </button>
                  <button
                    className={cx("seg", editing.authMode === "password" && "active")}
                    onClick={() => patch({ authMode: "password" })}
                    type="button"
                  >
                    User password
                  </button>
                </div>
              </label>
              {editing.authMode === "token" ? (
                <>
                  <label className="field">
                    <span>Token id</span>
                    <input
                      value={editing.tokenId ?? ""}
                      onChange={(event) => patch({ tokenId: event.target.value })}
                      placeholder="nexus@pve!console"
                    />
                  </label>
                  <label className="field">
                    <span>Token secret</span>
                    <input
                      type="password"
                      value={editing.secret ?? ""}
                      onChange={(event) => patch({ secret: event.target.value })}
                      placeholder={editing.id ? "leave blank to keep stored secret" : "xxxxxxxx-xxxx-xxxx"}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="field">
                    <span>Username</span>
                    <input
                      value={editing.username ?? ""}
                      onChange={(event) => patch({ username: event.target.value })}
                      placeholder="root@pam"
                    />
                  </label>
                  <label className="field">
                    <span>Password</span>
                    <input
                      type="password"
                      value={editing.secret ?? ""}
                      onChange={(event) => patch({ secret: event.target.value })}
                      placeholder={editing.id ? "leave blank to keep stored password" : "••••••••"}
                    />
                  </label>
                </>
              )}
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={editing.tlsVerify}
                onChange={(event) => patch({ tlsVerify: event.target.checked })}
              />
              <span>Verify TLS certificate (turn off only for a trusted self-signed host)</span>
            </label>

            {error ? <p className="inline-error">{error}</p> : null}
            {result ? (
              <div className={cx("test-result", result.ok ? "ok" : "err")}>
                <strong>{result.ok ? "Handshake successful" : "Connection failed"}</strong>
                {result.ok ? (
                  <span className="mono">
                    PVE {result.version} · {result.latencyMs} ms{result.clusterName ? ` · cluster ${result.clusterName}` : ""}
                    {result.nodes ? ` · nodes ${result.nodes.join(", ")}` : ""}
                  </span>
                ) : (
                  <span>{result.error}</span>
                )}
                {result.tlsFingerprint ? <span className="mono subtle small">{result.tlsFingerprint}</span> : null}
              </div>
            ) : null}

            <div className="form-actions">
              <button className="btn ghost" onClick={runTest} disabled={testing || !editing.baseUrl}>
                {testing ? "Testing…" : "Test connection"}
              </button>
              <button className="btn primary" onClick={save} disabled={saving || !editing.baseUrl}>
                {saving ? "Saving…" : editing.id ? "Save changes" : "Add host"}
              </button>
            </div>
          </Panel>
        ) : sshEditing ? null : (
          <Panel eyebrow="NO SELECTION" title="Add a host to begin">
            <p className="subtle">Pick a host on the left or create a new connection.</p>
            <button className="btn primary" onClick={startNew}>
              <Icon name="plus" size={13} /> Add host
            </button>
          </Panel>
        )}

        {sshEditing ? (
          <Panel
            eyebrow="NEW LINUX HOST"
            title={sshEditing.label || "Add an SSH server"}
            actions={
              <button className="btn icon ghost" onClick={() => setSshEditing(null)} title="Close form">
                <Icon name="close" size={13} />
              </button>
            }
          >
            <div className="form-grid">
              <label className="field">
                <span>Display name</span>
                <input
                  value={sshEditing.label}
                  onChange={(event) => patchSsh({ label: event.target.value })}
                  placeholder="demo-dedicated"
                  autoFocus
                />
              </label>
              <label className="field">
                <span>Host or IP</span>
                <input
                  value={sshEditing.host}
                  onChange={(event) => patchSsh({ host: event.target.value })}
                  placeholder="203.0.113.20"
                />
              </label>
              <label className="field">
                <span>Username</span>
                <input
                  value={sshEditing.username}
                  onChange={(event) => patchSsh({ username: event.target.value })}
                  placeholder="root"
                />
              </label>
              <label className="field">
                <span>Port</span>
                <input
                  type="number"
                  value={sshEditing.port ?? 22}
                  onChange={(event) => patchSsh({ port: Number(event.target.value) })}
                />
              </label>
              <label className="field wide">
                <span>Authentication</span>
                <div className="segmented">
                  <button
                    type="button"
                    className={cx("seg", (sshEditing.authMode ?? "key") === "key" && "active")}
                    onClick={() => patchSsh({ authMode: "key" as SshAuthMode })}
                  >
                    Private key / agent
                  </button>
                  <button
                    type="button"
                    className={cx("seg", sshEditing.authMode === "password" && "active")}
                    onClick={() => patchSsh({ authMode: "password" as SshAuthMode })}
                  >
                    Password
                  </button>
                </div>
              </label>
              {(sshEditing.authMode ?? "key") === "key" ? (
                <label className="field wide">
                  <span>Private key path</span>
                  <input
                    value={sshEditing.keyPath ?? ""}
                    onChange={(event) => patchSsh({ keyPath: event.target.value })}
                    placeholder="~/.ssh/id_ed25519"
                  />
                  <em className="hint">Blank uses your ssh agent and default keys. The key never leaves this machine.</em>
                </label>
              ) : (
                <label className="field wide">
                  <span>Password</span>
                  <input
                    type="password"
                    value={sshEditing.password ?? ""}
                    onChange={(event) => patchSsh({ password: event.target.value })}
                    placeholder="••••••••"
                  />
                  <em className="hint">Encrypted with AES-256-GCM under the same vault as your Proxmox token.</em>
                </label>
              )}
            </div>

            {sshFormError ? <p className="inline-error">{sshFormError}</p> : null}
            {sshTestResult ? (
              <div className={cx("test-result", sshTestResult.ok ? "ok" : "err")}>
                <strong>{sshTestResult.ok ? "SSH handshake successful" : "SSH connection failed"}</strong>
                {sshTestResult.ok ? (
                  <span className="mono">
                    {sshTestResult.hostname} · {sshTestResult.os} · {sshTestResult.kernel} · {sshTestResult.cores} threads ·{" "}
                    {sshTestResult.latencyMs} ms
                  </span>
                ) : (
                  <span>{sshTestResult.error}</span>
                )}
              </div>
            ) : null}

            <div className="form-actions">
              <button
                className="btn ghost"
                onClick={() => void runSshTest()}
                disabled={sshTesting || !sshEditing.host || !sshEditing.username}
              >
                {sshTesting ? "Testing…" : "Test SSH"}
              </button>
              <button
                className="btn primary"
                onClick={() => void saveSsh()}
                disabled={sshSaving || !sshEditing.host || !sshEditing.username}
              >
                {sshSaving ? "Saving…" : "Add host"}
              </button>
            </div>
          </Panel>
        ) : null}

        <Panel eyebrow="RUNTIME" title="Application">
          {info ? (
            <div className="about-grid">
              <div>
                <span>Nexus PVE</span>
                <strong>v{info.version}</strong>
              </div>
              <div>
                <span>Electron</span>
                <strong className="mono">{info.electron}</strong>
              </div>
              <div>
                <span>Node</span>
                <strong className="mono">{info.node}</strong>
              </div>
              <div>
                <span>Platform</span>
                <strong className="mono">{info.platform}</strong>
              </div>
              <div className="wide">
                <span>Config</span>
                <strong className="mono small">{info.configPath}</strong>
              </div>
              <div className="wide">
                <span>MCP server</span>
                <strong className="mono small">{info.mcpServerPath}</strong>
              </div>
            </div>
          ) : (
            <p className="subtle small">Loading runtime details…</p>
          )}
        </Panel>
      </div>
    </div>
  );
}
