import { useState } from "react";
import type { TeamBootstrapInput, TeamLoginInput, TeamUser } from "../../shared/team-types";
import type { TeamSyncPreview } from "../../shared/team-sync";
import { bridge } from "../lib/bridge";
import { Backdrop } from "./Backdrop";
import { Icon } from "./Icon";

export function AuthScreen({
  initialized,
  onAuthenticated,
  onWorkspaceChanged,
  reduced,
}: {
  initialized: boolean;
  onAuthenticated: (user: TeamUser) => void;
  onWorkspaceChanged: () => void;
  reduced: boolean;
}) {
  const [entry, setEntry] = useState<"create" | "join">("create");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joinEndpoint, setJoinEndpoint] = useState("");
  const [joinWorkspace, setJoinWorkspace] = useState("default");
  const [joinToken, setJoinToken] = useState("");
  const [joinPreview, setJoinPreview] = useState<TeamSyncPreview | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinNotice, setJoinNotice] = useState<string | null>(() => {
    try {
      const notice = sessionStorage.getItem("nexus.authNotice");
      if (notice) sessionStorage.removeItem("nexus.authNotice");
      return notice;
    } catch {
      return null;
    }
  });
  const [joinBusy, setJoinBusy] = useState(false);

  const setup = !initialized;
  const joining = setup && entry === "join";

  const switchEntry = (next: "create" | "join") => {
    setEntry(next);
    setError(null);
    setJoinError(null);
    setJoinPreview(null);
  };

  const submit = async () => {
    setError(null);
    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }
    if (setup) {
      if (displayName.trim().length < 2) {
        setError("Enter the name you want the team to see.");
        return;
      }
      if (password.length < 8) {
        setError("The owner password must be at least 8 characters.");
        return;
      }
      if (password !== confirm) {
        setError("The passwords do not match.");
        return;
      }
    }
    setBusy(true);
    try {
      if (setup) {
        const input: TeamBootstrapInput = { username, displayName, password };
        onAuthenticated(await bridge.auth.bootstrap(input));
      } else {
        const input: TeamLoginInput = { username, password };
        onAuthenticated(await bridge.auth.login(input));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const findWorkspace = async () => {
    setJoinError(null);
    setJoinNotice(null);
    if (!joinEndpoint.trim() || !joinToken.trim()) {
      setJoinError("Enter the relay URL and workspace token.");
      return;
    }
    setJoinBusy(true);
    try {
      const preview = await bridge.teamSync.preview({
        endpoint: joinEndpoint.trim(),
        workspace: joinWorkspace.trim() || "default",
        token: joinToken.trim(),
        deviceName: "Nexus desktop",
      });
      if (preview.users.length === 0) {
        setJoinPreview(null);
        setJoinError(
          "This relay has no team workspace yet. Ask the workspace owner to connect their Nexus station first, or create a new workspace on this computer.",
        );
        return;
      }
      setJoinPreview(preview);
      setJoinWorkspace(preview.workspace);
    } catch (err) {
      setJoinPreview(null);
      setJoinError(err instanceof Error ? err.message : String(err));
    } finally {
      setJoinBusy(false);
    }
  };

  const joinTeam = async () => {
    if (!joinPreview) return;
    setJoinError(null);
    setJoinBusy(true);
    try {
      const result = await bridge.teamSync.join({
        endpoint: joinEndpoint.trim(),
        workspace: joinWorkspace.trim() || "default",
        token: joinToken.trim(),
        deviceName: "Nexus desktop",
      });
      setJoinToken("");
      setJoinPreview(null);
      setJoinNotice(
        `Connected to ${result.status.workspace}. Sign in with the account your workspace admin created for you.`,
      );
      onWorkspaceChanged();
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : String(err));
    } finally {
      setJoinBusy(false);
    }
  };

  return (
    <div className="app auth-app">
      <Backdrop reduced={reduced} />
      <header className="auth-bar">
        <div className="brand">
          <span className="brand-mark live">
            <i />
            <i />
            <i />
          </span>
          <div className="brand-text">
            <strong>
              NEXUS<span>PVE</span>
            </strong>
            <em>TEAM OPERATIONS</em>
          </div>
        </div>
        <span className="auth-bar-state">
          <i className="status-dot connecting" />
          {joining ? "JOIN A TEAM WORKSPACE" : setup ? "WORKSPACE NOT INITIALIZED" : "SECURE LOCAL WORKSPACE"}
        </span>
        <div className="window-controls">
          <button className="win-btn" onClick={() => void bridge.app.window("minimize")} aria-label="Minimize">
            <Icon name="minimize" size={13} />
          </button>
          <button className="win-btn" onClick={() => void bridge.app.window("maximize")} aria-label="Maximize">
            <Icon name="maximize" size={11} />
          </button>
          <button className="win-btn danger" onClick={() => void bridge.app.window("close")} aria-label="Close">
            <Icon name="close" size={13} />
          </button>
        </div>
      </header>

      <main className="auth-main">
        <section className="auth-card" aria-labelledby="auth-title">
          <span className="auth-glyph">
            <Icon name={joining ? "link" : setup ? "users" : "lock"} size={24} />
          </span>
          <span className="eyebrow">{joining ? "TEAM INVITE" : setup ? "FIRST RUN" : "TEAM ACCESS"}</span>
          <h1 id="auth-title">
            {joining ? "Join your team's workspace." : setup ? "Create the workspace owner." : "Welcome back."}
          </h1>
          <p className="auth-lede">
            {joining
              ? "Enter the relay details your workspace admin shared. Nexus pulls the team directory, then you sign in with the account they created for you."
              : setup
                ? "Nexus needs one owner account before it can store members, roles and machine grants. The owner becomes the first Super admin."
                : "Sign in to the team workspace. Your role decides which machines and admin tools you can use."}
          </p>

          {setup ? (
            <div className="auth-mode" role="tablist" aria-label="Workspace setup">
              <button
                type="button"
                role="tab"
                aria-selected={entry === "create"}
                className={`auth-mode-tab${entry === "create" ? " active" : ""}`}
                onClick={() => switchEntry("create")}
                disabled={busy || joinBusy}
              >
                Create a new workspace
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={entry === "join"}
                className={`auth-mode-tab${entry === "join" ? " active" : ""}`}
                onClick={() => switchEntry("join")}
                disabled={busy || joinBusy}
              >
                Join an existing team
              </button>
            </div>
          ) : null}

          {joining ? (
            <div className="auth-join">
              <div className="auth-join-head">
                <strong>Cross-device team join</strong>
                <span className="mono">SELF-HOSTED TLS RELAY</span>
              </div>
              <p>
                Use the relay URL, workspace and token your admin set up. Joining pulls the team accounts and machine
                inventory first, so this computer never starts a separate workspace by mistake.
              </p>
              {joinPreview ? (
                <div className="auth-join-preview">
                  <div className="auth-join-preview-head">
                    <div>
                      <strong>{joinPreview.workspaceName}</strong>
                      <span className="mono">{joinPreview.workspace}</span>
                    </div>
                    <span className="mono">
                      {joinPreview.users.length} account{joinPreview.users.length === 1 ? "" : "s"} · {joinPreview.machines}{" "}
                      machine{joinPreview.machines === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="auth-join-users mono">
                    {joinPreview.users
                      .slice(0, 8)
                      .map((user) => `@${user.username}`)
                      .join(" · ")}
                    {joinPreview.users.length > 8 ? ` +${joinPreview.users.length - 8}` : ""}
                  </div>
                  <div className="auth-join-actions">
                    <button
                      className="btn small ghost"
                      type="button"
                      onClick={() => setJoinPreview(null)}
                      disabled={joinBusy}
                    >
                      Back
                    </button>
                    <button className="btn small primary" type="button" onClick={() => void joinTeam()} disabled={joinBusy}>
                      {joinBusy ? "Joining…" : "Join this workspace"}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="form-grid">
                    <label className="field wide">
                      <span>Relay URL</span>
                      <input
                        value={joinEndpoint}
                        onChange={(event) => setJoinEndpoint(event.target.value)}
                        placeholder="https://sync.example.com"
                        disabled={joinBusy}
                        spellCheck={false}
                      />
                    </label>
                    <label className="field">
                      <span>Workspace</span>
                      <input
                        value={joinWorkspace}
                        onChange={(event) => setJoinWorkspace(event.target.value)}
                        disabled={joinBusy}
                      />
                    </label>
                    <label className="field">
                      <span>Workspace token</span>
                      <input
                        type="password"
                        value={joinToken}
                        onChange={(event) => setJoinToken(event.target.value)}
                        placeholder="Shared at least 16 characters"
                        autoComplete="off"
                        disabled={joinBusy}
                      />
                    </label>
                  </div>
                  <div className="auth-join-actions">
                    <button
                      className="btn small ghost"
                      type="button"
                      onClick={() => switchEntry("create")}
                      disabled={joinBusy}
                    >
                      I am the owner
                    </button>
                    <button className="btn small primary" type="button" onClick={() => void findWorkspace()} disabled={joinBusy}>
                      {joinBusy ? "Looking up…" : "Find team workspace"}
                    </button>
                  </div>
                </>
              )}
              {joinError ? (
                <div className="auth-error">
                  <Icon name="alert" size={14} />
                  <span>{joinError}</span>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              {joinNotice ? (
                <div className="auth-notice" role="status">
                  <Icon name="check" size={14} />
                  <span>{joinNotice}</span>
                </div>
              ) : null}
              <form
                className="auth-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <label className="field">
                  <span>Username</span>
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder={setup ? "owner" : "your username"}
                    autoComplete="username"
                    autoFocus
                    disabled={busy}
                    spellCheck={false}
                  />
                </label>
                {setup ? (
                  <label className="field">
                    <span>Display name</span>
                    <input
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="Morgan Lee"
                      autoComplete="name"
                      disabled={busy}
                    />
                  </label>
                ) : null}
                <label className="field">
                  <span>{setup ? "Owner password" : "Password"}</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={setup ? "At least 8 characters" : "Your password"}
                    autoComplete={setup ? "new-password" : "current-password"}
                    disabled={busy}
                  />
                </label>
                {setup ? (
                  <label className="field">
                    <span>Confirm password</span>
                    <input
                      type="password"
                      value={confirm}
                      onChange={(event) => setConfirm(event.target.value)}
                      placeholder="Repeat the password"
                      autoComplete="new-password"
                      disabled={busy}
                    />
                  </label>
                ) : null}

                {error ? (
                  <div className="auth-error" role="alert">
                    <Icon name="alert" size={14} />
                    <span>{error}</span>
                  </div>
                ) : null}

                <button className="btn primary auth-submit" type="submit" disabled={busy}>
                  {busy ? (setup ? "Creating workspace…" : "Signing in…") : setup ? "Create workspace" : "Sign in"}
                  <Icon name={setup ? "chevron" : "logout"} size={14} />
                </button>
              </form>

              {setup ? (
                <p className="auth-footnote">
                  <Icon name="link" size={12} />
                  Invited by a team? Use <strong>Join an existing team</strong> above.
                </p>
              ) : (
                <p className="auth-footnote">
                  <Icon name="database" size={12} />
                  SQLite-backed team directory · passwords hashed with scrypt
                </p>
              )}
            </>
          )}
        </section>

        <aside className="auth-aside" aria-label="Workspace capabilities">
          <span className="eyebrow">WHAT THIS ADDS</span>
          <h2>A shared operating picture, without sharing credentials.</h2>
          <div className="auth-feature">
            <span className="auth-feature-icon">
              <Icon name="users" size={17} />
            </span>
            <div>
              <strong>Accounts and roles</strong>
              <p>Super admin, admin, moderator and member roles with server-side permission checks.</p>
            </div>
          </div>
          <div className="auth-feature">
            <span className="auth-feature-icon violet">
              <Icon name="link" size={17} />
            </span>
            <div>
              <strong>Machine linking</strong>
              <p>Grant individual members access to the SSH machines they actually need.</p>
            </div>
          </div>
          <div className="auth-feature">
            <span className="auth-feature-icon green">
              <Icon name="database" size={17} />
            </span>
            <div>
              <strong>Remembered locally</strong>
              <p>Users, sessions, links and audit events persist in the workspace database and sync through your relay.</p>
            </div>
          </div>
          <p className="auth-aside-note">
            A new computer must join the team relay once; the relay carries accounts and machine grants. SSH keys and
            passwords stay on the computer where they were entered.
          </p>
        </aside>
      </main>

      <footer className="auth-footer">
        <span className="mono">NEXUS PVE · TEAM ACCESS</span>
        <span className="mono">{joining ? "TEAM RELAY · ACCOUNTS PULLED FIRST" : "LOCAL SQLITE · OPTIONAL TLS SYNC"}</span>
      </footer>
    </div>
  );
}
