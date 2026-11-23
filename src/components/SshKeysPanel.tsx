import { useEffect, useState } from "react";
import type { SshKeyIssueResult, SshKeyOverview, TeamMachine, TeamUser } from "../../shared/types";
import { bridge } from "../lib/bridge";
import { SshKeyReveal } from "./SshKeyReveal";

function ago(at: number): string {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function shortFingerprint(value: string): string {
  return value.length > 28 ? `${value.slice(0, 22)}…` : value;
}

function trustLabel(source: "managed" | "trusted" | "unknown"): string {
  return source === "managed" ? "managed" : source === "trusted" ? "trusted" : "unmanaged";
}

export function SshKeysPanel({ onToast }: { onToast: (level: "info" | "warn" | "error" | "ok", title: string, detail?: string) => void }) {
  const [overview, setOverview] = useState<SshKeyOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState("operator");
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<TeamUser[]>([]);
  const [teamMachines, setTeamMachines] = useState<TeamMachine[]>([]);
  const [memberId, setMemberId] = useState("");
  const [memberHostId, setMemberHostId] = useState("");
  const [memberRotate, setMemberRotate] = useState(false);
  const [revealed, setRevealed] = useState<SshKeyIssueResult | null>(null);

  const refresh = async () => {
    try {
      const next = await bridge.sshkeys.overview();
      setOverview(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
    return bridge.sshkeys.onChanged((next) => {
      setOverview(next);
      setError(null);
    });
  }, []);

  useEffect(() => {
    void bridge.team
      .overview()
      .then((team) => {
        const standard = team.users.filter((user) => user.role === "user");
        setMembers(standard);
        setTeamMachines(team.machines);
        setMemberId((current) => (current && standard.some((user) => user.id === current) ? current : standard[0]?.id ?? ""));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const memberHosts = overview
    ? overview.hosts.filter((host) => {
        const machine = teamMachines.find((entry) => entry.id === host.hostId);
        return !machine || machine.linkedUserIds.includes(memberId);
      })
    : [];

  useEffect(() => {
    if (!overview) return;
    setMemberHostId((current) =>
      memberHosts.some((host) => host.hostId === current) ? current : (memberHosts[0]?.hostId ?? ""),
    );
    // memberHosts is derived from these three inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, memberId, teamMachines]);

  const issueMemberKey = async (input: { hostId: string; userId?: string; rotate?: boolean }) => {
    setBusy("issue-member");
    setError(null);
    try {
      const result = await bridge.sshkeys.issue(input);
      setRevealed(result);
      await refresh();
      onToast("ok", "Machine key issued", `${result.key.label} · ${result.fingerprint.slice(0, 22)}…`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onToast("error", "Could not issue machine key", message);
    } finally {
      setBusy(null);
    }
  };

  const run = async (name: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(name);
    try {
      await action();
      await refresh();
      if (success) onToast("ok", success);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onToast("error", "SSH key operation failed", message);
    } finally {
      setBusy(null);
    }
  };

  if (!overview) {
    return (
      <section className="sshkeys-panel">
        <div className="sshkeys-loading">{error ? `SSH key service unavailable: ${error}` : "Loading SSH key control plane…"}</div>
      </section>
    );
  }

  const operatorKeys = overview.keys.filter((key) => !key.assignedTo);
  const activeKeys = operatorKeys.filter((key) => key.status === "active");
  const retiredKeys = operatorKeys.filter((key) => key.status === "retired");
  const issuedKeys = overview.keys.filter((key) => key.assignedTo && key.status === "active");
  const retiredIssued = overview.keys.filter((key) => key.assignedTo && key.status === "retired").length;
  const hostName = (hostId: string) => overview.hosts.find((host) => host.hostId === hostId)?.label ?? hostId;
  const firstHost = overview.hosts[0]?.hostId ?? "";

  return (
    <section className="sshkeys-panel">
      <header className="sshkeys-head">
        <div>
          <span className="sshkeys-kicker">SSH key control plane</span>
          <h2>Users → servers, with a watchdog.</h2>
          <p>
            Ed25519 keys generated here are encrypted in the Nexus vault. Deploying adds only the public key to the
            configured account, then points that host at the private key for login.
          </p>
        </div>
        <div className="sshkeys-watch">
          <span className={`sshkeys-live ${overview.running ? "on" : "off"}`}>
            <i /> {overview.running ? "24/7 watcher running" : "watcher stopped"}
          </span>
          <span className="mono subtle">every {overview.policy.intervalSec}s</span>
          <label className="sshkeys-toggle">
            <input
              type="checkbox"
              checked={overview.policy.autoEnforce}
              disabled={Boolean(busy)}
              onChange={() =>
                run(
                  "policy",
                  () => bridge.sshkeys.policy({ autoEnforce: !overview.policy.autoEnforce }),
                  !overview.policy.autoEnforce ? "Automatic enforcement enabled" : "Automatic enforcement disabled",
                )
              }
            />
            <span>Auto-enforce unmanaged</span>
          </label>
        </div>
      </header>

      {error ? <div className="sshkeys-error">{error}</div> : null}

      <div className="sshkeys-create">
        <div className="sshkeys-create-copy">
          <strong>Generate a user key</strong>
          <span>Private material stays on this machine, encrypted at rest.</span>
        </div>
        <input
          aria-label="Key label"
          placeholder="Key label, e.g. matt-laptop"
          value={label}
          maxLength={64}
          onChange={(event) => setLabel(event.target.value)}
        />
        <input
          aria-label="Key owner"
          placeholder="Owner"
          value={owner}
          maxLength={64}
          onChange={(event) => setOwner(event.target.value)}
        />
        <button
          className="sshkeys-btn primary"
          disabled={Boolean(busy) || !label.trim()}
          onClick={() =>
            run(
              "generate",
              async () => {
                await bridge.sshkeys.generate({ label: label.trim(), owner: owner.trim() || "operator" });
                setLabel("");
              },
              "SSH key generated",
            )
          }
        >
          Generate key
        </button>
      </div>

      <div className="sshkeys-create member">
        <div className="sshkeys-create-copy">
          <strong>Issue a machine key to a member</strong>
          <span>One key, one machine. The private half is revealed once for the member to install.</span>
        </div>
        <select
          aria-label="Member"
          value={memberId}
          onChange={(event) => setMemberId(event.target.value)}
          disabled={Boolean(busy) || members.length === 0}
        >
          {members.length === 0 ? <option value="">No standard members</option> : null}
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.displayName} (@{member.username})
            </option>
          ))}
        </select>
        <select
          aria-label="Machine"
          value={memberHostId}
          onChange={(event) => setMemberHostId(event.target.value)}
          disabled={Boolean(busy) || memberHosts.length === 0}
        >
          {memberHosts.length === 0 ? <option value="">No machines granted</option> : null}
          {memberHosts.map((host) => (
            <option key={host.hostId} value={host.hostId}>
              {host.label} — {host.username}@{host.host}
            </option>
          ))}
        </select>
        <label className="sshkeys-rotate">
          <input
            type="checkbox"
            checked={memberRotate}
            onChange={(event) => setMemberRotate(event.target.checked)}
            disabled={Boolean(busy)}
          />
          <span>Rotate</span>
        </label>
        <button
          className="sshkeys-btn primary"
          disabled={Boolean(busy) || !memberId || !memberHostId}
          onClick={() => void issueMemberKey({ hostId: memberHostId, userId: memberId, rotate: memberRotate })}
        >
          {busy === "issue-member" ? "Issuing…" : "Issue & reveal"}
        </button>
      </div>

      <div className="sshkeys-issued">
        <div className="sshkeys-section-head">
          <h3>Member machine access</h3>
          <span>
            {issuedKeys.length} active{retiredIssued ? ` · ${retiredIssued} retired` : ""}
          </span>
        </div>
        {issuedKeys.length === 0 ? (
          <div className="sshkeys-empty">No member machine keys yet. Issue one above, or let a member create their own from Team access.</div>
        ) : (
          <div className="sshkeys-issued-list">
            {issuedKeys.map((key) => (
              <article className="sshkeys-issued-row" key={key.id}>
                <div className="sshkeys-issued-who">
                  <strong>{key.assignedTo?.displayName ?? key.owner}</strong>
                  <span>
                    @{key.assignedTo?.username ?? "member"} → {hostName(key.issuedHostId ?? "")}
                  </span>
                </div>
                <code title={key.fingerprint}>{shortFingerprint(key.fingerprint)}</code>
                <span className="subtle">{ago(key.createdAt)}</span>
                <div className="sshkeys-key-actions">
                  <button
                    className="sshkeys-btn"
                    disabled={Boolean(busy) || !key.issuedHostId || !key.assignedTo}
                    onClick={() => {
                      if (!key.issuedHostId || !key.assignedTo) return;
                      if (!window.confirm(`Rotate ${key.label}? The member's old key is removed from the machine.`)) return;
                      void issueMemberKey({ hostId: key.issuedHostId, userId: key.assignedTo.id, rotate: true });
                    }}
                  >
                    Rotate
                  </button>
                  <button
                    className="sshkeys-btn danger"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (!window.confirm(`Revoke ${key.label}? The member loses direct SSH access to this machine.`)) return;
                      void run("revoke", () => bridge.sshkeys.revoke(key.id, true), `Revoked ${key.label}`);
                    }}
                  >
                    Revoke
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="sshkeys-grid">
        <div className="sshkeys-column">
          <div className="sshkeys-section-head">
            <h3>Managed keys</h3>
            <span>{activeKeys.length} active{retiredKeys.length ? ` · ${retiredKeys.length} retired` : ""}</span>
          </div>
          {activeKeys.length === 0 ? <div className="sshkeys-empty">No managed keys yet. Generate one above.</div> : null}
          {activeKeys.map((key) => {
            const target = targets[key.id] ?? firstHost;
            return (
              <article className="sshkeys-key" key={key.id}>
                <div className="sshkeys-key-head">
                  <div>
                    <strong>{key.label}</strong>
                    <span className="subtle">{key.owner} · {ago(key.createdAt)}</span>
                  </div>
                  <span className="sshkeys-badge managed">managed</span>
                </div>
                <code title={key.fingerprint}>{shortFingerprint(key.fingerprint)}</code>
                <div className="sshkeys-key-meta">
                  <span>{key.hosts.length > 0 ? `on ${key.hosts.map(hostName).join(", ")}` : "not deployed"}</span>
                  <span className="mono">{key.algorithm}</span>
                </div>
                <div className="sshkeys-key-actions">
                  <select
                    aria-label={`Deploy ${key.label} to host`}
                    value={target}
                    onChange={(event) => setTargets((current) => ({ ...current, [key.id]: event.target.value }))}
                    disabled={Boolean(busy) || overview.hosts.length === 0}
                  >
                    {overview.hosts.length === 0 ? <option value="">No Linux hosts</option> : null}
                    {overview.hosts.map((host) => (
                      <option key={host.hostId} value={host.hostId}>
                        {host.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="sshkeys-btn"
                    disabled={Boolean(busy) || !target}
                    onClick={() => run("deploy", () => bridge.sshkeys.deploy(target, key.id), `Deployed ${key.label}`)}
                  >
                    Deploy
                  </button>
                  <button
                    className="sshkeys-btn danger"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (!window.confirm(`Revoke ${key.label} from ${key.hosts.length} host(s)? A backup is made on each host.`)) return;
                      void run("revoke", () => bridge.sshkeys.revoke(key.id, true), `Revoked ${key.label}`);
                    }}
                  >
                    Revoke
                  </button>
                </div>
              </article>
            );
          })}
        </div>

        <div className="sshkeys-column">
          <div className="sshkeys-section-head">
            <h3>Host authorized_keys</h3>
            <span>{overview.hosts.reduce((sum, host) => sum + host.unknown, 0)} unmanaged found</span>
          </div>
          {overview.hosts.length === 0 ? <div className="sshkeys-empty">Add a Linux host first, then scan it here.</div> : null}
          {overview.hosts.map((host) => (
            <article className={`sshkeys-host ${host.unknown > 0 ? "alert" : ""}`} key={host.hostId}>
              <div className="sshkeys-host-head">
                <div>
                  <strong>{host.label}</strong>
                  <span className="mono subtle">{host.username}@{host.host}</span>
                </div>
                <div className="sshkeys-counts">
                  {host.managed > 0 ? <span className="managed">{host.managed} managed</span> : null}
                  {host.trusted > 0 ? <span className="trusted">{host.trusted} trusted</span> : null}
                  {host.unknown > 0 ? <span className="unknown">{host.unknown} unmanaged</span> : null}
                </div>
              </div>
              <div className="sshkeys-host-meta">
                <span className="mono">{host.path}{host.mode ? ` · ${host.mode}` : ""}</span>
                <span>scanned {ago(host.scannedAt)}</span>
              </div>
              {host.error ? <div className="sshkeys-host-error">{host.error}</div> : null}
              {!host.error && host.keys.length > 0 ? (
                <div className="sshkeys-key-list">
                  {host.keys.map((key) => (
                    <div key={key.fingerprint} className={`sshkeys-found ${key.source}`}>
                      <span className={`sshkeys-badge ${key.source}`}>{trustLabel(key.source)}</span>
                      <span className="mono" title={key.fingerprint}>{shortFingerprint(key.fingerprint)}</span>
                      <span className="subtle">{key.comment || "no comment"}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {!host.error && host.exists && host.keys.length === 0 ? <div className="sshkeys-empty">authorized_keys is empty.</div> : null}
              {!host.error && !host.exists ? <div className="sshkeys-empty">authorized_keys does not exist yet.</div> : null}
              <div className="sshkeys-host-actions">
                <button className="sshkeys-btn" disabled={Boolean(busy)} onClick={() => run("scan", () => bridge.sshkeys.scan(host.hostId), `Scanned ${host.label}`)}>
                  Scan now
                </button>
                <button
                  className="sshkeys-btn"
                  disabled={Boolean(busy) || host.unknown === 0 || Boolean(host.error)}
                  onClick={() => {
                    if (!window.confirm(`Trust all ${host.unknown} unmanaged key(s) on ${host.label}?`)) return;
                    void run("trust", () => bridge.sshkeys.trust(host.hostId), `Trusted keys on ${host.label}`);
                  }}
                >
                  Trust unmanaged
                </button>
                <button
                  className="sshkeys-btn danger"
                  disabled={Boolean(busy) || host.unknown === 0 || Boolean(host.error)}
                  onClick={() => {
                    if (!window.confirm(`Remove ${host.unknown} unmanaged key(s) from ${host.label}? The current login key is protected.`)) return;
                    void run("enforce", () => bridge.sshkeys.enforce(host.hostId, true), `Enforced ${host.label}`);
                  }}
                >
                  Enforce
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>

      {revealed ? <SshKeyReveal result={revealed} onClose={() => setRevealed(null)} onToast={onToast} /> : null}

      <div className="sshkeys-events">
        <div className="sshkeys-section-head">
          <h3>Watcher journal</h3>
          <span>newest first</span>
        </div>
        {overview.events.length === 0 ? <div className="sshkeys-empty">No SSH-key activity recorded yet.</div> : null}
        {overview.events.slice(0, 12).map((event, index) => (
          <div className={`sshkeys-event ${event.ok ? "ok" : "bad"}`} key={`${event.at}-${index}`}>
            <span className="mono subtle">{new Date(event.at).toLocaleTimeString()}</span>
            <span className="sshkeys-event-kind">{event.kind}</span>
            <span>{event.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
