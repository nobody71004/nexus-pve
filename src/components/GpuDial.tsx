import { useEffect, useId, useState, type CSSProperties, type FormEvent } from "react";
import type { GpuAlertThresholds, GpuInfo, GpuTelemetry } from "../../shared/types";
import { evaluateGpuAlerts, gpuPowerPct, gpuVramPct } from "../../shared/gpu-alerts";
import { bytes, cx } from "../lib/format";
import { saveGpuAlerts, useGpuAlerts } from "../lib/gpuAlerts";
import { Icon } from "./Icon";
import { Sparkline, type Tone } from "./ui";

const START = 135;
const SWEEP = 270;
const CX = 120;
const CY = 120;
const R_TEMP = 102;
const R_UTIL = 88;
const R_VRAM = 76;
const R_LABEL = 62;

const TONES: Record<Tone, { from: string; to: string; glow: string }> = {
  cyan: { from: "#3ef2ff", to: "#1f7fff", glow: "rgba(62,242,255,.42)" },
  violet: { from: "#a78bfa", to: "#6d4dff", glow: "rgba(140,110,255,.4)" },
  green: { from: "#5cffb1", to: "#12b981", glow: "rgba(70,255,176,.34)" },
  amber: { from: "#ffce6b", to: "#ff9d2e", glow: "rgba(255,190,90,.35)" },
  red: { from: "#ff7a92", to: "#ff2d55", glow: "rgba(255,80,110,.36)" },
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function polar(angle: number, radius: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  return { x: CX + radius * Math.cos(radians), y: CY + radius * Math.sin(radians) };
}

function arcPath(from: number, to: number, radius: number): string {
  const start = polar(START + (SWEEP * from) / 100, radius);
  const end = polar(START + (SWEEP * to) / 100, radius);
  const large = (SWEEP * (to - from)) / 100 > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function toneFor(value: number | undefined, offline = false): Tone {
  if (offline) return "red";
  if (value === undefined) return "cyan";
  if (value >= 85) return "red";
  if (value >= 70) return "amber";
  return "cyan";
}

function tempTone(value: number | undefined, alertC: number): Tone {
  if (value === undefined) return "cyan";
  if (value >= alertC) return "red";
  if (value >= alertC - 15) return "amber";
  if (value >= alertC - 30) return "violet";
  return "green";
}

function tempStatus(value: number | undefined, alertC: number): string {
  if (value === undefined) return "NO SENSOR";
  if (value >= alertC) return "HOT";
  if (value >= alertC - 15) return "WARM";
  return "NOMINAL";
}

function num(value: number | undefined, digits = 0): string {
  return value === undefined ? "—" : value.toFixed(digits);
}

function sourceLabel(source: GpuTelemetry["source"]): string {
  if (source === "nvidia-smi") return "NVIDIA · nvidia-smi";
  if (source === "amdgpu-sysfs") return "AMD · amdgpu sysfs";
  return "INVENTORY · no telemetry";
}

function GpuHistoryTile({
  label,
  unit,
  digits,
  data,
  current,
  tone,
}: {
  label: string;
  unit: string;
  digits: number;
  data: number[];
  current: number | undefined;
  tone: Tone;
}) {
  const samples = data.slice(-120);
  const min = samples.length > 0 ? Math.min(...samples) : undefined;
  const max = samples.length > 0 ? Math.max(...samples) : undefined;
  return (
    <div className="gpu-history-tile">
      <div className="gpu-history-head">
        <span>{label} HISTORY</span>
        <strong className="mono">{current === undefined ? "—" : `${current.toFixed(digits)}${unit}`}</strong>
      </div>
      {samples.length > 1 ? (
        <Sparkline data={samples} width={240} height={34} tone={tone} strokeWidth={1.2} />
      ) : (
        <div className="gpu-history-empty">
          {samples.length === 1 ? "collecting samples…" : "awaiting telemetry"}
        </div>
      )}
      <div className="gpu-history-foot">
        <span>{samples.length} sample{samples.length === 1 ? "" : "s"}</span>
        <span className="mono">
          {min === undefined || max === undefined ? "—" : `${min.toFixed(digits)}–${max.toFixed(digits)}${unit}`}
        </span>
      </div>
    </div>
  );
}

function GpuAlertSettings({ thresholds }: { thresholds: GpuAlertThresholds }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<GpuAlertThresholds>(thresholds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(thresholds), [thresholds]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (Object.values(draft).some((value) => !Number.isFinite(value))) {
      setError("Enter a number for every limit.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveGpuAlerts(draft);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof GpuAlertThresholds, label: string, unit: string, min: number, max: number) => (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={draft[key]}
        onChange={(event) => setDraft((current) => ({ ...current, [key]: Number(event.target.value) }))}
      />
      <em>{unit}</em>
    </label>
  );

  return (
    <div className="gpu-alert-settings">
      <button
        type="button"
        className={cx("gpu-alert-toggle", open && "active")}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="settings" size={11} />
        <span>ALERT LIMITS</span>
        <em className="mono">
          {thresholds.temperatureC}°C ×{thresholds.temperatureSamples} · {thresholds.powerPct}% power · {thresholds.vramPct}% VRAM
        </em>
      </button>
      {open ? (
        <form className="gpu-alert-form" onSubmit={save}>
          {field("temperatureC", "TEMPERATURE", "°C", 30, 110)}
          {field("temperatureSamples", "SAMPLES", "consecutive", 2, 20)}
          {field("powerPct", "POWER", "% limit", 10, 100)}
          {field("vramPct", "VRAM", "% used", 10, 100)}
          <div className="gpu-alert-form-actions">
            {error ? <span className="warn-text">{error}</span> : null}
            <button
              type="button"
              className="gpu-alert-cancel"
              onClick={() => {
                setDraft(thresholds);
                setError(null);
                setOpen(false);
              }}
            >
              Cancel
            </button>
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save limits"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function GpuDial({ gpu, thresholds }: { gpu: GpuTelemetry; thresholds: GpuAlertThresholds }) {
  const id = useId().replace(/:/g, "");
  const [animated, setAnimated] = useState(0);
  const util = gpu.utilization;
  const temp = gpu.temperatureC;
  const vramPct = gpuVramPct(gpu);
  const powerPct = gpuPowerPct(gpu);
  const alerts = evaluateGpuAlerts(gpu, thresholds);
  const tone = toneFor(util, gpu.source === "inventory");
  const thermalTone = tempTone(temp, thresholds.temperatureC);
  const colors = TONES[tone];
  const thermalColors = TONES[thermalTone];
  const vramColors = TONES.violet;
  const hasTelemetry = util !== undefined;
  const display = util === undefined ? "—" : util >= 99.95 ? "100" : util.toFixed(0);
  const style = {
    "--gpu-from": colors.from,
    "--gpu-to": colors.to,
    "--gpu-glow": colors.glow,
    "--gpu-thermal": thermalColors.from,
  } as CSSProperties;

  useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimated(clamp(util ?? 0)));
    return () => cancelAnimationFrame(frame);
  }, [util]);

  const ticks = Array.from({ length: 21 }, (_, index) => {
    const value = index * 5;
    const angle = START + (SWEEP * value) / 100;
    const major = value % 25 === 0;
    return { value, major, outer: polar(angle, 97), inner: polar(angle, major ? 89 : 94) };
  });
  const labels = [0, 25, 50, 75, 100].map((value) => ({
    value,
    point: polar(START + (SWEEP * value) / 100, R_LABEL),
  }));

  return (
    <div className="gpu-dial" style={style}>
      <div className="gpu-dial-svg-wrap">
        <svg viewBox="0 0 240 240" className="gpu-dial-svg" role="img" aria-label={`${gpu.name}. Utilization ${display} percent. Temperature ${num(temp, 1)} degrees Celsius.`}>
          <defs>
            <linearGradient id={`gpu-arc-${id}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={colors.from} />
              <stop offset="100%" stopColor={colors.to} />
            </linearGradient>
            <radialGradient id={`gpu-bloom-${id}`} cx="50%" cy="44%" r="58%">
              <stop offset="0%" stopColor={colors.from} stopOpacity="0.12" />
              <stop offset="100%" stopColor="#040810" stopOpacity="0" />
            </radialGradient>
            <filter id={`gpu-glow-${id}`} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="2.4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <circle className="gpu-dial-bezel" cx={CX} cy={CY} r={111} />
          <circle className="gpu-dial-bloom" cx={CX} cy={CY} r={107} fill={`url(#gpu-bloom-${id})`} />
          <circle className="gpu-dial-ring" cx={CX} cy={CY} r={91} />
          <circle className="gpu-dial-ring faint" cx={CX} cy={CY} r={84} />
          <circle className="gpu-dial-reticle" cx={CX} cy={CY} r={69} />

          <path className="gpu-dial-temp-track" d={arcPath(0, 100, R_TEMP)} pathLength={100} />
          {temp !== undefined ? (
            <path
              className="gpu-dial-temp-arc"
              d={arcPath(0, 100, R_TEMP)}
              pathLength={100}
              stroke={thermalColors.from}
              style={{ strokeDashoffset: 100 - clamp(temp) }}
            />
          ) : null}

          <path className="gpu-dial-track" d={arcPath(0, 100, R_UTIL)} pathLength={100} />
          {ticks.map((tick) => (
            <line
              key={tick.value}
              x1={tick.outer.x}
              y1={tick.outer.y}
              x2={tick.inner.x}
              y2={tick.inner.y}
              stroke={colors.from}
              strokeWidth={tick.major ? 1.2 : 0.7}
              opacity={tick.major ? 0.5 : 0.2}
            />
          ))}
          {labels.map((label) => (
            <text
              key={label.value}
              x={label.point.x}
              y={label.point.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="gpu-dial-label"
            >
              {label.value}
            </text>
          ))}

          <path
            className="gpu-dial-arc"
            d={arcPath(0, 100, R_UTIL)}
            pathLength={100}
            stroke={`url(#gpu-arc-${id})`}
            filter={hasTelemetry ? `url(#gpu-glow-${id})` : undefined}
            style={{ strokeDashoffset: 100 - (hasTelemetry ? animated : 0), opacity: hasTelemetry ? 1 : 0.2 }}
          />

          <path className="gpu-dial-vram-track" d={arcPath(0, 100, R_VRAM)} pathLength={100} />
          {vramPct !== undefined ? (
            <path
              className="gpu-dial-vram-arc"
              d={arcPath(0, 100, R_VRAM)}
              pathLength={100}
              stroke={vramColors.from}
              style={{ strokeDashoffset: 100 - clamp(vramPct) }}
            />
          ) : null}

          <g transform={`rotate(${START - 270 + (SWEEP * clamp(thresholds.temperatureC)) / 100} ${CX} ${CY})`}>
            <path d={`M ${CX - 3.4} ${CY - R_TEMP - 5} L ${CX + 3.4} ${CY - R_TEMP - 5} L ${CX} ${CY - R_TEMP + 4} Z`} fill={TONES.red.from} opacity="0.9" />
          </g>
          {temp !== undefined ? (
            <g transform={`rotate(${START - 270 + (SWEEP * clamp(temp)) / 100} ${CX} ${CY})`}>
              <circle cx={CX} cy={CY - R_TEMP} r="3.1" fill={thermalColors.from} filter={`url(#gpu-glow-${id})`} />
            </g>
          ) : null}

          <circle className="gpu-dial-hub" cx={CX} cy={CY} r="9" />
          <circle cx={CX} cy={CY} r="4" fill={colors.from} />
          <circle cx={CX} cy={CY} r="1.5" fill="#050b13" />
        </svg>

        <div className="gpu-dial-center">
          <strong>{display}</strong>
          <span>% UTIL</span>
          <em className={cx(temp !== undefined && alerts.temperature && "warn-text")}>{temp === undefined ? "NO TEMP" : `${temp.toFixed(1)}°C`}</em>
        </div>
      </div>

      <div className="gpu-dial-legend">
        <span><i className="gpu-legend-util" /> utilization</span>
        <span><i className="gpu-legend-vram" /> VRAM {vramPct === undefined ? "—" : `${vramPct.toFixed(0)}%`}</span>
        <span><i className="gpu-legend-temp" /> temp {temp === undefined ? "—" : `${temp.toFixed(0)}°C`}</span>
      </div>

      <div className="gpu-meters">
        <div className="gpu-meter-row">
          <span>UTIL</span>
          <div className="gpu-meter"><i style={{ width: `${hasTelemetry ? clamp(animated) : 0}%` }} /></div>
          <b className="mono">{util === undefined ? "—" : `${util.toFixed(0)}%`}</b>
        </div>
        <div className="gpu-meter-row">
          <span>VRAM</span>
          <div className={cx("gpu-meter violet", alerts.vram && "alert")}><i style={{ width: `${clamp(vramPct ?? 0)}%` }} /></div>
          <b className={cx("mono", alerts.vram && "warn-text")}>{vramPct === undefined ? "—" : `${vramPct.toFixed(0)}%`}</b>
        </div>
        <div className="gpu-meter-row">
          <span>POWER</span>
          <div className={cx("gpu-meter amber", alerts.power && "alert")}><i style={{ width: `${clamp(powerPct ?? 0)}%` }} /></div>
          <b className={cx("mono", alerts.power && "warn-text")}>{gpu.powerW === undefined ? "—" : `${gpu.powerW.toFixed(0)}W`}</b>
        </div>
      </div>
    </div>
  );
}

export function GpuTelemetryPanel({
  gpus,
  error,
  inventory = [],
  source,
  className,
}: {
  gpus: GpuTelemetry[];
  error?: string;
  inventory?: GpuInfo[];
  source?: string;
  className?: string;
}) {
  const [selected, setSelected] = useState(0);
  const thresholds = useGpuAlerts();
  const active = gpus[Math.min(selected, Math.max(0, gpus.length - 1))];
  const activeVram = active ? gpuVramPct(active) : undefined;
  const activePower = active ? gpuPowerPct(active) : undefined;
  const activeAlerts = active ? evaluateGpuAlerts(active, thresholds) : null;
  const alertChips: Array<{ key: string; text: string }> = [];
  if (active && activeAlerts) {
    if (activeAlerts.temperature && active.temperatureC !== undefined) {
      alertChips.push({
        key: "temp",
        text: `TEMP ${active.temperatureC.toFixed(1)}°C ≥ ${thresholds.temperatureC}°C · ${activeAlerts.temperatureStreak} samples`,
      });
    }
    if (activeAlerts.power && activePower !== undefined) {
      alertChips.push({ key: "power", text: `POWER ${activePower.toFixed(0)}% ≥ ${thresholds.powerPct}%` });
    }
    if (activeAlerts.vram && activeVram !== undefined) {
      alertChips.push({ key: "vram", text: `VRAM ${activeVram.toFixed(0)}% ≥ ${thresholds.vramPct}%` });
    }
  }

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, gpus.length - 1)));
  }, [gpus.length]);

  if (gpus.length === 0 && inventory.length === 0 && !error) return null;

  const count = gpus.length || inventory.length;
  const heading = gpus.length
    ? `${count} GPU${count === 1 ? "" : "s"} · live telemetry`
    : `${count} GPU${count === 1 ? "" : "s"} detected`;

  return (
    <section className={cx("gpu-panel", className)}>
      <div className="gpu-panel-head">
        <div className="gpu-panel-heading">
          <span className="gpu-panel-kicker">
            <Icon name="cpu" size={12} /> GPU CONTROL
          </span>
          <strong>{heading}</strong>
        </div>
        <div className="gpu-panel-meta">
          {source ? <span title={source}>via {source}</span> : null}
          {active ? <span className={cx("gpu-panel-source", active.source === "inventory" && "inventory")}>{sourceLabel(active.source)}</span> : null}
        </div>
      </div>

      {gpus.length > 1 ? (
        <div className="gpu-tabs" role="tablist" aria-label="GPU selection">
          {gpus.map((gpu, index) => (
            <button
              key={gpu.id}
              type="button"
              role="tab"
              aria-selected={index === selected}
              className={cx("gpu-tab", index === selected && "active")}
              onClick={() => setSelected(index)}
              title={gpu.name}
            >
              <span>GPU {gpu.index}</span>
              <em>{gpu.name}</em>
              <b className="mono">{gpu.utilization === undefined ? "—" : `${gpu.utilization.toFixed(0)}%`}</b>
            </button>
          ))}
        </div>
      ) : null}

      {active ? (
        <>
          <div className="gpu-active-name">
            <span className="gpu-active-index">{active.source === "inventory" ? "INVENTORY" : `GPU ${active.index}`}</span>
            <strong title={active.name}>{active.name}</strong>
            <span className="gpu-active-temp" title="GPU edge temperature">
              <i className={cx("gpu-temp-dot", tempTone(active.temperatureC, thresholds.temperatureC))} />
              {active.temperatureC === undefined ? "no temp sensor" : `${active.temperatureC.toFixed(1)}°C · ${tempStatus(active.temperatureC, thresholds.temperatureC)}`}
            </span>
          </div>

          {alertChips.length > 0 ? (
            <div className="gpu-alert-chips" role="status" aria-label="Sustained GPU alert thresholds exceeded">
              {alertChips.map((chip) => (
                <span className="gpu-alert-chip" key={chip.key}>
                  <span aria-hidden="true">!</span> {chip.text}
                </span>
              ))}
            </div>
          ) : null}

          <div className="gpu-dial-layout">
            <GpuDial gpu={active} thresholds={thresholds} />
            <div className="gpu-readouts">
              <div className="gpu-stat-grid">
                <div className="gpu-stat">
                  <span>TEMP</span>
                  <strong className={cx("mono", activeAlerts?.temperature && "warn-text")}>
                    {active.temperatureC === undefined ? "—" : `${active.temperatureC.toFixed(1)}°C`}
                  </strong>
                  <em className={cx(activeAlerts?.temperature && "warn-text")}>
                    {active.temperatureC === undefined
                      ? "not exposed"
                      : activeAlerts?.temperature
                        ? `${activeAlerts.temperatureStreak} samples · sustained`
                        : `${tempStatus(active.temperatureC, thresholds.temperatureC)} · ${activeAlerts?.temperatureStreak ?? 0}/${thresholds.temperatureSamples}`}
                  </em>
                </div>
                <div className="gpu-stat">
                  <span>HOTSPOT</span>
                  <strong className="mono">{active.hotspotC === undefined ? "—" : `${active.hotspotC.toFixed(1)}°C`}</strong>
                  <em>{active.hotspotC === undefined ? "not exposed" : "junction"}</em>
                </div>
                <div className="gpu-stat">
                  <span>MEM TEMP</span>
                  <strong className="mono">{active.memoryTemperatureC === undefined ? "—" : `${active.memoryTemperatureC.toFixed(1)}°C`}</strong>
                  <em>{active.memoryTemperatureC === undefined ? "not exposed" : "VRAM"}</em>
                </div>
                <div className="gpu-stat">
                  <span>VRAM</span>
                  <strong className={cx("mono", activeAlerts?.vram && "warn-text")}>
                    {active.memoryUsed === undefined ? "—" : bytes(active.memoryUsed)}
                    {active.memoryTotal ? <small> / {bytes(active.memoryTotal)}</small> : null}
                  </strong>
                  <em className={cx(activeAlerts?.vram && "warn-text")}>{activeVram === undefined ? "usage unknown" : `${activeVram.toFixed(0)}% used`}</em>
                </div>
                <div className="gpu-stat">
                  <span>POWER</span>
                  <strong className={cx("mono", activeAlerts?.power && "warn-text")}>{active.powerW === undefined ? "—" : `${active.powerW.toFixed(0)} W`}</strong>
                  <em className={cx(activeAlerts?.power && "warn-text")}>{active.powerLimitW === undefined ? "limit unknown" : `limit ${active.powerLimitW.toFixed(0)} W`}</em>
                </div>
                <div className="gpu-stat">
                  <span>FAN</span>
                  <strong className="mono">{active.fanPercent === undefined ? "—" : `${active.fanPercent.toFixed(0)}%`}</strong>
                  <em>{active.fanRpm === undefined ? "rpm unknown" : `${active.fanRpm.toFixed(0)} rpm`}</em>
                </div>
                <div className="gpu-stat">
                  <span>SM CLOCK</span>
                  <strong className="mono">{active.clockMhz === undefined ? "—" : `${active.clockMhz.toFixed(0)} MHz`}</strong>
                  <em>{active.memoryClockMhz === undefined ? "core clock" : `mem ${active.memoryClockMhz.toFixed(0)} MHz`}</em>
                </div>
                <div className="gpu-stat">
                  <span>PCIE / P-STATE</span>
                  <strong className="mono">
                    {active.pcieGeneration === undefined ? "—" : `Gen${active.pcieGeneration}`}
                    {active.pcieWidth === undefined ? "" : ` ×${active.pcieWidth}`}
                  </strong>
                  <em>{active.pstate ?? "no p-state"}</em>
                </div>
                <div className="gpu-stat">
                  <span>DRIVER</span>
                  <strong className="mono">{active.driver ?? "—"}</strong>
                  <em>{active.pci ?? "PCI address unavailable"}</em>
                </div>
                <div className="gpu-stat">
                  <span>PROCESSES</span>
                  <strong className="mono">{active.processes?.length ?? 0}</strong>
                  <em>{active.processes?.length ? "compute workloads" : "none reported"}</em>
                </div>
              </div>

              {active.processes?.length ? (
                <div className="gpu-processes">
                  <span className="gpu-processes-title">COMPUTE PROCESSES</span>
                  <div className="gpu-processes-list">
                    {active.processes.slice(0, 3).map((process, index) => (
                      <div key={`${process.pid ?? "pid"}-${process.name}-${index}`} className="gpu-process">
                        <span className="mono">{process.pid === undefined ? "pid —" : `pid ${process.pid}`}</span>
                        <strong title={process.name}>{process.name}</strong>
                        <em className="mono">{process.memoryUsed === undefined ? "—" : bytes(process.memoryUsed)}</em>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {active.source !== "inventory" ? (
            <div className="gpu-history">
              <GpuHistoryTile
                label="UTILIZATION"
                unit="%"
                digits={0}
                data={active.history?.utilization ?? []}
                current={active.utilization}
                tone={toneFor(active.utilization)}
              />
              <GpuHistoryTile
                label="TEMPERATURE"
                unit="°C"
                digits={1}
                data={active.history?.temperatureC ?? []}
                current={active.temperatureC}
                tone={tempTone(active.temperatureC, thresholds.temperatureC)}
              />
            </div>
          ) : null}

          <GpuAlertSettings thresholds={thresholds} />

          {active.error ? <p className="gpu-panel-error">{active.error}</p> : null}
        </>
      ) : (
        <div className="gpu-empty">
          <Icon name="cpu" size={18} />
          <div>
            <strong>{inventory.length ? "GPU inventory only" : "No live GPU telemetry"}</strong>
            {inventory.length ? (
              <div className="gpu-inventory">
                {inventory.map((gpu) => (
                  <span key={`${gpu.pci}-${gpu.device}`}>
                    <strong>{gpu.name}</strong>
                    <em className="mono">{gpu.pci}</em>
                  </span>
                ))}
              </div>
            ) : null}
            <p>{error ?? "The host did not report a supported NVIDIA or AMD GPU."}</p>
          </div>
        </div>
      )}

      {error && active && !active.error ? <p className="gpu-panel-error">{error}</p> : null}
    </section>
  );
}
