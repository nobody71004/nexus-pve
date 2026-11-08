import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../lib/format";
import { Icon, type IconName } from "./Icon";

export interface Command {
  id: string;
  label: string;
  hint: string;
  icon: IconName;
  group: string;
  run: () => void;
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return commands;
    return commands.filter((command) => `${command.label} ${command.hint} ${command.group}`.toLowerCase().includes(term));
  }, [commands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    setTimeout(() => command.run(), 40);
  };

  return (
    <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search hosts, views, pipelines and actions…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((current) => Math.min(filtered.length - 1, current + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((current) => Math.max(0, current - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(filtered[index]);
              } else if (event.key === "Escape") {
                onClose();
              }
            }}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="palette-list">
          {filtered.map((command, position) => {
            const showGroup = position === 0 || filtered[position - 1].group !== command.group;
            return (
              <div key={command.id}>
                {showGroup ? <span className="palette-group">{command.group}</span> : null}
                <button
                  className={cx("palette-row", position === index && "active")}
                  onMouseEnter={() => setIndex(position)}
                  onClick={() => run(command)}
                >
                  <span className="palette-icon">
                    <Icon name={command.icon} size={14} />
                  </span>
                  <span className="palette-label">{command.label}</span>
                  <span className="palette-hint">{command.hint}</span>
                  {position === index ? <Icon name="chevron" size={13} /> : null}
                </button>
              </div>
            );
          })}
          {filtered.length === 0 ? <p className="palette-empty">No matching command.</p> : null}
        </div>
      </div>
    </div>
  );
}
