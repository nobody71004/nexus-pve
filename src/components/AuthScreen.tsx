import { useState } from "react";
import type { TeamBootstrapInput, TeamLoginInput, TeamUser } from "../../shared/team-types";
import { bridge } from "../lib/bridge";
import { Backdrop } from "./Backdrop";
import { Icon } from "./Icon";

export function AuthScreen({
  initialized,
  onAuthenticated,
  onWorkspaceChanged,
}: {
  initialized: boolean;
  onAuthenticated: (user: TeamUser) => void;
  onWorkspaceChanged: () => void;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinEndpoint, setJoinEndpoint] = useState("");
  const [joinWorkspace, setJoinWorkspace] = useState("default");
  const [joinToken, setJoinToken] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinNotice, setJoinNotice] = useState<string | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);

  const setup = !initialized;

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

  const join = async () => {
    setJoinError(null);
    setJoinNotice(null);
    if (!joinEndpoint.trim() || !joinToken.trim()) {
      setJoinError("Enter the relay URL and workspace token.");
      return;
    }
    setJoinBusy(true);
    try {
      await bridge.teamSync.configure({
        endpoint: joinEndpoint.trim(),
        workspace: joinWorkspace.trim() || "default",
        token: joinToken.trim(),
        deviceName: "Nexus desktop",
      });
      setJoinToken("");
      setJoinNotice("Connected. If this relay already has accounts, sign in with one of them.");
      onWorkspaceChanged();
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : String(err));
    } finally {
      setJoinBusy(false);
    }
  };

  return (
    <div className="app auth-app">
      <Backdrop reduced={false} />
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
          {setup ? "WORKSPACE NOT INITIALIZED" : "SECURE LOCAL WORKSPACE"}
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
            <Icon name={setup ? "users" : "lock"} size={24} />
          </span>
          <span className="eyebrow">{setup ? "FIRST RUN" : "TEAM ACCESS"}</span>
          <h1 id="auth-title">{setup ? "Create the workspace owner." : "Welcome back."}</h1>
          <p className="auth-lede">
            {setup
              ? "Nexus needs one owner account before it can store members, roles and machine grants. This account lives only on this computer."
              : "Sign in to the local Nexus workspace. Your role decides which machines and admin tools you can use."}
          </p>

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
            <button className="auth-join-toggle" type="button" onClick={() => setJoinOpen((open) => !open)}>
              <Icon name="plug" size={12} /> {joinOpen ? "Hide sync setup" : "Join a synced workspace"}
            </button>
          ) : null}

          {setup && joinOpen ? (
            <div className="auth-join">
              <div className="auth-join-head">
                <strong>Cross-device team sync</strong>
                <span className="mono">SELF-HOSTED TLS RELAY</span>
              </div>
              <p>
                Enter the relay URL and token your workspace admin shared. Accounts, roles, machine grants and audit
                events sync. SSH keys and passwords stay on each computer.
              </p>
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
                  <input value={joinWorkspace} onChange={(event) => setJoinWorkspace(event.target.value)} disabled={joinBusy} />
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
              {joinError ? <div className="auth-error"><Icon name="alert" size={14} /><span>{joinError}</span></div> : null}
              {joinNotice ? <p className="auth-join-notice">{joinNotice}</p> : null}
              <div className="auth-join-actions">
                <button className="btn small ghost" type="button" onClick={() => setJoinOpen(false)} disabled={joinBusy}>
                  Cancel
                </button>
                <button className="btn small primary" type="button" onClick={() => void join()} disabled={joinBusy}>
                  {joinBusy ? "Connecting…" : "Connect & sync"}
                </button>
              </div>
            </div>
          ) : null}

          <p className="auth-footnote">
            <Icon name="database" size={12} />
            SQLite-backed local team directory · passwords hashed with scrypt
          </p>
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
              <p>Admin, moderator and member roles with server-side permission checks.</p>
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
              <p>Users, sessions, links and audit events persist in the workspace database.</p>
            </div>
          </div>
          <p className="auth-aside-note">
            Local SQLite remains the source of truth on each station. An admin can opt into a self-hosted TLS sync
            relay so the same team can collaborate from another computer without sharing SSH secrets.
          </p>
        </aside>
      </main>

      <footer className="auth-footer">
        <span className="mono">NEXUS PVE · TEAM ACCESS</span>
        <span className="mono">LOCAL SQLITE · OPTIONAL TLS SYNC</span>
      </footer>
    </div>
  );
}
