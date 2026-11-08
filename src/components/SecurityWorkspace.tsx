import { useState } from "react";
import { Icon } from "./Icon";
import { SecurityCenter } from "./SecurityCenter";
import { DdosShield } from "./DdosShield";

type Section = "posture" | "ddos";

export function SecurityWorkspace({
  onToast,
  onOpenConnections,
}: {
  onToast: (level: "info" | "warn" | "error" | "ok", title: string, detail?: string) => void;
  onOpenConnections: () => void;
}) {
  const [section, setSection] = useState<Section>("posture");

  return (
    <div className="security-workspace">
      <div className="sec-tabs" role="tablist" aria-label="Security sections">
        <button
          role="tab"
          aria-selected={section === "posture"}
          className={`sec-tab ${section === "posture" ? "active" : ""}`}
          onClick={() => setSection("posture")}
        >
          <Icon name="shield" size={14} />
          <span>Posture</span>
        </button>
        <button
          role="tab"
          aria-selected={section === "ddos"}
          className={`sec-tab ${section === "ddos" ? "active" : ""}`}
          onClick={() => setSection("ddos")}
        >
          <Icon name="activity" size={14} />
          <span>DDoS shield</span>
          <em>edge</em>
        </button>
      </div>
      {section === "posture" ? (
        <SecurityCenter onToast={onToast} />
      ) : (
        <DdosShield onToast={onToast} onOpenConnections={onOpenConnections} />
      )}
    </div>
  );
}
