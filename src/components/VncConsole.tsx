import { useCallback, useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import type { SshHostSummary, VncPreflight, VncSession } from "../../shared/types";
import { bridge, isMockBridge } from "../lib/bridge";
import { cx } from "../lib/format";
import { Icon } from "./Icon";

type VncState = "idle" | "starting" | "connecting" | "connected" | "error";

/** Electron wraps rejected IPC handlers twice; show the message the service raised. */
function readableError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}

/**
 * A real RFB console inside the renderer. The WebSocket is bound to loopback
 * and terminates in the main process, where bytes are forwarded through the
 * existing authenticated SSH connection. No VNC port is exposed publicly.
 */
export function VncConsole({
  host,
  onToast,
}: {
  host: SshHostSummary;
  onToast: (level: "info" | "warn" | "error" | "ok", title: string, detail?: string) => void;
}) {
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const sessionRef = useRef<VncSession | null>(null);
  const [state, setState] = useState<VncState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [port, setPort] = useState(5900);
  const [password, setPassword] = useState("");
  const passwordRef = useRef("");
  const [showPassword, setShowPassword] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [preflight, setPreflight] = useState<VncPreflight | null>(null);
  const [preflightState, setPreflightState] = useState<"idle" | "checking" | "done">("idle");

  const teardown = useCallback(async () => {
    const rfb = rfbRef.current;
    rfbRef.current = null;
    if (rfb) {
      try {
        rfb.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      try {
        await bridge.vnc.close(session.id);
      } catch {
        /* the bridge may already have closed */
      }
    }
  }, []);

  // Probe the host before opening the tunnel so the console starts on the port
  // the daemon actually bound, and surfaces a missing listener instead of a
  // silent black screen.
  useEffect(() => {
    if (isMockBridge) return;
    let cancelled = false;
    setPreflightState("checking");
    setPreflight(null);
    void bridge.vnc
      .preflight(host.id)
      .then((result) => {
        if (cancelled) return;
        setPreflight(result);
        if (result.ok) {
          setPort((current) => (current === 5900 || current === result.suggestedPort ? result.suggestedPort : current));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const message = readableError(err);
        setPreflight({
          hostId: host.id,
          host: host.host,
          checkedAt: Date.now(),
          latencyMs: 0,
          ports: [],
          loopbackPorts: [],
          exposedPorts: [],
          suggestedPort: 5900,
          ok: false,
          detail: `Preflight could not run: ${message}`,
          error: message,
        });
      })
      .finally(() => {
        if (!cancelled) setPreflightState("done");
      });
    return () => {
      cancelled = true;
    };
  }, [host.id, host.host, attempt]);

  useEffect(() => {
    if (isMockBridge) {
      setState("idle");
      return;
    }
    if (preflightState !== "done") return;
    let cancelled = false;
    setState("starting");
    setError(null);
    void (async () => {
      await teardown();
      try {
        const session = await bridge.vnc.open(host.id, port);
        if (cancelled) {
          await bridge.vnc.close(session.id).catch(() => undefined);
          return;
        }
        sessionRef.current = session;
        const target = screenRef.current;
        if (!target) throw new Error("VNC screen is not mounted");
        setState("connecting");
        const rfb = new RFB(target, session.wsUrl, {
          credentials: passwordRef.current ? { password: passwordRef.current } : undefined,
          shared: true,
        });
        rfbRef.current = rfb;
        rfb.scaleViewport = true;
        // Never ask the server to resize its desktop. wayvnc on a headless
        // wlroots output rejects the custom mode, then stops dispatching: the
        // socket stays open and reports live while no frames ever arrive.
        rfb.resizeSession = false;
        rfb.clipViewport = false;
        rfb.showDotCursor = true;
        rfb.background = "#03060c";
        rfb.addEventListener("connect", () => {
          if (!cancelled) {
            setState("connected");
            setShowPassword(false);
            setPassword("");
            passwordRef.current = "";
          }
        });
        rfb.addEventListener("disconnect", (event) => {
          if (cancelled) return;
          const clean = (event as CustomEvent<{ clean?: boolean }>).detail?.clean;
          setState("error");
          setError(clean ? "VNC session closed." : "VNC session disconnected.");
        });
        rfb.addEventListener("credentialsrequired", () => {
          if (!cancelled) setShowPassword(true);
        });
        rfb.addEventListener("securityfailure", (event) => {
          if (!cancelled) {
            const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
            setError(reason || "VNC authentication failed.");
            setState("error");
          }
        });
      } catch (err) {
        if (cancelled) return;
        const message = readableError(err);
        setState("error");
        setError(message);
        onToast("error", "VNC session failed", message);
      }
    })();

    return () => {
      cancelled = true;
      void teardown();
    };
  }, [host.id, port, attempt, preflightState, onToast, teardown]);

  if (isMockBridge) {
    return (
      <div className="vnc-empty">
        <Icon name="terminal" size={22} />
        <strong>VNC is available in the desktop app</strong>
        <p>The browser preview has no Electron bridge, so it cannot open an SSH-tunneled RFB session.</p>
      </div>
    );
  }

  return (
    <div className="vnc-wrap">
      <div className="vnc-toolbar">
        <span className={cx("live-tag", state === "connected" && "live")}>
          <i /> {state === "connected" ? "VNC live" : state === "connecting" || state === "starting" ? "connecting" : "VNC"}
        </span>
        <span className="mono subtle small">
          {host.username}@{host.host} · 127.0.0.1:{port}
        </span>
        <label className="vnc-port">
          <span>Port</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(event) => setPort(Math.max(1, Math.min(65535, Number(event.target.value) || 5900)))}
          />
        </label>
        {showPassword ? (
          <input
            className="vnc-password"
            type="password"
            value={password}
            placeholder="VNC password"
            autoComplete="off"
            onChange={(event) => {
              setPassword(event.target.value);
              passwordRef.current = event.target.value;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") setAttempt((value) => value + 1);
            }}
          />
        ) : null}
        {showPassword ? (
          <button className="btn small primary" onClick={() => setAttempt((value) => value + 1)}>
            Unlock
          </button>
        ) : null}
        <button className="btn small ghost" onClick={() => rfbRef.current?.sendCtrlAltDel()} disabled={state !== "connected"}>
          Ctrl+Alt+Del
        </button>
        <button className="btn small ghost" onClick={() => setAttempt((value) => value + 1)}>
          <Icon name="refresh" size={12} /> Reconnect
        </button>
      </div>

      {preflight ? (
        <div className={cx("vnc-preflight", !preflight.ok && "warn")}>
          <Icon name={preflight.ok ? "shield" : "alert"} size={12} />
          <span>{preflight.detail}</span>
          {preflight.daemon ? <em className="mono">{preflight.daemon}</em> : null}
        </div>
      ) : null}

      <div className="vnc-screen">
        <div
          className="vnc-target"
          ref={screenRef}
          tabIndex={0}
          aria-label={`VNC console for ${host.label}`}
          onMouseDown={() => rfbRef.current?.focus()}
        />
        {state !== "connected" ? (
          <div className={cx("vnc-status", state === "error" && "error")}>
            {state === "error" ? <Icon name="alert" size={20} /> : <Icon name="refresh" size={20} className="spin" />}
            <strong>{state === "error" ? "VNC unavailable" : state === "starting" ? "Opening SSH tunnel…" : "Connecting to RFB…"}</strong>
            {error ? <p>{error}</p> : <p>The host needs a VNC server listening on 127.0.0.1:{port}.</p>}
            {state === "error" ? (
              <button className="btn small ghost" onClick={() => setAttempt((value) => value + 1)}>
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="hint vnc-hint">
        RFB travels through SSH and a loopback-only WebSocket. The VNC daemon should bind to 127.0.0.1; never expose 5900 publicly.
      </p>
    </div>
  );
}
