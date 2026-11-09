import { useCallback, useEffect, useMemo, useState } from "react";
import type { SshAuthMode, SshHostInput, SshHostSummary } from "../../shared/types";
import type {
  TeamMachine,
  TeamOverview,
  TeamRole,
  TeamStatus,
  TeamUser,
  TeamUserInput,
  TeamUserPatch,
} from "../../shared/team-types";
import type { TeamAuditFilter, TeamAuditResult, TeamSyncStatus } from "../../shared/types";
import { bridge } from "../lib/bridge";
import { ago, cx, dateTime } from "../lib/format";
import { Icon } from "./Icon";
import { Chip, Modal, Panel, Skeleton, StatTile, type ToastItem } from "./ui";

type TeamTab = "members" | "machines" | "activity" | "sync" | "profile";
type Toast = (level: ToastItem["level"], title: string, detail?: string) => void;

const ROLE_LABEL: Record<TeamRole, string> = { admin: "Admin", moderator: "Mod", user: "Member" };
const ROLE_TONE: Record<TeamRole, "info" | "violet" | "muted"> = {
  admin: "violet",
  moderator: "info",
  user: "muted",
};

const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "workspace.bootstrap": "Workspace created",
  "user.create": "Member created",
  "user.update": "Member updated",
  "user.delete": "Member removed",
  "user.password": "Password changed",
  "machine.links": "Machine access updated",
  "machine.remove": "Machine removed",
  "audit.export": "Audit log exported",
};

const AUDIT_ACTIONS = Object.keys(ACTION_LABEL);

function initials(user: Pick<TeamUser, "displayName" | "username">): string {
  const parts = user.displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return user.username.slice(0, 2).toUpperCase();
}

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/\./g, " ");
}

function statusTone(status: TeamStatus): "ok" | "err" {
  return status === "active" ? "ok" : "err";
}

export function TeamPanel({
  currentUser,
  onCurrentUserChange,
  onOpenHosts,
  onRefreshHosts,
  onToast,
}: {
  currentUser: TeamUser;
  onCurrentUserChange: (user: TeamUser) => void;
  onOpenHosts: () => void;
  onRefreshHosts: () => void;
  onToast: Toast;
}) {
  const [overview, setOverview] = useState<TeamOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TeamTab>(currentUser.role === "user" ? "machines" : "members");
  const [memberDialog, setMemberDialog] = useState<{ mode: "create" | "edit"; member?: TeamUser } | null>(null);
  const [adminMachine, setAdminMachine] = useState<TeamMachine | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<TeamAuditResult | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditFilter, setAuditFilter] = useState<TeamAuditFilter>({ targetType: "all", limit: 250 });

  const apply = useCallback(
    (next: TeamOverview) => {
      setOverview(next);
      const self = next.users.find((user) => user.id === currentUser.id);
      if (self) onCurrentUserChange(self);
    },
    [currentUser.id, onCurrentUserChange],
  );

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        apply(await bridge.team.overview());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [apply],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const isMember = currentUser.role === "user";
  const tabs = useMemo(
    () =>
      isMember
        ? [
            { id: "machines" as const, label: "My machines" },
            { id: "activity" as const, label: "My activity" },
            { id: "profile" as const, label: "Profile" },
          ]
        : [
            { id: "members" as const, label: "Members" },
            { id: "machines" as const, label: "Machines" },
            { id: "activity" as const, label: "Activity" },
            ...(currentUser.role === "admin" ? [{ id: "sync" as const, label: "Sync" }] : []),
            { id: "profile" as const, label: "My profile" },
          ],
    [currentUser.role, isMember],
  );

  useEffect(() => {
    if (!tabs.some((entry) => entry.id === tab)) setTab(tabs[0].id);
  }, [tab, tabs]);

  useEffect(() => {
    return bridge.onEvent((event) => {
      if (event.type === "team-sync") void load(true);
    });
  }, [load]);

  useEffect(() => {
    if (tab !== "activity") return;
    const timer = window.setTimeout(() => {
      setAuditLoading(true);
      void bridge.team
        .audit(auditFilter)
        .then(setAudit)
        .catch((err) => onToast("error", "Audit filter failed", err instanceof Error ? err.message : String(err)))
        .finally(() => setAuditLoading(false));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [auditFilter, onToast, tab]);

  const permissions = overview?.permissions;
  const canCreate = Boolean(permissions?.manageUsers);

  const removeMember = async (member: TeamUser) => {
    if (!permissions?.deleteUsers || member.id === currentUser.id) return;
    if (!window.confirm(`Delete ${member.displayName} (@${member.username})? Their machine links and sessions are removed.`)) return;
    setBusy(true);
    try {
      apply(await bridge.team.deleteUser(member.id));
      onToast("ok", "Member removed", `${member.displayName} no longer has access.`);
      onRefreshHosts();
    } catch (err) {
      onToast("error", "Could not remove member", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="team">
      <section className="team-summary" aria-label="Team workspace summary">
        <div className="team-summary-copy">
          <span className="eyebrow">TEAM WORKSPACE</span>
          <h2>{overview?.workspaceName ?? "Nexus Operations"}</h2>
          <p>
            Shared identities, roles and machine grants for this Nexus installation. Accounts are local to this
            computer and every action is recorded in the workspace database.
          </p>
          <div className="team-summary-tags">
            <Chip tone="ok" dot>
              {overview?.database ?? "SQLite"} directory
            </Chip>
            <Chip tone="info">
              <Icon name="lock" size={10} /> Local trust boundary
            </Chip>
            {overview ? <span className="mono subtle">{overview.counts.links} machine grants</span> : null}
          </div>
        </div>
        <div className="team-summary-identity">
          <span className="avatar large" style={{ background: currentUser.role === "admin" ? "#6d4dff" : undefined }}>
            {initials(currentUser)}
          </span>
          <div>
            <strong>{currentUser.displayName}</strong>
            <span className="mono">@{currentUser.username}</span>
            <div className="team-summary-role">
              <Chip tone={ROLE_TONE[currentUser.role]}>{ROLE_LABEL[currentUser.role]}</Chip>
              {currentUser.online ? <Chip tone="ok" dot>Online</Chip> : null}
            </div>
          </div>
          <button className="btn small ghost" onClick={() => setPasswordOpen(true)}>
            <Icon name="key" size={12} /> Password
          </button>
        </div>
      </section>

      {error ? (
        <div className="error-banner">
          <Icon name="alert" size={16} />
          <div>
            <strong>Team directory unavailable</strong>
            <span>{error}</span>
          </div>
          <button className="btn small ghost" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {loading && !overview ? (
        <div className="team-loading">
          <Skeleton height={118} />
          <Skeleton height={320} />
        </div>
      ) : overview ? (
        <>
          <div className="team-stat-strip">
            <StatTile
              label={isMember ? "My machines" : "Members"}
              value={isMember ? overview.counts.machines : overview.counts.members}
              hint={isMember ? "linked to your account" : `${overview.counts.admins} admin${overview.counts.admins === 1 ? "" : "s"} · ${overview.counts.moderators} mod${overview.counts.moderators === 1 ? "" : "s"}`}
              icon={isMember ? "server" : "users"}
              tone="cyan"
            />
            <StatTile
              label="Machines"
              value={overview.counts.machines}
              hint={`${overview.counts.links} explicit grants`}
              icon="terminal"
              tone="violet"
            />
            <StatTile label="Online now" value={overview.counts.online} hint="sessions active in the last 5 minutes" icon="activity" tone={overview.counts.online > 0 ? "green" : "amber"} />
            <StatTile label="Audit trail" value={overview.activity.length} hint="recent team events retained in SQLite" icon="database" tone="green" />
          </div>

          <div className="team-tabs" role="tablist" aria-label="Team sections">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                role="tab"
                aria-selected={tab === entry.id}
                className={cx("team-tab", tab === entry.id && "active")}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
            <span className="team-tabs-spacer" />
            {!isMember && canCreate ? (
              <button className="btn small primary" onClick={() => setMemberDialog({ mode: "create" })}>
                <Icon name="plus" size={12} /> Add member
              </button>
            ) : null}
            {!isMember ? (
              <button className="btn small ghost" onClick={onOpenHosts}>
                <Icon name="terminal" size={12} /> SSH inventory
              </button>
            ) : null}
          </div>

          {tab === "members" && !isMember ? (
            <Panel
              eyebrow="DIRECTORY"
              title="Members and roles"
              actions={<span className="mono subtle">{overview.users.length} accounts</span>}
              flush
            >
              <div className="team-table-wrap">
                <table className="team-table">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Machines</th>
                      <th>Last sign-in</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {overview.users.map((member) => {
                      const manageable = currentUser.role === "admin" || member.role === "user";
                      return (
                        <tr key={member.id} className={cx(member.id === currentUser.id && "is-self")}>
                          <td>
                            <div className="team-member">
                              <span className="avatar">{initials(member)}</span>
                              <div>
                                <strong>{member.displayName}</strong>
                                <span className="mono">
                                  @{member.username}
                                  {member.id === currentUser.id ? " · you" : ""}
                                </span>
                              </div>
                              {member.online ? <span className="team-online" title="Online now" /> : null}
                            </div>
                          </td>
                          <td>
                            <Chip tone={ROLE_TONE[member.role]}>{ROLE_LABEL[member.role]}</Chip>
                          </td>
                          <td>
                            <Chip tone={statusTone(member.status)} dot>
                              {member.status}
                            </Chip>
                          </td>
                          <td>
                            <span className="mono table-count">{member.linkedMachines}</span>
                          </td>
                          <td>
                            <span className="subtle small">{member.lastLoginAt ? ago(member.lastLoginAt) : "never"}</span>
                          </td>
                          <td>
                            <div className="table-actions">
                              <button
                                className="btn small ghost"
                                onClick={() => setMemberDialog({ mode: "edit", member })}
                                disabled={!manageable || busy}
                              >
                                Edit
                              </button>
                              {permissions?.deleteUsers ? (
                                <button
                                  className="btn icon ghost danger"
                                  onClick={() => void removeMember(member)}
                                  title={`Delete ${member.displayName}`}
                                  disabled={member.id === currentUser.id || busy}
                                >
                                  <Icon name="trash" size={12} />
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {currentUser.role === "moderator" ? (
                <p className="team-table-note">
                  Moderators can add and manage standard members, reset their passwords and grant machine access.
                  Admin and moderator roles are controlled by an admin.
                </p>
              ) : null}
            </Panel>
          ) : null}

          {tab === "machines" ? (
            <Panel
              eyebrow="ACCESS MATRIX"
              title={isMember ? "Machines linked to you" : "SSH machine grants"}
              actions={
                <div className="inline-actions">
                  <span className="mono subtle">{overview.counts.links} grants</span>
                  {!isMember ? (
                    <button className="btn small ghost" onClick={onOpenHosts}>
                      <Icon name="terminal" size={12} /> Open inventory
                    </button>
                  ) : null}
                </div>
              }
              flush
            >
              {overview.machines.length === 0 ? (
                <div className="team-empty">
                  <span className="hero-glyph">
                    <Icon name="link" size={22} />
                  </span>
                  <div>
                    <strong>{isMember ? "No machines linked yet" : "No SSH machines yet"}</strong>
                    <p>
                      {isMember
                        ? "Ask an admin to link a machine to your account. Linked machines appear here and in Linux hosts."
                        : "Add an SSH host in the inventory, then link members to it here."}
                    </p>
                    {!isMember ? (
                      <button className="btn small primary" onClick={onOpenHosts}>
                        <Icon name="plus" size={12} /> Add an SSH host
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="team-table-wrap">
                  <table className="team-table machines-table">
                    <thead>
                      <tr>
                        <th>Machine</th>
                        <th>Endpoint</th>
                        <th>Linked members</th>
                        <th>Updated</th>
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {overview.machines.map((machine) => (
                        <tr key={machine.id}>
                          <td>
                            <div className="team-machine">
                              <span className="machine-mark" style={{ background: machine.color }} />
                              <div>
                                <strong>{machine.label}</strong>
                                <span className="mono">{machine.id}</span>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="mono subtle">
                              {machine.username}@{machine.host}:{machine.port}
                            </span>
                          </td>
                          <td>
                            <div className="team-link-chips">
                              {machine.linkedUsers.length === 0 ? (
                                <span className="subtle small">Unlinked</span>
                              ) : (
                                machine.linkedUsers.slice(0, 4).map((user) => (
                                  <span className="team-link-chip" key={user.id} title={`${user.displayName} · ${ROLE_LABEL[user.role]}`}>
                                    {initials(user)}
                                  </span>
                                ))
                              )}
                              {machine.linkedUsers.length > 4 ? (
                                <span className="team-link-chip more">+{machine.linkedUsers.length - 4}</span>
                              ) : null}
                            </div>
                          </td>
                          <td>
                            <span className="subtle small">{ago(machine.updatedAt)}</span>
                          </td>
                          <td>
                            <div className="table-actions">
                              {!isMember ? (
                                <button
                                  className="btn small ghost"
                                  onClick={() => setAdminMachine(machine)}
                                  disabled={!permissions?.manageMachines || busy}
                                >
                                  <Icon name="server" size={12} /> Administer
                                </button>
                              ) : (
                                <button className="btn small ghost" onClick={onOpenHosts}>
                                  <Icon name="terminal" size={12} /> Use machine
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!isMember ? (
                <p className="team-table-note">
                  Admin and moderator accounts can see every machine. Standard members only see machines explicitly
                  linked here; the same rule is enforced for SSH, VNC and host actions in the main process.
                </p>
              ) : null}
            </Panel>
          ) : null}

          {tab === "activity" ? (
            <Panel
              eyebrow="AUDIT TRAIL"
              title={isMember ? "Your activity" : "Workspace activity"}
              actions={
                <div className="inline-actions">
                  <Chip tone="ok" dot>
                    {audit?.total ?? overview.activity.length} retained
                  </Chip>
                  <button
                    className="btn small ghost"
                    onClick={() => {
                      void bridge.team
                        .exportAudit(auditFilter)
                        .then((result) => {
                          if (result.count === 0) {
                            onToast("info", "Audit export canceled");
                            return;
                          }
                          onToast("ok", "Audit log exported", `${result.count} events · ${result.filename}`);
                          void load(true);
                        })
                        .catch((err) => onToast("error", "Audit export failed", err instanceof Error ? err.message : String(err)));
                    }}
                    disabled={auditLoading}
                  >
                    <Icon name="download" size={12} /> Export CSV
                  </button>
                </div>
              }
              flush
            >
              <div className="audit-tools">
                <label className="field audit-query">
                  <span>Search events</span>
                  <input
                    value={auditFilter.query ?? ""}
                    onChange={(event) => setAuditFilter((current) => ({ ...current, query: event.target.value, limit: 250 }))}
                    placeholder="member, machine, detail…"
                  />
                </label>
                {!isMember ? (
                  <label className="field">
                    <span>Actor</span>
                    <select
                      value={auditFilter.actorId ?? ""}
                      onChange={(event) => setAuditFilter((current) => ({ ...current, actorId: event.target.value || undefined, limit: 250 }))}
                    >
                      <option value="">Anyone</option>
                      {overview.users.map((member) => (
                        <option value={member.id} key={member.id}>
                          {member.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="field">
                  <span>Target</span>
                  <select
                    value={auditFilter.targetType ?? "all"}
                    onChange={(event) =>
                      setAuditFilter((current) => ({
                        ...current,
                        targetType: event.target.value as TeamAuditFilter["targetType"],
                        limit: 250,
                      }))
                    }
                  >
                    <option value="all">All targets</option>
                    <option value="user">Members</option>
                    <option value="machine">Machines</option>
                    <option value="session">Sessions</option>
                    <option value="workspace">Workspace</option>
                  </select>
                </label>
                <label className="field">
                  <span>Action</span>
                  <select
                    value={auditFilter.action ?? ""}
                    onChange={(event) => setAuditFilter((current) => ({ ...current, action: event.target.value || undefined, limit: 250 }))}
                  >
                    <option value="">All actions</option>
                    {AUDIT_ACTIONS.map((action) => (
                      <option value={action} key={action}>
                        {actionLabel(action)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>From</span>
                  <input
                    type="date"
                    value={auditFilter.from ? new Date(auditFilter.from).toISOString().slice(0, 10) : ""}
                    onChange={(event) =>
                      setAuditFilter((current) => ({
                        ...current,
                        from: event.target.value ? new Date(`${event.target.value}T00:00:00`).getTime() : undefined,
                        limit: 250,
                      }))
                    }
                  />
                </label>
                <label className="field">
                  <span>To</span>
                  <input
                    type="date"
                    value={auditFilter.to ? new Date(auditFilter.to).toISOString().slice(0, 10) : ""}
                    onChange={(event) =>
                      setAuditFilter((current) => ({
                        ...current,
                        to: event.target.value ? new Date(`${event.target.value}T23:59:59.999`).getTime() : undefined,
                        limit: 250,
                      }))
                    }
                  />
                </label>
                <button
                  className="btn small ghost audit-clear"
                  onClick={() => setAuditFilter({ targetType: "all", limit: 250 })}
                  disabled={auditLoading}
                >
                  Clear
                </button>
              </div>
              {auditLoading ? (
                <div className="audit-loading"><Skeleton height={54} /><Skeleton height={54} /><Skeleton height={54} /></div>
              ) : (audit?.entries.length ?? 0) === 0 ? (
                <div className="team-empty compact">
                  <Icon name="activity" size={20} />
                  <p>{auditFilter.query || auditFilter.action || auditFilter.actorId || auditFilter.from || auditFilter.to ? "No events match those filters." : "No team activity recorded yet."}</p>
                </div>
              ) : (
                <div className="team-activity">
                  {(audit?.entries ?? []).map((entry) => (
                    <article className="team-activity-row" key={entry.id}>
                      <span className={cx("activity-mark", entry.targetType)}>
                        <Icon
                          name={
                            entry.targetType === "machine"
                              ? "server"
                              : entry.targetType === "session"
                                ? "lock"
                                : entry.targetType === "workspace"
                                  ? "grid"
                                  : "user"
                          }
                          size={12}
                        />
                      </span>
                      <div className="team-activity-main">
                        <strong>{actionLabel(entry.action)}</strong>
                        <span className="subtle small">
                          {entry.actorName}
                          {entry.targetName && entry.targetName !== entry.actorName ? ` → ${entry.targetName}` : ""}
                        </span>
                      </div>
                      {entry.detail ? <span className="team-activity-detail">{entry.detail}</span> : null}
                      <span className="mono subtle team-activity-time" title={dateTime(entry.at)}>
                        {ago(entry.at)}
                      </span>
                    </article>
                  ))}
                </div>
              )}
            </Panel>
          ) : null}

          {tab === "sync" && !isMember ? (
            <SyncPanel onToast={onToast} onRefreshed={() => void load(true)} />
          ) : null}

          {tab === "profile" ? (
            <div className="team-profile-grid">
              <Panel eyebrow="YOUR ACCOUNT" title="Profile">
                <div className="profile-head">
                  <span className="avatar xl">{initials(currentUser)}</span>
                  <div>
                    <h3>{currentUser.displayName}</h3>
                    <span className="mono subtle">@{currentUser.username}</span>
                    <div className="team-summary-role">
                      <Chip tone={ROLE_TONE[currentUser.role]}>{ROLE_LABEL[currentUser.role]}</Chip>
                      <Chip tone={statusTone(currentUser.status)} dot>
                        {currentUser.status}
                      </Chip>
                    </div>
                  </div>
                </div>
                <div className="profile-facts">
                  <div>
                    <span>Created</span>
                    <strong>{dateTime(currentUser.createdAt)}</strong>
                  </div>
                  <div>
                    <span>Last sign-in</span>
                    <strong>{currentUser.lastLoginAt ? ago(currentUser.lastLoginAt) : "never"}</strong>
                  </div>
                  <div>
                    <span>Linked machines</span>
                    <strong>{currentUser.linkedMachines}</strong>
                  </div>
                  <div>
                    <span>Workspace role</span>
                    <strong>{ROLE_LABEL[currentUser.role]}</strong>
                  </div>
                </div>
                <div className="profile-actions">
                  <button className="btn primary" onClick={() => setPasswordOpen(true)}>
                    <Icon name="key" size={13} /> Change password
                  </button>
                  {isMember ? (
                    <button className="btn ghost" onClick={onOpenHosts}>
                      <Icon name="terminal" size={13} /> Open linked machines
                    </button>
                  ) : null}
                </div>
              </Panel>

              <Panel eyebrow="ACCESS" title={isMember ? "Your machine grants" : "Role capabilities"}>
                {isMember ? (
                  <div className="profile-machine-list">
                    {overview.machines.length === 0 ? (
                      <p className="subtle small">No machine grants yet.</p>
                    ) : (
                      overview.machines.map((machine) => (
                        <div className="profile-machine" key={machine.id}>
                          <span className="machine-mark" style={{ background: machine.color }} />
                          <div>
                            <strong>{machine.label}</strong>
                            <span className="mono">
                              {machine.username}@{machine.host}:{machine.port}
                            </span>
                          </div>
                          <Chip tone="ok">linked</Chip>
                        </div>
                      ))
                    )}
                  </div>
                ) : (
                  <div className="role-capabilities">
                    <div>
                      <strong>Admin</strong>
                      <p>Full workspace control: accounts, roles, machine grants, inventory and every operational panel.</p>
                    </div>
                    <div>
                      <strong>Moderator</strong>
                      <p>Operational access plus standard-member management and machine grants. Cannot alter admins or other moderators.</p>
                    </div>
                    <div>
                      <strong>Member</strong>
                      <p>Signs in to the workspace and can use only the SSH machines linked to their account.</p>
                    </div>
                  </div>
                )}
              </Panel>
            </div>
          ) : null}
        </>
      ) : null}

      {memberDialog ? (
        <MemberDialog
          key={`${memberDialog.mode}-${memberDialog.member?.id ?? "new"}`}
          mode={memberDialog.mode}
          member={memberDialog.member}
          currentUser={currentUser}
          onClose={() => setMemberDialog(null)}
          onSaved={(next) => {
            apply(next);
            onRefreshHosts();
          }}
          onToast={onToast}
        />
      ) : null}

      {adminMachine && overview ? (
        <ServerDrawer
          key={adminMachine.id}
          machine={adminMachine}
          users={overview.users}
          currentUser={currentUser}
          onClose={() => setAdminMachine(null)}
          onSaved={(next) => {
            apply(next);
            onRefreshHosts();
          }}
          onToast={onToast}
        />
      ) : null}

      {passwordOpen ? <PasswordDialog onClose={() => setPasswordOpen(false)} onToast={onToast} /> : null}
    </div>
  );
}

function MemberDialog({
  mode,
  member,
  currentUser,
  onClose,
  onSaved,
  onToast,
}: {
  mode: "create" | "edit";
  member?: TeamUser;
  currentUser: TeamUser;
  onClose: () => void;
  onSaved: (overview: TeamOverview) => void;
  onToast: Toast;
}) {
  const roleOptions: TeamRole[] = currentUser.role === "admin" ? ["admin", "moderator", "user"] : ["user"];
  const [username, setUsername] = useState(member?.username ?? "");
  const [displayName, setDisplayName] = useState(member?.displayName ?? "");
  const [role, setRole] = useState<TeamRole>(member?.role ?? "user");
  const [status, setStatus] = useState<TeamStatus>(member?.status ?? "active");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editingSelf = member?.id === currentUser.id;

  const submit = async () => {
    setError(null);
    if (displayName.trim().length < 2) {
      setError("Enter a display name.");
      return;
    }
    if (password && password !== confirm) {
      setError("The passwords do not match.");
      return;
    }
    if (mode === "create" && !password) {
      setError("Set a password for the new member.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "create") {
        const input: TeamUserInput = { username, displayName, role, password };
        const next = await bridge.team.createUser(input);
        onSaved(next);
        onToast("ok", "Member added", `${displayName.trim()} can now sign in.`);
      } else if (member) {
        const patch: TeamUserPatch = { displayName, status };
        if (currentUser.role === "admin") patch.role = role;
        if (password) patch.password = password;
        const next = await bridge.team.updateUser(member.id, patch);
        onSaved(next);
        onToast("ok", "Member updated", `${displayName.trim()} · ${ROLE_LABEL[role]}`);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={mode === "create" ? "Add a workspace member" : `Edit ${member?.displayName ?? "member"}`}
      subtitle={mode === "create" ? "Accounts are stored in the local SQLite team directory." : "Role and machine access changes are audit-logged."}
      onClose={onClose}
      width={580}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving…" : mode === "create" ? "Create member" : "Save changes"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span>Username</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="jordan"
            autoComplete="off"
            disabled={mode === "edit" || busy}
          />
        </label>
        <label className="field">
          <span>Display name</span>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Jordan Rivera"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <label className="field">
          <span>Role</span>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as TeamRole)}
            disabled={busy || roleOptions.length === 1 || editingSelf}
          >
            {roleOptions.map((entry) => (
              <option key={entry} value={entry}>
                {ROLE_LABEL[entry]}
              </option>
            ))}
          </select>
          {currentUser.role === "moderator" ? <em className="hint">Moderators can only manage standard members.</em> : null}
        </label>
        <label className="field">
          <span>Status</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as TeamStatus)}
            disabled={busy || editingSelf || mode === "create"}
          >
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </label>
        <label className="field wide">
          <span>{mode === "create" ? "Initial password" : "Reset password · optional"}</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={mode === "create" ? "At least 8 characters" : "Leave blank to keep the current password"}
            autoComplete="new-password"
            disabled={busy}
          />
        </label>
        {password ? (
          <label className="field wide">
            <span>Confirm password</span>
            <input
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
              disabled={busy}
            />
          </label>
        ) : null}
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      {mode === "edit" ? (
        <p className="hint">
          Suspending an account invalidates its sessions immediately. The last active admin cannot be suspended or
          demoted.
        </p>
      ) : null}
    </Modal>
  );
}

type ServerDraft = {
  label: string;
  host: string;
  port: number;
  username: string;
  authMode: SshAuthMode;
  keyPath: string;
  password: string;
  color: string;
};

function ServerDrawer({
  machine,
  users,
  currentUser,
  onClose,
  onSaved,
  onToast,
}: {
  machine: TeamMachine;
  users: TeamUser[];
  currentUser: TeamUser;
  onClose: () => void;
  onSaved: (overview: TeamOverview) => void;
  onToast: Toast;
}) {
  const canToggle = (user: TeamUser) => currentUser.role === "admin" || user.role === "user";
  const [host, setHost] = useState<SshHostSummary | null>(null);
  const [form, setForm] = useState<ServerDraft | null>(null);
  const [selected, setSelected] = useState<string[]>(machine.linkedUserIds);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void bridge.ssh
      .hosts()
      .then((list) => {
        if (!live) return;
        const found = list.find((entry) => entry.id === machine.id) ?? null;
        setHost(found);
        setForm({
          label: found?.label ?? machine.label,
          host: found?.host ?? machine.host,
          port: found?.port ?? machine.port,
          username: found?.username ?? machine.username,
          authMode: found?.authMode ?? "key",
          keyPath: found?.keyPath ?? "",
          password: "",
          color: found?.color ?? machine.color,
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [machine]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const patch = (next: Partial<ServerDraft>) => setForm((current) => (current ? { ...current, ...next } : current));
  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  const save = async () => {
    setError(null);
    if (form && host) {
      if (!form.label.trim() || !form.host.trim() || !form.username.trim()) {
        setError("Display name, host and username are required.");
        return;
      }
      if (form.port < 1 || form.port > 65535) {
        setError("SSH port must be between 1 and 65535.");
        return;
      }
    }
    setBusy(true);
    try {
      if (form && host) {
        const input: SshHostInput = {
          id: host.id,
          label: form.label,
          host: form.host,
          port: form.port,
          username: form.username,
          authMode: form.authMode,
          keyPath: form.authMode === "key" ? form.keyPath : undefined,
          password: form.password || undefined,
          color: form.color,
        };
        await bridge.ssh.save(input);
      }
      const next = await bridge.team.setMachineLinks(machine.id, selected);
      onSaved(next);
      onToast(
        "ok",
        host ? "Server administered" : "Machine access updated",
        host
          ? `${form?.label ?? machine.label} · ${selected.length} explicit grant${selected.length === 1 ? "" : "s"}`
          : `${machine.label} · endpoint is configured on another device`,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!host) return;
    if (!window.confirm(`Remove ${machine.label} from this computer's SSH inventory and all workspace grants?`)) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.ssh.remove(host.id);
      onSaved(await bridge.team.overview());
      onToast("ok", "Server removed", `${machine.label} is no longer in this workspace.`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <aside className="drawer team-server-drawer" role="dialog" aria-modal="true" aria-label={`Administer ${machine.label}`}>
        <header className="drawer-head">
          <div className="drawer-title">
            <span className="server-drawer-mark" style={{ borderColor: form?.color ?? machine.color, color: form?.color ?? machine.color }}>
              <Icon name="server" size={17} />
            </span>
            <div>
              <h2>{form?.label || machine.label}</h2>
              <p>
                {machine.source === "remote" ? "REMOTE WORKSPACE MACHINE" : "SSH ENDPOINT + ACCESS"}
              </p>
            </div>
          </div>
          <div className="drawer-head-actions">
            <Chip tone={machine.source === "remote" ? "muted" : "ok"} dot>
              {machine.source === "remote" ? "remote" : "local"}
            </Chip>
            <button className="btn icon ghost" onClick={onClose} disabled={busy} aria-label="Close server administration">
              <Icon name="close" size={13} />
            </button>
          </div>
        </header>

        <div className="drawer-scroll">
          {loading ? (
            <div className="server-drawer-loading">
              <Skeleton height={62} />
              <Skeleton height={250} />
            </div>
          ) : form ? (
            <>
              <div className="server-drawer-identity">
                <div>
                  <span className="mono">{machine.username}@{machine.host}:{machine.port}</span>
                  <strong>{form.label}</strong>
                </div>
                <span className="server-drawer-id mono">{machine.id}</span>
              </div>

              <section className="drawer-section">
                <div className="section-title">
                  <h3>SSH endpoint</h3>
                  <span className="mono subtle">{host ? "editable on this computer" : "configured elsewhere"}</span>
                </div>
                {host ? (
                  <div className="form-grid">
                    <label className="field">
                      <span>Display name</span>
                      <input value={form.label} onChange={(event) => patch({ label: event.target.value })} disabled={busy} />
                    </label>
                    <label className="field">
                      <span>Host or IP</span>
                      <input value={form.host} onChange={(event) => patch({ host: event.target.value })} disabled={busy} spellCheck={false} />
                    </label>
                    <label className="field">
                      <span>SSH username</span>
                      <input value={form.username} onChange={(event) => patch({ username: event.target.value })} disabled={busy} spellCheck={false} />
                    </label>
                    <label className="field">
                      <span>Port</span>
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        value={form.port}
                        onChange={(event) => patch({ port: Number(event.target.value) || 22 })}
                        disabled={busy}
                      />
                    </label>
                    <label className="field">
                      <span>Marker color</span>
                      <input type="color" value={form.color} onChange={(event) => patch({ color: event.target.value })} disabled={busy} />
                    </label>
                    <label className="field wide">
                      <span>Authentication</span>
                      <div className="segmented">
                        <button
                          type="button"
                          className={cx("seg", form.authMode === "key" && "active")}
                          onClick={() => patch({ authMode: "key" })}
                          disabled={busy}
                        >
                          Private key / agent
                        </button>
                        <button
                          type="button"
                          className={cx("seg", form.authMode === "password" && "active")}
                          onClick={() => patch({ authMode: "password" })}
                          disabled={busy}
                        >
                          Password
                        </button>
                      </div>
                    </label>
                    {form.authMode === "key" ? (
                      <label className="field wide">
                        <span>Private key path</span>
                        <input
                          value={form.keyPath}
                          onChange={(event) => patch({ keyPath: event.target.value })}
                          placeholder="~/.ssh/id_ed25519"
                          disabled={busy}
                        />
                        <em className="hint">Blank uses ssh-agent and default keys. The key stays on this computer.</em>
                      </label>
                    ) : (
                      <label className="field wide">
                        <span>Password</span>
                        <input
                          type="password"
                          value={form.password}
                          onChange={(event) => patch({ password: event.target.value })}
                          placeholder={host.hasSecret ? "Leave blank to keep the stored password" : "Required for password auth"}
                          autoComplete="new-password"
                          disabled={busy}
                        />
                        <em className="hint">The password is encrypted in this computer's local vault and never synced.</em>
                      </label>
                    )}
                  </div>
                ) : (
                  <div className="server-remote-note">
                    <Icon name="plug" size={16} />
                    <div>
                      <strong>This endpoint is registered from another computer.</strong>
                      <p>
                        Add the same SSH host in this computer's inventory to administer the connection. Access grants
                        can still be managed here.
                      </p>
                      <button className="btn small ghost" onClick={() => onToast("info", "Open SSH inventory", "Use Connections → Linux hosts to add this endpoint locally.")}>
                        How to make it local
                      </button>
                    </div>
                  </div>
                )}
              </section>

              <section className="drawer-section">
                <div className="section-title">
                  <h3>Machine access</h3>
                  <span className="mono subtle">{selected.length} explicit grant{selected.length === 1 ? "" : "s"}</span>
                </div>
                <p className="hint server-access-lede">
                  Admins and moderators already have implicit access. Standard members need an explicit grant; the
                  main process checks it again for SSH, VNC and host actions.
                </p>
                <div className="member-picker">
                  {users.map((user) => (
                    <label key={user.id} className={cx("member-pick", selected.includes(user.id) && "checked")}>
                      <input
                        type="checkbox"
                        checked={selected.includes(user.id)}
                        onChange={() => toggle(user.id)}
                        disabled={busy || !canToggle(user)}
                      />
                      <span className="avatar small">{initials(user)}</span>
                      <span className="member-pick-copy">
                        <strong>{user.displayName}</strong>
                        <span className="mono">
                          @{user.username} · {ROLE_LABEL[user.role]}
                        </span>
                      </span>
                      {user.online ? <span className="team-online" title="Online now" /> : null}
                    </label>
                  ))}
                  {users.length === 0 ? <p className="subtle small">No members on this workspace yet.</p> : null}
                </div>
              </section>
              {error ? <p className="form-error">{error}</p> : null}
            </>
          ) : (
            <div className="team-empty compact">
              <Icon name="alert" size={20} />
              <p>{error ?? "This server is no longer available."}</p>
            </div>
          )}
        </div>

        <footer className="team-server-footer">
          {host ? (
            <button className="btn small ghost danger" onClick={() => void remove()} disabled={busy}>
              <Icon name="trash" size={12} /> Remove server
            </button>
          ) : (
            <span />
          )}
          <div className="inline-actions">
            <button className="btn ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void save()} disabled={busy || loading || !form}>
              {busy ? "Saving…" : host ? "Save endpoint & access" : "Save access"}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

function SyncPanel({ onToast, onRefreshed }: { onToast: Toast; onRefreshed: () => void }) {
  const [status, setStatus] = useState<TeamSyncStatus | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [workspace, setWorkspace] = useState("default");
  const [deviceName, setDeviceName] = useState("Nexus desktop");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback((next: TeamSyncStatus) => {
    setStatus(next);
    if (next.endpoint) setEndpoint(next.endpoint);
    setWorkspace(next.workspace);
    setDeviceName(next.deviceName);
    setError(next.error ?? null);
  }, []);

  useEffect(() => {
    void bridge.teamSync.status().then(applyStatus).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [applyStatus]);

  const connect = async () => {
    setBusy("connect");
    setError(null);
    try {
      const result = await bridge.teamSync.configure({ endpoint, workspace, deviceName, token });
      applyStatus(result.status);
      setToken("");
      onToast("ok", "Team sync connected", `${result.status.workspace} · revision ${result.status.revision}`);
      onRefreshed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy("sync");
    try {
      const result = await bridge.teamSync.now();
      applyStatus(result.status);
      onToast("ok", "Workspace synced", `${result.status.counts.users} accounts · ${result.status.counts.machines} machines`);
      onRefreshed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      onToast("error", "Sync failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const disable = async () => {
    if (!window.confirm("Disconnect this computer from the team sync relay? Local team data stays here.")) return;
    setBusy("disable");
    try {
      applyStatus(await bridge.teamSync.disable());
      setToken("");
      onToast("info", "Team sync disconnected", "Local accounts remain available on this computer.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const tone = status?.phase === "online" ? "ok" : status?.phase === "error" ? "err" : "muted";

  return (
    <Panel
      eyebrow="CROSS-DEVICE"
      title="Team sync relay"
      actions={<Chip tone={tone} dot>{status?.phase ?? "loading"}</Chip>}
    >
      <div className="sync-layout">
        <div className="sync-copy">
          <p>
            Connect this Nexus station to a self-hosted TLS relay so members, roles, machine grants and audit events
            are the same on every computer. SSH keys, passwords and endpoint secrets stay local.
          </p>
          <div className="sync-facts">
            <div><span>Workspace</span><strong>{status?.workspace ?? "default"}</strong></div>
            <div><span>Revision</span><strong className="mono">{status?.revision ?? 0}</strong></div>
            <div><span>Accounts</span><strong>{status?.counts.users ?? 0}</strong></div>
            <div><span>Last sync</span><strong>{status?.lastSyncAt ? ago(status.lastSyncAt) : "never"}</strong></div>
          </div>
        </div>
        <div className="sync-form">
          <label className="field wide">
            <span>Relay URL</span>
            <input
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://sync.example.com"
              spellCheck={false}
              disabled={busy !== null}
            />
          </label>
          <div className="form-grid">
            <label className="field">
              <span>Workspace</span>
              <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} disabled={busy !== null} />
            </label>
            <label className="field">
              <span>Device label</span>
              <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} disabled={busy !== null} />
            </label>
            <label className="field wide">
              <span>Workspace token</span>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={status?.tokenSet ? "Enter the token to reconnect or rotate" : "At least 16 characters"}
                autoComplete="off"
                disabled={busy !== null}
              />
              <em className="hint">Stored only on this computer, mode 0600. Never sent to renderer after entry.</em>
            </label>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="form-actions sync-actions">
            {status?.enabled ? (
              <button className="btn small ghost danger" onClick={() => void disable()} disabled={busy !== null}>
                Disconnect
              </button>
            ) : <span />}
            <button className="btn small ghost" onClick={() => void sync()} disabled={busy !== null || !status?.enabled}>
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </button>
            <button className="btn small primary" onClick={() => void connect()} disabled={busy !== null || !endpoint.trim() || !token.trim()}>
              {busy === "connect" ? "Connecting…" : status?.enabled ? "Reconnect & sync" : "Connect workspace"}
            </button>
          </div>
        </div>
      </div>
      <p className="hint">
        The relay stores password hashes because members must be able to sign in on another computer. Protect the
        relay data file and TLS key; plain HTTP is accepted only for loopback testing. Hosted endpoints must use HTTPS.
      </p>
    </Panel>
  );
}

function PasswordDialog({ onClose, onToast }: { onClose: () => void; onToast: Toast }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (next.length < 8) {
      setError("The new password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bridge.auth.changePassword(current, next);
      onToast("ok", "Password changed", "Your current session stays signed in.");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Change your password"
      subtitle="Passwords are salted and hashed with scrypt before being stored."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Update password"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field wide">
          <span>Current password</span>
          <input type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" disabled={busy} />
        </label>
        <label className="field">
          <span>New password</span>
          <input type="password" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" disabled={busy} />
        </label>
        <label className="field">
          <span>Confirm new password</span>
          <input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" disabled={busy} />
        </label>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </Modal>
  );
}
