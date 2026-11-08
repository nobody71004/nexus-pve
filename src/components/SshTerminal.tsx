import { useEffect, useRef, useState } from "react";
import type { SshHostSummary } from "../../shared/types";
import { bridge } from "../lib/bridge";
import { cx } from "../lib/format";
import { speedHistory } from "../lib/speed";
import { Icon } from "./Icon";

interface Line {
  id: number;
  kind: "cmd" | "out" | "err" | "meta";
  text: string;
}

const HELP = [
  "Local commands (run in Nexus, not on the host):",
  "  help              show this help",
  "  clear             clear the buffer",
  "  hosts             list configured Linux hosts",
  "  speedtest         run the throughput probe on this host",
  "  status            print the latest telemetry summary",
  "",
  "Remote commands run through bash on the host, e.g.  df -h   |   uptime   |   systemctl status nginx",
  "Destructive verbs need an explicit flag:  reboot --yes   |   shutdown --yes",
  "  service restart <unit> / service stop <unit> / service start <unit>",
];

/**
 * A line-mode console over SSH. It is intentionally not a PTY: every command is
 * one authenticated exec, which keeps the same audit and approval path as the
 * agent tools and survives a dropped connection without half-open sessions.
 */
export function SshTerminal({
  host,
  onToast,
}: {
  host: SshHostSummary;
  onToast: (level: "info" | "warn" | "error" | "ok", title: string, detail?: string) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const push = (kind: Line["kind"], text: string) => {
    setLines((current) => [...current.slice(-400), { id: ++seq.current, kind, text }]);
  };

  useEffect(() => {
    setLines([
      { id: ++seq.current, kind: "meta", text: `nexus console → ${host.username}@${host.host}:${host.port} (${host.label})` },
      { id: ++seq.current, kind: "meta", text: "type `help` for local commands. Every remote command is audited." },
    ]);
    setHistory([]);
    setCursor(-1);
  }, [host.id, host.username, host.host, host.port, host.label]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  const run = async (raw: string) => {
    const command = raw.trim();
    if (!command) return;
    push("cmd", command);
    setHistory((current) => [...current, command]);
    setCursor(-1);
    const [word, ...rest] = command.split(/\s+/);

    if (word === "clear") {
      setLines([]);
      return;
    }
    if (word === "help") {
      HELP.forEach((line) => push("out", line));
      return;
    }
    if (word === "hosts") {
      const hosts = await bridge.ssh.hosts();
      hosts.forEach((entry) => push("out", `${entry.id.padEnd(20)} ${entry.username}@${entry.host}:${entry.port}  ${entry.label}`));
      return;
    }

    setBusy(true);
    try {
      if (word === "speedtest") {
        push("meta", "measuring download, upload and latency…");
        const result = await bridge.ssh.speedtest(host.id);
        speedHistory.record(result);
        if (result.error) push("err", result.error);
        else
          push(
            "out",
            `down ${result.downMbps.toFixed(1)} Mbps · up ${result.upMbps.toFixed(1)} Mbps · connect ${result.latencyMs} ms` +
              `${result.linkMbps ? ` · link ${Math.round(result.linkMbps / 1000)} GbE` : ""}` +
              `${result.endpoint ? ` · via ${result.endpoint}` : ""}` +
              `${result.cutStreams ? ` · ${result.cutStreams}/${result.streams ?? "?"} streams cut` : ""}`,
          );
        return;
      }
      if (word === "status") {
        const snapshot = await bridge.ssh.snapshot(host.id);
        push("out", `${snapshot.identity.hostname} · ${snapshot.identity.os} · ${snapshot.cpu.cores} threads · up ${Math.round(snapshot.identity.uptime / 3600)}h`);
        push("out", `cpu ${snapshot.cpu.usage.toFixed(1)}% · mem ${((snapshot.memory.used / Math.max(1, snapshot.memory.total)) * 100).toFixed(1)}% · load ${snapshot.cpu.load.join(" / ")}`);
        push("out", `psi cpu ${snapshot.pressure.cpu.some10.toFixed(2)} · mem ${snapshot.pressure.memory.some10.toFixed(2)} · io ${snapshot.pressure.io.some10.toFixed(2)}`);
        return;
      }
      if (word === "reboot" || word === "shutdown") {
        if (!rest.includes("--yes")) {
          push("err", `refusing to ${word} without --yes (this drops the host)`);
          return;
        }
        const result = await bridge.ssh.action(host.id, word);
        push(result.ok ? "out" : "err", result.output || `${word} scheduled`);
        onToast(result.ok ? "ok" : "error", `${word} ${result.ok ? "requested" : "failed"}`, host.label);
        return;
      }
      if (word === "service") {
        const [verb, unit] = rest;
        if (!verb || !unit) {
          push("err", "usage: service restart|stop|start <unit>");
          return;
        }
        const mapped = verb === "restart" ? "restart-service" : verb === "stop" ? "stop-service" : verb === "start" ? "start-service" : null;
        if (!mapped) {
          push("err", "unknown service verb");
          return;
        }
        const result = await bridge.ssh.action(host.id, mapped, unit);
        push(result.ok ? "out" : "err", result.output);
        return;
      }

      const result = await bridge.ssh.exec(host.id, command, { shell: true });
      if (result.stdout) push("out", result.stdout.replace(/\s+$/, ""));
      if (result.stderr) push("err", result.stderr.replace(/\s+$/, ""));
      if (!result.stdout && !result.stderr) push("meta", `(no output · exit ${result.code ?? "?"})`);
      if (!result.ok) push("err", `exit ${result.code ?? "?"}`);
    } catch (error) {
      push("err", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="ssh-term">
      <div className="ssh-term-head">
        <span className="live-tag">
          <i /> SSH
        </span>
        <span className="mono subtle small">
          {host.username}@{host.host}
        </span>
        <button className="btn small ghost" onClick={() => setLines([])}>
          Clear
        </button>
      </div>

      <div className="ssh-term-body" onMouseUp={() => inputRef.current?.focus()}>
        {lines.map((line) => (
          <div key={line.id} className={cx("term-line", line.kind)}>
            {line.kind === "cmd" ? <span className="term-prompt">{host.username}@{host.host.replace(/\..*/, "")} $</span> : null}
            <span className="term-text">{line.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form
        className="ssh-term-input"
        onSubmit={(event) => {
          event.preventDefault();
          const command = value;
          setValue("");
          void run(command);
        }}
      >
        <span className="term-prompt">$</span>
        <input
          ref={inputRef}
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={busy ? "waiting for the host…" : "type a command (help)"}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              const next = cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1);
              if (history[next]) {
                setCursor(next);
                setValue(history[next]);
              }
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (cursor < 0) return;
              const next = cursor + 1;
              if (next >= history.length) {
                setCursor(-1);
                setValue("");
              } else {
                setCursor(next);
                setValue(history[next]);
              }
            }
          }}
        />
        <button className="btn small primary" type="submit" disabled={busy || !value.trim()}>
          {busy ? <Icon name="refresh" size={13} className="spin" /> : "Run"}
        </button>
      </form>
    </div>
  );
}
