import { useEffect, useId, useState, type CSSProperties } from "react";
import type { HostSummary, NodeStats } from "../../shared/types";
import { bytes, cx, duration, pct } from "../lib/format";
import { Icon } from "./Icon";
import { Chip, MiniBar, Sparkline, type Tone } from "./ui";

const START = 135;
const SWEEP = 270;
const CX = 120;
const CY = 120;
const R_ZONE = 100;
const R_TRACK = 88;
const R_SECONDARY = 78;
const R_NEEDLE = 82;
const R_LABEL = 72;
const ALERT_PCT = 85;

const DIAL_TONES: Record<Tone, { from: string; to: string; glow: string }> = {
  cyan: { from: "#3ef2ff", to: "#1f7fff", glow: "rgba(62,242,255,.42)" },
  violet: { from: "#a78bfa", to: "#6d4dff", glow: "rgba(140,110,255,.4)" },
  green: { from: "#5cffb1", to: "#12b981", glow: "rgba(70,255,176,.34)" },
  amber: { from: "#ffce6b", to: "#ff9d2e", glow: "rgba(255,190,90,.35)" },
  red: { from: "#ff7a92", to: "#ff2d55", glow: "rgba(255,80,110,.36)" },
};

const ZONES: Array<{ to: number; tone: Tone }> = [
  { to: 70, tone: "green" },
  { to: 85, tone: "amber" },
  { to: 100, tone: "red" },
];

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

const TICKS = Array.from({ length: 41 }, (_, index) => {
  const value = (index / 40) * 100;
  const angle = START + (SWEEP * value) / 100;
  const major = index % 10 === 0;
  return { value, major, outer: polar(angle, 98), inner: polar(angle, major ? 89 : 94) };
});

const LABELS = [0, 25, 50, 75, 100].map((value) => ({
  value,
  point: polar(START + (SWEEP * value) / 100, R_LABEL),
}));

function dialTone(value: number, offline: boolean): Tone {
  if (offline) return "red";
  if (value >= ALERT_PCT) return "red";
  if (value >= 70) return "amber";
  return "cyan";
}

function dialStatus(value: number, offline: boolean): string {
  if (offline) return "OFFLINE";
  if (value >= ALERT_PCT) return "CRITICAL";
  if (value >= 70) return "ELEVATED";
  return "NOMINAL";
}

export function NodeDial({
  value,
  label,
  detail,
  tone,
  status,
  peak,
  secondaryPct,
  secondaryTone = "violet",
  meta,
}: {
  value: number;
  label: string;
  detail: string;
  tone: Tone;
  status: string;
  peak: number;
  secondaryPct?: number;
  secondaryTone?: Tone;
  meta: Array<{ label: string; value: string }>;
}) {
  const id = useId().replace(/:/g, "");
  const [animated, setAnimated] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimated(clamp(value)));
    return () => cancelAnimationFrame(frame);
  }, [value]);

  const pct = clamp(animated);
  const needleAngle = START - 270 + (SWEEP * pct) / 100;
  const peakAngle = START - 270 + (SWEEP * clamp(peak)) / 100;
  const markerAngle = START - 270 + (SWEEP * ALERT_PCT) / 100;
  const colors = DIAL_TONES[tone];
  const secondaryColors = DIAL_TONES[secondaryTone];
  const hasPeak = peak > 0.4;
  const display = value >= 99.95 ? "100" : value.toFixed(1);
  const style = {
    "--dial-from": colors.from,
    "--dial-to": colors.to,
    "--dial-glow": colors.glow,
  } as CSSProperties;

  return (
    <div className="node-dial" style={style} role="img" aria-label={`${label} ${display} percent. ${detail}. Peak ${peak.toFixed(1)} percent. Alert at ${ALERT_PCT} percent.`}>
      <div className="node-dial-head">
        <div>
          <span className="node-dial-name">{label}</span>
          <span className="node-dial-range">0–100%</span>
        </div>
        <span className="node-dial-state">{status}</span>
      </div>

      <div className="node-dial-face">
        <svg viewBox="0 0 240 240" aria-hidden="true">
          <defs>
            <linearGradient id={`node-arc-${id}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={colors.from} />
              <stop offset="100%" stopColor={colors.to} />
            </linearGradient>
            <radialGradient id={`node-bloom-${id}`} cx="50%" cy="45%" r="58%">
              <stop offset="0%" stopColor={colors.from} stopOpacity="0.12" />
              <stop offset="100%" stopColor="#040810" stopOpacity="0" />
            </radialGradient>
            <filter id={`node-glow-${id}`} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="2.4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <circle className="node-dial-bezel" cx={CX} cy={CY} r={107} />
          <circle className="node-dial-bloom" cx={CX} cy={CY} r={104} fill={`url(#node-bloom-${id})`} />
          <circle className="node-dial-ring" cx={CX} cy={CY} r={R_TRACK - 15} />
          <circle className="node-dial-ring faint" cx={CX} cy={CY} r={R_TRACK - 28} />
          <circle className="node-dial-reticle" cx={CX} cy={CY} r={R_TRACK - 21} />

          <path className="node-dial-zone-track" d={arcPath(0, 100, R_ZONE)} pathLength={100} />
          {ZONES.map((zone, index) => (
            <path
              key={zone.tone}
              className="node-dial-zone"
              d={arcPath(index === 0 ? 0 : ZONES[index - 1].to, zone.to, R_ZONE)}
              stroke={DIAL_TONES[zone.tone].from}
            />
          ))}
          <path className="node-dial-track" d={arcPath(0, 100, R_TRACK)} pathLength={100} />

          {TICKS.map((tick) => (
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
          {LABELS.map((labelPoint) => (
            <text
              key={labelPoint.value}
              x={labelPoint.point.x}
              y={labelPoint.point.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="node-dial-label"
            >
              {labelPoint.value}
            </text>
          ))}

          <path
            className="node-dial-arc"
            d={arcPath(0, 100, R_TRACK)}
            pathLength={100}
            stroke={`url(#node-arc-${id})`}
            filter={`url(#node-glow-${id})`}
            style={{ strokeDashoffset: 100 - pct }}
          />

          {secondaryPct !== undefined ? (
            <>
              <path className="node-dial-secondary-track" d={arcPath(0, 100, R_SECONDARY)} pathLength={100} />
              <path
                className="node-dial-secondary-arc"
                d={arcPath(0, 100, R_SECONDARY)}
                pathLength={100}
                stroke={secondaryColors.from}
                style={{ strokeDashoffset: 100 - clamp(secondaryPct) }}
              />
            </>
          ) : null}

          <g transform={`rotate(${markerAngle} ${CX} ${CY})`}>
            <path d={`M ${CX - 3.2} ${CY - R_ZONE - 4} L ${CX + 3.2} ${CY - R_ZONE - 4} L ${CX} ${CY - R_ZONE + 4} Z`} fill={DIAL_TONES.red.from} opacity="0.9" />
          </g>

          {hasPeak ? (
            <g transform={`rotate(${peakAngle} ${CX} ${CY})`}>
              <line
                x1={CX}
                y1={CY - R_ZONE + 2}
                x2={CX}
                y2={CY - R_ZONE - 7}
                stroke={colors.to}
                strokeWidth="1.3"
                opacity="0.85"
              />
              <circle cx={CX} cy={CY - R_ZONE + 2} r="2" fill={colors.to} />
            </g>
          ) : null}

          <g className="node-dial-needle" style={{ transform: `rotate(${needleAngle}deg)` }}>
            <path
              d={`M ${CX - 2.4} ${CY - 5} L ${CX + 2.4} ${CY - 5} L ${CX + 0.7} ${CY - R_NEEDLE} L ${CX - 0.7} ${CY - R_NEEDLE} Z`}
              fill={colors.from}
              filter={`url(#node-glow-${id})`}
            />
            <line x1={CX} y1={CY + 2} x2={CX} y2={CY + 18} stroke={colors.from} strokeWidth="1" opacity="0.28" />
          </g>
          <circle className="node-dial-hub" cx={CX} cy={CY} r="7" />
          <circle cx={CX} cy={CY} r="3.4" fill={colors.from} />
          <circle cx={CX} cy={CY} r="1.4" fill="#050b13" />
        </svg>

        <div className="node-dial-center">
          <strong>{display}</strong>
        </div>
      </div>

      <div className="node-dial-caption">
        <span>%</span>
        <em>{detail}</em>
      </div>

      <div className="node-dial-meta">
        {meta.map((item) => (
          <div key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export function NodeCard({ node, endpoint }: { node: NodeStats; endpoint?: HostSummary }) {
  const cpu = node.cpu * 100;
  const mem = pct(node.memory.used, node.memory.total);
  const maxTemp = node.sensors.length > 0 ? Math.max(...node.sensors.map((sensor) => sensor.value)) : null;
  const net = node.rrd.map((point) => point.netin + point.netout);
  const unhealthy = node.disks.filter((disk) => {
    const health = disk.health.toUpperCase();
    return health && health !== "PASSED" && health !== "UNKNOWN" && health !== "OK";
  });
  const cpuPeak = Math.max(cpu, ...node.rrd.map((point) => point.cpu * 100));
  const memPeak = Math.max(mem, ...node.rrd.map((point) => pct(point.mem, node.memory.total)));
  const loadPct = node.cores > 0 ? (node.loadavg[0] / node.cores) * 100 : 0;
  const swapPct = node.swap.total > 0 ? pct(node.swap.used, node.swap.total) : 0;
  const offline = node.status !== "online";

  return (
    <article
      className="node-card"
      data-spot
      style={{ "--node-accent": endpoint?.color ?? "#3ef2ff" } as CSSProperties}
    >
      <div className="node-head">
        <div className="node-id">
          <span className="node-glyph">
            <i />
          </span>
          <div>
            <h3>{node.node}</h3>
            <p title={node.model}>
              {node.model} · {node.cores} threads
            </p>
          </div>
        </div>
        <div className="node-badges">
          <Chip tone={node.status === "online" ? "ok" : "err"} dot>
            {node.status}
          </Chip>
          <span className="mono subtle">PVE {node.pveVersion || "—"}</span>
        </div>
      </div>

      {endpoint ? (
        <div className="node-endpoint-line" title={endpoint.baseUrl}>
          <span className="host-color" style={{ background: endpoint.color }} />
          <span>{endpoint.label}</span>
          <em>· {endpoint.baseUrl.replace(/^https?:\/\//, "")}</em>
        </div>
      ) : null}

      <div className="node-gauges">
        <NodeDial
          value={cpu}
          label="CPU"
          detail={`${node.loadavg[0]?.toFixed(2) ?? "0.00"} load`}
          tone={dialTone(cpu, offline)}
          status={dialStatus(cpu, offline)}
          peak={cpuPeak}
          secondaryPct={loadPct}
          meta={[
            { label: "PEAK", value: `${cpuPeak.toFixed(1)}%` },
            { label: "LOAD", value: node.loadavg[0]?.toFixed(2) ?? "0.00" },
          ]}
        />
        <NodeDial
          value={mem}
          label="MEMORY"
          detail={`${bytes(node.memory.used)} / ${bytes(node.memory.total)}`}
          tone={dialTone(mem, offline)}
          status={dialStatus(mem, offline)}
          peak={memPeak}
          secondaryPct={swapPct}
          meta={[
            { label: "PEAK", value: `${memPeak.toFixed(1)}%` },
            { label: "SWAP", value: node.swap.total > 0 ? `${swapPct.toFixed(0)}%` : "—" },
          ]}
        />
        <div className="node-facts">
          <div>
            <span>Uptime</span>
            <strong>{duration(node.uptime)}</strong>
          </div>
          <div>
            <span>Guests</span>
            <strong>
              {node.runningCount}
              <em>/{node.vmCount}</em>
            </strong>
          </div>
          <div>
            <span>Load 1·5·15</span>
            <strong className="mono">
              {node.loadavg.length > 0 ? node.loadavg.map((value) => value.toFixed(2)).join(" · ") : "—"}
            </strong>
          </div>
          <div>
            <span>Package temp</span>
            <strong className={maxTemp && maxTemp > 75 ? "warn-text" : ""}>{maxTemp ? `${Math.round(maxTemp)}°C` : "—"}</strong>
          </div>
          <div className="node-net">
            <span>Network in/out</span>
            <Sparkline data={net.length > 1 ? net : [0, 0]} width={148} height={30} tone="violet" strokeWidth={1.2} />
          </div>
        </div>
      </div>

      <div className="node-storage">
        {node.storages.slice(0, 3).map((storage) => {
          const usage = pct(storage.used, storage.total);
          return (
            <div className="storage-row" key={storage.storage}>
              <span className="storage-name">
                <Icon name="database" size={12} /> {storage.storage}
              </span>
              <MiniBar value={usage} tone={usage > 85 ? "red" : usage > 70 ? "amber" : "cyan"} />
              <span className={cx("mono", usage > 85 && "warn-text")}>{Math.round(usage)}%</span>
              <span className="mono subtle">{bytes(storage.avail)} free</span>
            </div>
          );
        })}
        {node.storages.length === 0 ? <span className="subtle">No storage reported (permission or inactive pools)</span> : null}
      </div>

      <div className="node-foot">
        <span>
          <Icon name="cpu" size={12} /> {node.sockets} socket{node.sockets === 1 ? "" : "s"} @ {node.mhz ? `${node.mhz} MHz` : "—"}
        </span>
        <span>
          <Icon name="disk" size={12} /> {node.disks.length} disk{node.disks.length === 1 ? "" : "s"}
          {unhealthy.length > 0 ? <em className="warn-text"> · {unhealthy.length} degraded</em> : null}
        </span>
        <span className="mono">{node.latencyMs} ms</span>
      </div>
    </article>
  );
}
