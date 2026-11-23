import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamChat, TeamChatMessage, TeamRole, TeamUser } from "../../shared/team-types";
import { bridge } from "../lib/bridge";
import { ago, cx, dateTime } from "../lib/format";
import { Icon } from "./Icon";
import { Chip, Panel, Skeleton, type ToastItem } from "./ui";

type Toast = (level: ToastItem["level"], title: string, detail?: string) => void;

const ROLE_LABEL: Record<TeamRole, string> = {
  superadmin: "Super admin",
  admin: "Admin",
  moderator: "Mod",
  user: "Member",
};

const ROLE_TONE: Record<TeamRole, "info" | "violet" | "muted" | "ok"> = {
  superadmin: "violet",
  admin: "info",
  moderator: "ok",
  user: "muted",
};

function initials(message: TeamChatMessage): string {
  const parts = message.authorName.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return (parts[0] ?? message.authorUsername).slice(0, 2).toUpperCase();
}

export function TeamChatView({
  currentUser,
  onToast,
}: {
  currentUser: TeamUser;
  onToast: Toast;
}) {
  const [chat, setChat] = useState<TeamChat | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setChat(await bridge.team.chat());
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
    return bridge.onEvent((event) => {
      if (event.type === "team-sync") void load(true);
    });
  }, [load]);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream) stream.scrollTop = stream.scrollHeight;
  }, [chat?.messages.length]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      setChat(await bridge.team.postMessage(body));
      setDraft("");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onToast("error", "Message not sent", message);
    } finally {
      setSending(false);
    }
  };

  const messages = chat?.messages ?? [];

  return (
    <Panel
      eyebrow="TEAM CHAT"
      title="Workspace conversation"
      actions={<span className="mono subtle">{messages.length} message{messages.length === 1 ? "" : "s"}</span>}
      flush
    >
      <div className="team-chat">
        <div className="team-chat-stream" ref={streamRef} aria-live="polite">
          {loading && !chat ? (
            <div className="team-chat-loading">
              <Skeleton height={54} />
              <Skeleton height={54} />
              <Skeleton height={54} />
            </div>
          ) : messages.length === 0 ? (
            <div className="team-chat-empty">
              <span className="hero-glyph">
                <Icon name="chat" size={22} />
              </span>
              <strong>Start the team conversation.</strong>
              <p>Messages are shared with everyone in this Nexus workspace and stay in the local team database.</p>
            </div>
          ) : (
            messages.map((message) => {
              const mine = message.authorUsername === currentUser.username;
              return (
                <article key={message.id} className={cx("team-chat-message", mine && "is-mine")}>
                  <span className="avatar">{initials(message)}</span>
                  <div className="team-chat-message-main">
                    <header>
                      <strong>{message.authorName}</strong>
                      <span className="mono">@{message.authorUsername}</span>
                      <Chip tone={ROLE_TONE[message.authorRole]}>{ROLE_LABEL[message.authorRole]}</Chip>
                      <time title={dateTime(message.createdAt)}>{ago(message.createdAt)}</time>
                    </header>
                    <p>{message.body}</p>
                  </div>
                </article>
              );
            })
          )}
        </div>

        {error ? <p className="team-chat-error">{error}</p> : null}

        <div className="team-chat-composer">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Write a message to the team…"
            rows={3}
            maxLength={2000}
            disabled={sending}
            aria-label="Team chat message"
          />
          <div className="team-chat-composer-foot">
            <span className="mono subtle">Enter to send · Shift+Enter for a new line</span>
            <button className="btn small primary" onClick={() => void send()} disabled={sending || !draft.trim()}>
              <Icon name="chat" size={12} /> {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
