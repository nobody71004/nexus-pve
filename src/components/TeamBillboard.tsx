import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  TeamBoard,
  TeamBoardList,
  TeamBoardTask,
  TeamBoardTaskInput,
  TeamUser,
} from "../../shared/team-types";
import { bridge } from "../lib/bridge";
import { ago, cx, dateTime } from "../lib/format";
import { Icon } from "./Icon";
import { Modal, Panel, Skeleton, type ToastItem } from "./ui";

type Toast = (level: ToastItem["level"], title: string, detail?: string) => void;

function initials(name: string, username: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return (parts[0] ?? username).slice(0, 2).toUpperCase();
}

function taskListName(lists: TeamBoardList[], listId: string): string {
  return lists.find((list) => list.id === listId)?.title ?? "Unknown list";
}

export function TeamBillboard({ currentUser, onToast }: { currentUser: TeamUser; onToast: Toast }) {
  const [board, setBoard] = useState<TeamBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newList, setNewList] = useState("");
  const [dialog, setDialog] = useState<{ mode: "create" | "edit"; listId: string; task?: TeamBoardTask } | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setBoard(await bridge.team.board());
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

  const canManageTask = (task: TeamBoardTask) =>
    task.authorUsername === currentUser.username || currentUser.role !== "user";
  const canDeleteList = (list: TeamBoardList) =>
    currentUser.role !== "user" || list.createdByUsername === currentUser.username;

  const addList = async () => {
    const title = newList.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      setBoard(await bridge.team.createBoardList(title));
      setNewList("");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onToast("error", "Could not add list", message);
    } finally {
      setBusy(false);
    }
  };

  const removeList = async (list: TeamBoardList) => {
    if (!canDeleteList(list) || busy) return;
    if (!window.confirm(`Delete “${list.title}” and every task in it?`)) return;
    setBusy(true);
    setError(null);
    try {
      setBoard(await bridge.team.deleteBoardList(list.id));
      onToast("ok", "List removed", `${list.title} and its tasks are gone.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onToast("error", "Could not remove list", message);
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async (task: TeamBoardTask) => {
    if (busy) return;
    setBusy(true);
    try {
      setBoard(await bridge.team.updateBoardTask(task.id, { pinned: !task.pinned }));
    } catch (err) {
      onToast("error", "Could not update pin", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const moveTask = async (task: TeamBoardTask, listId: string) => {
    if (busy || task.listId === listId) return;
    setBusy(true);
    try {
      setBoard(await bridge.team.updateBoardTask(task.id, { listId }));
    } catch (err) {
      onToast("error", "Could not move task", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeTask = async (task: TeamBoardTask) => {
    if (!canManageTask(task) || busy) return;
    if (!window.confirm(`Delete “${task.title}”?`)) return;
    setBusy(true);
    try {
      setBoard(await bridge.team.deleteBoardTask(task.id));
      onToast("ok", "Task deleted", task.title);
    } catch (err) {
      onToast("error", "Could not delete task", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveTask = async (input: TeamBoardTaskInput) => {
    if (!dialog) return;
    const next =
      dialog.mode === "edit" && dialog.task
        ? await bridge.team.updateBoardTask(dialog.task.id, input)
        : await bridge.team.createBoardTask(input);
    setBoard(next);
    onToast("ok", dialog.mode === "edit" ? "Task updated" : "Task added", input.title);
  };

  const lists = board?.lists ?? [];
  const tasks = board?.tasks ?? [];
  const pinned = useMemo(() => tasks.filter((task) => task.pinned), [tasks]);
  const tasksFor = (listId: string) => tasks.filter((task) => task.listId === listId);

  return (
    <>
      <Panel
        eyebrow="BILLBOARD"
        title="Pinned tasks and shared lists"
        actions={
          <span className="mono subtle">
            {tasks.length} task{tasks.length === 1 ? "" : "s"} · {lists.length} list{lists.length === 1 ? "" : "s"}
          </span>
        }
        flush
      >
        <div className="team-billboard">
          <div className="board-toolbar">
            <div className="board-new-list">
              <Icon name="plus" size={13} />
              <input
                value={newList}
                onChange={(event) => setNewList(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addList();
                }}
                placeholder="New list name"
                maxLength={40}
                disabled={busy}
                aria-label="New list name"
              />
              <button className="btn small ghost" onClick={() => void addList()} disabled={busy || !newList.trim()}>
                Add list
              </button>
            </div>
            <span className="board-toolbar-note">
              Everyone can add tasks and move work between lists. Pin a task to keep it at the top.
            </span>
          </div>

          {error ? <p className="team-chat-error">{error}</p> : null}

          {loading && !board ? (
            <div className="board-loading">
              <Skeleton height={210} />
              <Skeleton height={210} />
              <Skeleton height={210} />
            </div>
          ) : lists.length === 0 ? (
            <div className="team-chat-empty">
              <span className="hero-glyph">
                <Icon name="clipboard" size={22} />
              </span>
              <strong>Create the first list.</strong>
              <p>Lists hold shared tasks. Use the field above to add one.</p>
            </div>
          ) : (
            <>
              {pinned.length > 0 ? (
                <div className="board-pinned-strip">
                  <div className="board-pinned-label">
                    <Icon name="pin" size={12} /> Pinned
                  </div>
                  <div className="board-pinned-items">
                    {pinned.map((task) => (
                      <button
                        key={task.id}
                        className={cx("board-pinned-chip", busy && "is-busy")}
                        onClick={() => void togglePin(task)}
                        title={`Unpin ${task.title}`}
                      >
                        <strong>{task.title}</strong>
                        <span>{taskListName(lists, task.listId)}</span>
                        <Icon name="pin" size={10} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="board-columns">
                {lists.map((list) => {
                  const listTasks = tasksFor(list.id);
                  return (
                    <section className="board-column" key={list.id}>
                      <header className="board-column-head">
                        <div>
                          <strong>{list.title}</strong>
                          <span className="mono subtle">{listTasks.length}</span>
                        </div>
                        <div className="board-column-actions">
                          <button
                            className="btn icon ghost"
                            onClick={() => setDialog({ mode: "create", listId: list.id })}
                            title={`Add a task to ${list.title}`}
                          >
                            <Icon name="plus" size={12} />
                          </button>
                          {canDeleteList(list) ? (
                            <button
                              className="btn icon ghost danger"
                              onClick={() => void removeList(list)}
                              disabled={busy}
                              title={`Delete ${list.title}`}
                            >
                              <Icon name="trash" size={11} />
                            </button>
                          ) : null}
                        </div>
                      </header>

                      <div className="board-task-list">
                        {listTasks.length === 0 ? (
                          <button
                            className="board-add-task"
                            onClick={() => setDialog({ mode: "create", listId: list.id })}
                          >
                            <Icon name="plus" size={11} /> Add a task
                          </button>
                        ) : (
                          listTasks.map((task) => (
                            <article className={cx("board-task", task.pinned && "is-pinned")} key={task.id}>
                              <header className="board-task-head">
                                <button
                                  className={cx("board-pin-button", task.pinned && "active")}
                                  onClick={() => void togglePin(task)}
                                  disabled={busy}
                                  title={task.pinned ? "Unpin task" : "Pin task"}
                                >
                                  <Icon name="pin" size={11} />
                                </button>
                                <strong>{task.title}</strong>
                                {canManageTask(task) ? (
                                  <div className="board-task-actions">
                                    <button
                                      className="btn icon ghost"
                                      onClick={() =>
                                        setDialog({ mode: "edit", listId: task.listId, task })
                                      }
                                      title="Edit task"
                                    >
                                      <Icon name="edit" size={11} />
                                    </button>
                                    <button
                                      className="btn icon ghost danger"
                                      onClick={() => void removeTask(task)}
                                      disabled={busy}
                                      title="Delete task"
                                    >
                                      <Icon name="trash" size={11} />
                                    </button>
                                  </div>
                                ) : null}
                              </header>
                              {task.detail ? <p className="board-task-detail">{task.detail}</p> : null}
                              <footer className="board-task-foot">
                                <span className="board-task-author">
                                  <span className="avatar tiny">{initials(task.authorName, task.authorUsername)}</span>
                                  <span>{task.authorName}</span>
                                </span>
                                <select
                                  className="board-move"
                                  value={task.listId}
                                  onChange={(event) => void moveTask(task, event.target.value)}
                                  disabled={busy}
                                  aria-label={`Move ${task.title}`}
                                >
                                  {lists.map((entry) => (
                                    <option key={entry.id} value={entry.id}>
                                      {entry.title}
                                    </option>
                                  ))}
                                </select>
                              </footer>
                              <span className="board-task-time" title={dateTime(task.updatedAt)}>
                                updated {ago(task.updatedAt)}
                              </span>
                            </article>
                          ))
                        )}
                      </div>

                      {listTasks.length > 0 ? (
                        <button
                          className="board-add-task"
                          onClick={() => setDialog({ mode: "create", listId: list.id })}
                        >
                          <Icon name="plus" size={11} /> Add a task
                        </button>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </Panel>

      {dialog ? (
        <BoardTaskDialog
          key={`${dialog.mode}-${dialog.task?.id ?? "new"}`}
          mode={dialog.mode}
          task={dialog.task}
          lists={lists}
          initialListId={dialog.listId}
          onClose={() => setDialog(null)}
          onSave={saveTask}
        />
      ) : null}
    </>
  );
}

function BoardTaskDialog({
  mode,
  task,
  lists,
  initialListId,
  onClose,
  onSave,
}: {
  mode: "create" | "edit";
  task?: TeamBoardTask;
  lists: TeamBoardList[];
  initialListId: string;
  onClose: () => void;
  onSave: (input: TeamBoardTaskInput) => Promise<void>;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [detail, setDetail] = useState(task?.detail ?? "");
  const [listId, setListId] = useState(task?.listId ?? initialListId);
  const [pinned, setPinned] = useState(task?.pinned ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim()) {
      setError("Give the task a title.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({ listId, title, detail, pinned });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={mode === "create" ? "Add a board task" : "Edit board task"}
      subtitle="Tasks are shared with the workspace and can be moved or pinned by any member."
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving…" : mode === "create" ? "Add task" : "Save task"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span>Task</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Replace the edge TLS certificate"
            maxLength={140}
            autoFocus
            disabled={busy}
          />
        </label>
        <label className="field">
          <span>List</span>
          <select value={listId} onChange={(event) => setListId(event.target.value)} disabled={busy}>
            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field board-detail-field">
          <span>Notes</span>
          <textarea
            value={detail}
            onChange={(event) => setDetail(event.target.value)}
            placeholder="Context, links or acceptance criteria"
            rows={4}
            maxLength={2000}
            disabled={busy}
          />
        </label>
        <label className="board-pin-toggle">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(event) => setPinned(event.target.checked)}
            disabled={busy}
          />
          <span>
            <strong>Pin this task</strong>
            <small>Keep it in the pinned strip above every list.</small>
          </span>
        </label>
        {error ? <p className="form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}
