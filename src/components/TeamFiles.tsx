import { useCallback, useEffect, useState } from "react";
import type { TeamFileEntry, TeamFilesOverview, TeamUser } from "../../shared/types";
import { bridge } from "../lib/bridge";
import { ago, bytes } from "../lib/format";
import { Icon } from "./Icon";
import { Chip, Panel, Skeleton, StatTile, type ToastItem } from "./ui";

type Toast = (level: ToastItem["level"], title: string, detail?: string) => void;

function endpointLabel(endpoint?: string): string {
  if (!endpoint) return "not connected";
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function extension(name: string): string {
  const suffix = name.includes(".") ? name.split(".").pop()?.slice(0, 4).toUpperCase() : "";
  return suffix || "FILE";
}

export function TeamFiles({
  currentUser,
  onOpenTeam,
  onToast,
}: {
  currentUser: TeamUser;
  onOpenTeam: () => void;
  onToast: Toast;
}) {
  const [overview, setOverview] = useState<TeamFilesOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setOverview(await bridge.teamFiles.overview());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!overview?.configured) return;
    const timer = window.setInterval(() => void load(true), 15_000);
    return () => window.clearInterval(timer);
  }, [load, overview?.configured]);

  const upload = async () => {
    if (!overview?.configured) {
      onToast("error", "Team relay not connected", "Connect Team sync to your self-hosted relay first.");
      return;
    }
    setBusy("upload");
    try {
      const previous = new Set(overview.files.map((file) => file.id));
      const next = await bridge.teamFiles.upload();
      if (!next) return;
      setOverview(next);
      const added = next.files.find((file) => !previous.has(file.id));
      onToast("ok", "File shared", added ? `${added.name} · ${bytes(added.size)}` : "The team file list is up to date.");
    } catch (err) {
      onToast("error", "Share failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const download = async (file: TeamFileEntry) => {
    setBusy(file.id);
    try {
      const saved = await bridge.teamFiles.download(file.id, file.name);
      if (saved) onToast("ok", "File saved", saved);
    } catch (err) {
      onToast("error", "Download failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const saveServerScript = async () => {
    setBusy("server");
    try {
      const saved = await bridge.teamFiles.serverScript();
      if (saved) onToast("ok", "Relay installer saved", saved);
    } catch (err) {
      onToast("error", "Could not save the relay installer", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (file: TeamFileEntry) => {
    if (!window.confirm(`Remove ${file.name} from the team share? This deletes the server copy.`)) return;
    setBusy(file.id);
    try {
      setOverview(await bridge.teamFiles.remove(file.id));
      onToast("ok", "File removed", file.name);
    } catch (err) {
      onToast("error", "Could not remove file", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const files = overview?.files ?? [];
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const canManage = currentUser.role !== "user";

  return (
    <div className="team-files">
      <section className="team-files-hero">
        <div className="team-files-hero-copy">
          <span className="eyebrow">TEAM SHARE</span>
          <h2>One file space for the whole team</h2>
          <p>
            Stream installers, archives, runbooks and large datasets through your self-hosted relay. Every active member
            sees the same files, and Nexus does not impose a per-file size cap.
          </p>
          <div className="team-files-tags">
            <Chip tone={overview?.configured ? "ok" : "warn"} dot>
              {overview?.configured ? "Relay connected" : "Relay not connected"}
            </Chip>
            <Chip tone="info">
              <Icon name="shield" size={10} /> Token protected
            </Chip>
            <Chip tone="muted">{endpointLabel(overview?.endpoint)}</Chip>
          </div>
        </div>
        <div className="team-files-hero-actions">
          <button className="btn primary" onClick={() => void upload()} disabled={!overview?.configured || busy !== null}>
            <Icon name="upload" size={13} /> {busy === "upload" ? "Streaming…" : "Share a file"}
          </button>
          <span className="mono subtle">No client-side size limit</span>
        </div>
      </section>

      {error ? (
        <div className="error-banner">
          <Icon name="alert" size={16} />
          <div>
            <strong>Shared files unavailable</strong>
            <span>{error}</span>
          </div>
          <button className="btn small ghost" onClick={() => void load()} disabled={loading}>
            Retry
          </button>
        </div>
      ) : null}

      {loading && !overview ? (
        <div className="team-files-loading">
          <Skeleton height={120} />
          <Skeleton height={280} />
        </div>
      ) : overview && !overview.configured ? (
        <Panel eyebrow="SELF-HOSTED" title="Connect the team relay to start sharing" className="team-files-setup">
          <div className="team-files-setup-grid">
            <div>
              <span className="team-files-step">01</span>
              <h3>Install the relay</h3>
              <p>
                Copy <code>scripts/team-sync-server.mjs</code> to a server with Node 20+ and run it with the same
                <code> NEXUS_SYNC_TOKEN</code> as your team sync. Use a TLS certificate whenever the server is reachable
                beyond loopback.
              </p>
            </div>
            <div>
              <span className="team-files-step">02</span>
              <h3>Connect Team sync</h3>
              <p>
                On each Nexus station, open <strong>Team access → Sync</strong> and enter the relay URL and workspace
                token. The file list uses that same local connection; the token never reaches the renderer.
              </p>
            </div>
            <div>
              <span className="team-files-step">03</span>
              <h3>Share without a cap</h3>
              <p>
                Files are streamed to <code>NEXUS_FILES_DIR</code> on the relay, one blob per file. Disk space and network
                capacity are the limits, not an arbitrary upload ceiling.
              </p>
            </div>
          </div>
          <pre className="team-files-command"><code>{"NEXUS_SYNC_TOKEN='<at-least-16-chars>' \\\nHOST=0.0.0.0 \\\nPORT=8788 \\\nTLS_CERT=/etc/nexus/fullchain.pem \\\nTLS_KEY=/etc/nexus/privkey.pem \\\nnode scripts/team-sync-server.mjs"}</code></pre>
          <div className="team-files-setup-actions">
            <button className="btn small primary" onClick={onOpenTeam}>
              <Icon name="users" size={12} /> Open Team access
            </button>
            <button className="btn small ghost" onClick={() => void saveServerScript()} disabled={busy !== null}>
              <Icon name="download" size={12} /> {busy === "server" ? "Saving…" : "Save relay installer"}
            </button>
            <span className="hint">
              {canManage
                ? "Admins can configure the relay from the Sync tab."
                : "Ask an admin to connect this station to the team relay."}
            </span>
          </div>
        </Panel>
      ) : overview ? (
        <>
          <div className="team-files-stats">
            <StatTile label="Shared files" value={files.length} hint="available to active team members" icon="folder" tone="cyan" />
            <StatTile label="Total size" value={bytes(totalSize)} hint="stored on your relay" icon="database" tone="violet" />
            <StatTile label="Relay" value={endpointLabel(overview.endpoint)} hint="self-hosted team storage" icon="server" tone="green" />
            <StatTile label="Signed in as" value={`@${currentUser.username}`} hint="upload and download audit identity" icon="user" tone="amber" />
          </div>

          {busy === "upload" ? (
            <div className="team-files-streaming">
              <span className="pulse-dot live" />
              <div>
                <strong>Streaming the file to the relay</strong>
                <span>The transfer stays in the main process and never loads the whole file into Nexus memory.</span>
              </div>
            </div>
          ) : null}

          <Panel
            eyebrow="SHARED LIBRARY"
            title="Files"
            actions={
              <div className="inline-actions">
                <span className="mono subtle">{files.length} item{files.length === 1 ? "" : "s"}</span>
                <button className="btn small ghost" onClick={() => void load()} disabled={loading || busy !== null}>
                  <Icon name="refresh" size={12} /> Refresh
                </button>
              </div>
            }
            flush
          >
            {files.length === 0 ? (
              <div className="team-files-empty">
                <span className="team-files-empty-icon">
                  <Icon name="folder" size={24} />
                </span>
                <strong>Nothing shared yet</strong>
                <p>Share the first installer, archive or document. Every member on this relay will see it.</p>
                <button className="btn small primary" onClick={() => void upload()} disabled={busy !== null}>
                  <Icon name="upload" size={12} /> Share a file
                </button>
              </div>
            ) : (
              <div className="team-files-table-wrap">
                <table className="team-files-table">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Size</th>
                      <th>Shared by</th>
                      <th>When</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((file) => {
                      const removable = canManage || file.uploadedBy === currentUser.username;
                      return (
                        <tr key={file.id}>
                          <td>
                            <div className="team-files-name">
                              <span className="team-files-ext">{extension(file.name)}</span>
                              <div>
                                <strong title={file.name}>{file.name}</strong>
                                <span className="mono">streamed from the team relay</span>
                              </div>
                            </div>
                          </td>
                          <td><span className="mono">{bytes(file.size)}</span></td>
                          <td><span className="team-files-uploader">@{file.uploadedBy}</span></td>
                          <td><span className="subtle small">{ago(file.uploadedAt)}</span></td>
                          <td>
                            <div className="table-actions">
                              <button
                                className="btn small ghost"
                                onClick={() => void download(file)}
                                disabled={busy !== null}
                                title={`Download ${file.name}`}
                              >
                                <Icon name="download" size={12} /> Save
                              </button>
                              {removable ? (
                                <button
                                  className="btn icon ghost danger"
                                  onClick={() => void remove(file)}
                                  disabled={busy !== null}
                                  title={`Remove ${file.name}`}
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
            )}
          </Panel>

          <p className="hint team-files-footnote">
            The relay writes one <code>.blob</code> per file plus a small index under <code>NEXUS_FILES_DIR</code>.
            Set <code>NEXUS_FILES_MAX_BYTES</code> only if the server owner wants a quota. Uploads and downloads are
            streamed, so Nexus itself has no per-file ceiling.
          </p>
        </>
      ) : null}
    </div>
  );
}
