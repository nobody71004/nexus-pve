import { useEffect, useState } from "react";
import { bridge, isMockBridge } from "../lib/bridge";
import { clock } from "../lib/format";
import { Icon } from "./Icon";

export function TitleBar({
  health,
  onPalette,
  motion,
  onToggleMotion,
}: {
  health: "online" | "degraded" | "offline" | "connecting";
  onPalette: () => void;
  motion: boolean;
  onToggleMotion: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <header className="titlebar">
      <div className="brand">
        <span className={motion ? "brand-mark live" : "brand-mark"}>
          <i />
          <i />
          <i />
        </span>
        <div className="brand-text">
          <strong>
            NEXUS<span>PVE</span>
          </strong>
          <em>FLEET OPERATIONS</em>
        </div>
      </div>

      <div className="titlebar-center">
        <button className="palette-hint" onClick={onPalette} title="Command palette">
          <Icon name="search" size={13} />
          <span>Jump to anything</span>
          <kbd>Ctrl</kbd>
          <kbd>K</kbd>
        </button>
      </div>

      <div className="titlebar-meta">
        <span className="link-state">
          <i className={`status-dot ${health}`} />
          {health === "online" ? "SECURE LINK" : health.toUpperCase()}
        </span>
        <span className="titlebar-clock">{clock(now)}</span>
        <button className={motion ? "btn icon ghost active" : "btn icon ghost"} onClick={onToggleMotion} title="Toggle effects">
          <Icon name="zap" size={14} />
        </button>
      </div>

      <div className="window-controls">
        <button className="win-btn" onClick={() => bridge.app.window("minimize")} aria-label="Minimize">
          <Icon name="minimize" size={13} />
        </button>
        <button className="win-btn" onClick={() => bridge.app.window("maximize")} aria-label="Maximize">
          <Icon name="maximize" size={11} />
        </button>
        <button className="win-btn danger" onClick={() => bridge.app.window("close")} aria-label="Close">
          <Icon name="close" size={13} />
        </button>
      </div>

      {isMockBridge ? <span className="mock-badge">PREVIEW DATA</span> : null}
    </header>
  );
}
