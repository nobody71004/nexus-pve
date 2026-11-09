import { useCallback, useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import type { SshHostSummary, VncPreflight, VncSession, VncSetupResult } from "../../shared/types";
import { bridge, isMockBridge } from "../lib/bridge";
import { cx } from "../lib/format";
import { Icon } from "./Icon";

type VncState = "idle" | "starting" | "connecting" | "connected" | "error";
type SetupState = "idle" | "running" | "ready" | "error";

/** Electron wraps rejected IPC handlers twice; show the message the service raised. */
function readableError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}

/** Foot's font-increase/decrease/reset shortcuts, sent through RFB. */
const FONT_KEYS = {
  increase: { keysym: 0xffab, code: "Equal" },
  decrease: { keysym: 0xffad, code: "Minus" },
  reset: { keysym: 0x30, code: "Digit0" },
} as const;

/**
 * A real RFB console inside the renderer. The WebSocket is bound to loopback
 * and terminates in the main process, where bytes are forwarded through the
 * existing authenticated SSH connection. No VNC port is exposed publicly.
 */
export function VncConsole({
  host,
  onToast,
  canSetup = true,
}: {
  host: SshHostSummary;
  onToast: (level: "info" | "warn" | "error" | "ok", title: string, detail?: string) => void;
  canSetup?: boolean;
}) {
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const sessionRef = useRef<VncSession | null>(null);
  const autoSetupRef = useRef<string | null>(null);
  const setupBusyRef = useRef(false);
  const [state, setState] = useState<VncState>("idle");
  const [error, setError] = useState<string | null>(null);
  const configuredPort = host.vncPort;
  const [port, setPort] = useState(configuredPort ?? 5900);
  const [password, setPassword] = useState("");
  const passwordRef = useRef("");
  const [showPassword, setShowPassword] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [preflight, setPreflight] = useState<VncPreflight | null>(null);
  const [preflightState, setPreflightState] = useState<"idle" | "checking" | "done">("idle");
  const [setupState, setSetupState] = useState<SetupState>("idle");
  const [setupResult, setSetupResult] = useState<VncSetupResult | null>(null);
  const [sudoPassword, setSudoPassword] = useState("");
  const [showSudo, setShowSudo] = useState(false);
  // Mirrors the input so a click from any render path still carries the secret.
  const sudoRef = useRef("");

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

  // A pinned port belongs to the host, so it survives opening a different host
  // or reconnecting. Unpinned hosts still follow the detected daemon.
  useEffect(() => {
    setPort(configuredPort ?? 5900);
  }, [host.id, configuredPort]);

  // Reset per-host setup state before probing the new host.
  useEffect(() => {
    autoSetupRef.current = null;
    setSetupState("idle");
    setSetupResult(null);
    setSudoPassword("");
    sudoRef.current = "";
    setShowSudo(false);
  }, [host.id]);

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
        if (result.ok && configuredPort === undefined) {
          setPort((current) => (current === 5900 || current === result.suggestedPort ? result.suggestedPort : current));
        }
        // Ask for the one-time sudo secret immediately instead of running an
        // install that is known to fail without it.
        if (!result.ok && result.needsSudoPassword) setShowSudo(true);
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
  }, [host.id, host.host, attempt, configuredPort]);

  const runSetup = useCallback(
    async (sudoPasswordOverride?: string) => {
      if (!canSetup || setupBusyRef.current) return;
      setupBusyRef.current = true;
      setSetupState("running");
      setError(null);
      // Every entry point (banner, retry, Enter) reads the same secret, so no
      // path can fall back to an unprivileged run.
      const typed = sudoPasswordOverride ?? sudoRef.current;
      try {
        const result = await bridge.vnc.setup(host.id, typed.trim() || undefined);
        setSetupResult(result);
        if (result.ok) {
          setSetupState("ready");
          setSudoPassword("");
          sudoRef.current = "";
          setShowSudo(false);
          setPort(result.port);
          // Give systemd a moment to publish the loopback listener before the
          // next preflight opens the tunnel.
          window.setTimeout(() => setAttempt((value) => value + 1), 350);
          onToast(
            "ok",
            `VNC console ready on ${host.label}`,
            `127.0.0.1:${result.port}${result.mode === "x11" ? " · TigerVNC fallback" : " · sway/wayvnc"}`,
          );
        } else {
          setSetupState("error");
          setShowSudo(Boolean(result.needsSudoPassword));
          setError(result.error ?? "The host console could not be installed.");
          onToast("error", `VNC setup failed on ${host.label}`, result.error ?? "The host installer did not finish.");
        }
      } catch (err) {
        const message = readableError(err);
        setSetupState("error");
        setError(message);
        onToast("error", "VNC setup failed", message);
      } finally {
        setupBusyRef.current = false;
      }
    },
    [canSetup, host.id, host.label, onToast],
  );

  // Opening the VNC tab on a host with no listener is the trigger for the
  // bootstrap. It runs once per host mount; a failure leaves the retry controls
  // visible rather than hammering sshd or apt.
  useEffect(() => {
    if (isMockBridge || !canSetup) return;
    if (preflightState !== "done" || !preflight || preflight.ok || preflight.error) return;
    // A key-auth host has no stored password to feed sudo. Prompt for the
    // one-time secret rather than launching a run that cannot succeed.
    if (preflight.needsSudoPassword) {
      setShowSudo(true);
      return;
    }
    if (autoSetupRef.current === host.id) return;
    autoSetupRef.current = host.id;
    void runSetup();
  }, [preflightState, preflight, host.id, canSetup, runSetup]);

  useEffect(() => {
    if (isMockBridge) {
      setState("idle");
      return;
    }
    if (preflightState !== "done") return;
    if (preflight && !preflight.ok) {
      setState("error");
      setError(preflight.error ?? preflight.detail);
      return;
    }
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
  }, [host.id, port, attempt, preflightState, preflight, onToast, teardown]);

  const sendFontKey = (key: keyof typeof FONT_KEYS) => {
    const rfb = rfbRef.current;
    if (!rfb || state !== "connected") return;
    const target = FONT_KEYS[key];
    rfb.sendKey(0xffe3, "ControlLeft", true);
    rfb.sendKey(target.keysym, target.code, true);
    rfb.sendKey(target.keysym, target.code, false);
    rfb.sendKey(0xffe3, "ControlLeft", false);
    rfb.focus();
  };

  if (isMockBridge) {
    return (
      <div className="vnc-empty">
        <Icon name="terminal" size={22} />
        <strong>VNC is available in the desktop app</strong>
        <p>The browser preview has no Electron bridge, so it cannot open an SSH-tunneled RFB session.</p>
      </div>
    );
  }

  const noListener = Boolean(preflight && !preflight.ok && !preflight.error);
  const installing = setupState === "running";

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
        <div className="vnc-text" role="group" aria-label="Terminal font size">
          <button type="button" className="vnc-font" onClick={() => sendFontKey("decrease")} disabled={state !== "connected"} title="Decrease terminal font (Ctrl+minus; foot terminal)">
            A−
          </button>
          <button type="button" className="vnc-font" onClick={() => sendFontKey("increase")} disabled={state !== "connected"} title="Increase terminal font (Ctrl+plus; foot terminal)">
            A+
          </button>
          <button type="button" className="vnc-font reset" onClick={() => sendFontKey("reset")} disabled={state !== "connected"} title="Reset terminal font (Ctrl+0; foot terminal)">
            A0
          </button>
        </div>
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
          {!preflight.ok && !installing && canSetup && !showSudo ? (
            <button type="button" className="btn small ghost" onClick={() => void runSetup(sudoPassword)}>
              <Icon name="download" size={11} /> Auto-install
            </button>
          ) : null}
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
          <div className={cx("vnc-status", state === "error" && !installing && !noListener && "error")}>
            {installing ? (
              <>
                <Icon name="refresh" size={20} className="spin" />
                <strong>Installing VNC console…</strong>
                <p>
                  Installing sway, wayvnc and foot — or the TigerVNC fallback — then creating a boot-persistent service bound to
                  127.0.0.1. This can take a minute on a fresh host.
                </p>
              </>
            ) : noListener && setupState !== "ready" ? (
              <>
                <Icon name="terminal" size={20} />
                <strong>Set up the host console</strong>
                <p>{preflight?.detail}</p>
                <p className="vnc-setup-copy">
                  One click installs the missing terminal stack and starts a loopback-only VNC service. The SSH tunnel stays the
                  only way in.
                </p>
                {showSudo && setupState !== "error" ? (
                  <p className="vnc-setup-copy">
                    This host needs its sudo password once. It is used for this install only and never stored.
                  </p>
                ) : null}
                {setupResult && !setupResult.ok && setupResult.error ? <p className="vnc-setup-error">{setupResult.error}</p> : null}
                {setupState === "error" && error && (!setupResult || setupResult.ok) ? <p className="vnc-setup-error">{error}</p> : null}
                {!canSetup ? (
                  <p className="hint">Ask an admin to install the console on this host.</p>
                ) : (
                  <>
                    {showSudo ? (
                      <input
                        className="vnc-password"
                        type="password"
                        value={sudoPassword}
                        placeholder="sudo password (one-time)"
                        autoComplete="current-password"
                        autoFocus
                        onChange={(event) => {
                          setSudoPassword(event.target.value);
                          sudoRef.current = event.target.value;
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void runSetup(sudoPassword);
                        }}
                      />
                    ) : null}
                    <div className="vnc-setup-actions">
                      <button type="button" className="btn small primary" onClick={() => void runSetup(sudoPassword)}>
                        <Icon name="download" size={12} />{" "}
                        {setupState === "error" ? "Retry auto-install" : showSudo ? "Install with sudo" : "Auto-install VNC"}
                      </button>
                    </div>
                  </>
                )}
                {setupResult && !setupResult.ok ? (
                  <details className="vnc-setup-details">
                    <summary>Installer details</summary>
                    <pre>{setupResult.output}</pre>
                  </details>
                ) : null}
              </>
            ) : state === "error" ? (
              <>
                <Icon name="alert" size={20} />
                <strong>VNC unavailable</strong>
                {error ? <p>{error}</p> : <p>The host needs a VNC server listening on 127.0.0.1:{port}.</p>}
                <button className="btn small ghost" onClick={() => setAttempt((value) => value + 1)}>
                  Retry
                </button>
                {setupResult && !setupResult.ok ? (
                  <details className="vnc-setup-details">
                    <summary>Installer details</summary>
                    <pre>{setupResult.output}</pre>
                  </details>
                ) : null}
              </>
            ) : (
              <>
                <Icon name="refresh" size={20} className="spin" />
                <strong>{state === "starting" ? "Opening SSH tunnel…" : "Connecting to RFB…"}</strong>
                <p>The host needs a VNC server listening on 127.0.0.1:{port}.</p>
              </>
            )}
          </div>
        ) : null}
      </div>
      <p className="hint vnc-hint">
        RFB travels through SSH and a loopback-only WebSocket. Auto-install keeps the daemon on 127.0.0.1; never expose 5900
        publicly. A− / A+ / A0 change the terminal font once the console is live.
      </p>
    </div>
  );
}
