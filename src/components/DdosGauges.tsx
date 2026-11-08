import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { DdosStatus } from "../../shared/types";
import { ago, cx } from "../lib/format";
import type { Tone } from "./ui";

type HistoryPoint = { t: number; bps: number; pps: number; drops: number };
type MetaItem = { label: string; value: string; tone?: Tone };

const TONES: Record<Tone, { from: string; to: string; glow: string }> = {
  cyan: { from: "#3ef2ff", to: "#1f7fff", glow: "rgba(62,242,255,.42)" },
  violet: { from: "#a78bfa", to: "#6d4dff", glow: "rgba(140,110,255,.4)" },
  green: { from: "#5cffb1", to: "#12b981", glow: "rgba(70,255,176,.34)" },
  amber: { from: "#ffce6b", to: "#ff9d2e", glow: "rgba(255,190,90,.35)" },
  red: { from: "#ff7a92", to: "#ff2d55", glow: "rgba(255,80,110,.36)" },
};

const START = 135;
const SWEEP = 270;
const CX = 120;
const CY = 120;
const R_ZONE = 100;
const R_TRACK = 89;
const R_SECONDARY = 77;
const R_NEEDLE = 82;
const R_LABEL = 75;
const ZONES: Array<{ to: number; tone: Tone }> = [
  { to: 60, tone: "green" },
  { to: 85, tone: "amber" },
  { to: 100, tone: "red" },
];

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function percent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return clamp((value / max) * 100);
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

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 100;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const steps = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  for (const step of steps) {
    const candidate = step * base;
    if (candidate >= value) return candidate;
  }
  return 10 * base;
}

function rateParts(bits: number): { value: string; unit: string } {
  if (!Number.isFinite(bits) || bits <= 0) return { value: "0", unit: "bps" };
  if (bits >= 1e9) return { value: (bits / 1e9).toFixed(2), unit: "Gbps" };
  if (bits >= 1e6) return { value: (bits / 1e6).toFixed(1), unit: "Mbps" };
  if (bits >= 1e3) return { value: (bits / 1e3).toFixed(0), unit: "Kbps" };
  return { value: Math.round(bits).toString(), unit: "bps" };
}

function ppsParts(value: number): { value: string; unit: string } {
  if (!Number.isFinite(value) || value <= 0) return { value: "0", unit: "pps" };
  if (value >= 1e6) return { value: (value / 1e6).toFixed(2), unit: "Mpps" };
  if (value >= 1e3) return { value: (value / 1e3).toFixed(1), unit: "Kpps" };
  return { value: Math.round(value).toString(), unit: "pps" };
}

function fmtRate(bits: number): string {
  const parts = rateParts(bits);
  return `${parts.value} ${parts.unit}`;
}

function fmtPps(value: number): string {
  const parts = ppsParts(value);
  return `${parts.value} ${parts.unit}`;
}

function fmtCount(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: value > 9999 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(Number.isFinite(value) ? value : 0);
}

function usePeak(value: number): number {
  const peak = useRef(0);
  if (value > peak.current) peak.current = value;
  return peak.current;
}

const TICKS = Array.from({ length: 41 }, (_, index) => {
  const value = (index / 40) * 100;
  const angle = START + (SWEEP * value) / 100;
  const major = index % 10 === 0;
  return { value, major, outer: polar(angle, 98), inner: polar(angle, major ? 90 : 94) };
});

const LABELS = [0, 25, 50, 75, 100].map((value) => ({
  value,
  point: polar(START + (SWEEP * value) / 100, R_LABEL),
}));

type DialProps = {
  label: string;
  range: string;
  status: string;
  valuePct: number;
  display: string;
  unit: string;
  detail: string;
  tone: Tone;
  primary?: boolean;
  peakPct?: number;
  markerPct?: number;
  secondaryPct?: number;
  secondaryTone?: Tone;
  meta: MetaItem[];
};

function Dial({
  label,
  range,
  status,
  valuePct,
  display,
  unit,
  detail,
  tone,
  primary = false,
  peakPct,
  markerPct,
  secondaryPct,
  secondaryTone = "violet",
  meta,
}: DialProps) {
  const id = useId().replace(/:/g, "");
  const [animated, setAnimated] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimated(clamp(valuePct)));
    return () => cancelAnimationFrame(frame);
  }, [valuePct]);

  const pct = clamp(animated);
  // The needle and markers are drawn pointing up. Convert the arc's SVG angle
  // (0° = right, 90° = down) into a CSS rotation from that up-pointing base.
  const needleAngle = START - 270 + (SWEEP * pct) / 100;
  const peakAngle = START - 270 + (SWEEP * clamp(peakPct ?? 0)) / 100;
  const markerAngle = START - 270 + (SWEEP * clamp(markerPct ?? 0)) / 100;
  const colors = TONES[tone];
  const secondaryColors = TONES[secondaryTone];
  const hasPeak = peakPct !== undefined && peakPct > 0.4;
  const hasMarker = markerPct !== undefined && markerPct > 0.4;
  const style = {
    "--dial-from": colors.from,
    "--dial-to": colors.to,
    "--dial-glow": colors.glow,
  } as CSSProperties;

  return (
    <section
      className={cx("ddos-dial-card", primary && "primary")}
      style={style}
      role="img"
      aria-label={`${label} ${display} ${unit}. ${detail}`}
    >
      <div className="ddos-dial-head">
        <div>
          <span className="ddos-dial-name">{label}</span>
          <span className="ddos-dial-range">{range}</span>
        </div>
        <span className="ddos-dial-state">{status}</span>
      </div>

      <div className="ddos-dial-face">
        <svg viewBox="0 0 240 240" aria-hidden="true">
          <defs>
            <linearGradient id={`arc-${id}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={colors.from} />
              <stop offset="100%" stopColor={colors.to} />
            </linearGradient>
            <radialGradient id={`bloom-${id}`} cx="50%" cy="45%" r="58%">
              <stop offset="0%" stopColor={colors.from} stopOpacity="0.13" />
              <stop offset="100%" stopColor="#040810" stopOpacity="0" />
            </radialGradient>
            <filter id={`glow-${id}`} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="2.4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <circle className="ddos-dial-bezel" cx={CX} cy={CY} r={107} />
          <circle className="ddos-dial-bloom" cx={CX} cy={CY} r={104} fill={`url(#bloom-${id})`} />
          <circle className="ddos-dial-ring" cx={CX} cy={CY} r={R_TRACK - 15} />
          <circle className="ddos-dial-ring faint" cx={CX} cy={CY} r={R_TRACK - 28} />
          <circle className="ddos-dial-reticle" cx={CX} cy={CY} r={R_TRACK - 21} />

          <path className="ddos-dial-zone-track" d={arcPath(0, 100, R_ZONE)} pathLength={100} />
          {ZONES.map((zone, index) => (
            <path
              key={zone.tone}
              className="ddos-dial-zone"
              d={arcPath(index === 0 ? 0 : ZONES[index - 1].to, zone.to, R_ZONE)}
              stroke={TONES[zone.tone].from}
            />
          ))}
          <path className="ddos-dial-track" d={arcPath(0, 100, R_TRACK)} pathLength={100} />

          {TICKS.map((tick) => (
            <line
              key={tick.value}
              x1={tick.outer.x}
              y1={tick.outer.y}
              x2={tick.inner.x}
              y2={tick.inner.y}
              stroke={colors.from}
              strokeWidth={tick.major ? 1.2 : 0.7}
              opacity={tick.major ? 0.52 : 0.2}
            />
          ))}
          {LABELS.map((labelPoint) => (
            <text
              key={labelPoint.value}
              x={labelPoint.point.x}
              y={labelPoint.point.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="ddos-dial-label"
            >
              {labelPoint.value}
            </text>
          ))}

          <path
            className="ddos-dial-arc"
            d={arcPath(0, 100, R_TRACK)}
            pathLength={100}
            stroke={`url(#arc-${id})`}
            filter={`url(#glow-${id})`}
            style={{ strokeDashoffset: 100 - pct }}
          />

          {secondaryPct !== undefined ? (
            <>
              <path className="ddos-dial-secondary-track" d={arcPath(0, 100, R_SECONDARY)} pathLength={100} />
              <path
                className="ddos-dial-secondary-arc"
                d={arcPath(0, 100, R_SECONDARY)}
                pathLength={100}
                stroke={secondaryColors.from}
                style={{ strokeDashoffset: 100 - clamp(secondaryPct) }}
              />
            </>
          ) : null}

          {hasMarker ? (
            <g transform={`rotate(${markerAngle} ${CX} ${CY})`}>
              <path
                d={`M ${CX - 3.2} ${CY - R_ZONE - 4} L ${CX + 3.2} ${CY - R_ZONE - 4} L ${CX} ${CY - R_ZONE + 4} Z`}
                fill={TONES.red.from}
                opacity="0.9"
              />
            </g>
          ) : null}
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

          <g className="ddos-dial-needle" style={{ transform: `rotate(${needleAngle}deg)` }}>
            <path
              d={`M ${CX - 2.4} ${CY - 5} L ${CX + 2.4} ${CY - 5} L ${CX + 0.7} ${CY - R_NEEDLE} L ${CX - 0.7} ${CY - R_NEEDLE} Z`}
              fill={colors.from}
              filter={`url(#glow-${id})`}
            />
            <line x1={CX} y1={CY + 2} x2={CX} y2={CY + 18} stroke={colors.from} strokeWidth="1" opacity="0.28" />
          </g>
          <circle className="ddos-dial-hub" cx={CX} cy={CY} r="7" />
          <circle cx={CX} cy={CY} r="3.4" fill={colors.from} />
          <circle cx={CX} cy={CY} r="1.4" fill="#050b13" />
        </svg>

        <div className="ddos-dial-center">
          <strong>{display}</strong>
        </div>
      </div>

      <div className="ddos-dial-caption">
        <span>{unit}</span>
        <em>{detail}</em>
      </div>

      <div className="ddos-dial-meta">
        {meta.map((item) => (
          <div key={item.label}>
            <span>{item.label}</span>
            <strong style={item.tone ? { color: TONES[item.tone].from } : undefined}>{item.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

export function DdosGauges({
  status,
  history,
  online,
}: {
  status: DdosStatus;
  history: HistoryPoint[];
  online: boolean;
}) {
  const drops = status.drops;
  const ingressBps = Math.max(0, status.ingressBps);
  const ingressPps = Math.max(0, status.ingressPps);
  const egressBps = Math.max(0, status.egressBps);
  const egressPps = Math.max(0, status.egressPps);
  const dropRate = Math.max(0, drops.rate);
  const offeredPps = Math.max(ingressPps + dropRate, ingressPps, dropRate);
  const mitigationPct = percent(dropRate, offeredPps);
  const passedPps = Math.max(0, offeredPps - dropRate);
  const topSource = [...status.sources].sort((left, right) => right.pps - left.pps)[0];
  const sourceMax = topSource?.pps ?? 0;
  const autoBanPps = status.limits?.autoBanPps ?? 0;
  const conntrackPct = percent(status.conntrack.count, status.conntrack.max);
  const cpuPct = Math.max(0, status.cpuPct);
  const memPct = Math.max(0, status.memPct);
  const loadPct = Math.max(cpuPct, memPct);

  const peakIngressBps = usePeak(Math.max(ingressBps, ...history.map((point) => point.bps)));
  const peakIngressPps = usePeak(Math.max(ingressPps, ...history.map((point) => point.pps)));
  const peakMitigation = usePeak(mitigationPct);
  const peakPressure = usePeak(sourceMax);
  const peakConntrack = usePeak(conntrackPct);
  const peakCpu = usePeak(cpuPct);

  const ingressScale = niceMax(Math.max(100_000, ingressBps * 1.2, peakIngressBps * 1.1));
  const ingressPct = percent(ingressBps, ingressScale);
  const pressureScale = niceMax(Math.max(autoBanPps * 2, sourceMax * 1.15, 100));
  const pressurePct = percent(sourceMax, pressureScale);
  const [ingressValue, ingressUnit] = [rateParts(ingressBps).value, rateParts(ingressBps).unit];
  const pressureParts = ppsParts(sourceMax);
  const conntrackUsed =
    status.conntrack.max <= 0 ? "no table" : conntrackPct < 0.01 ? "<0.01%" : `${conntrackPct.toFixed(2)}%`;

  const mitigationTone: Tone = !online ? "red" : mitigationPct >= 40 ? "red" : mitigationPct > 0 ? "amber" : "green";
  const ingressTone: Tone = !online ? "red" : status.tight ? "amber" : "cyan";
  const pressureTone: Tone = !online
    ? "red"
    : autoBanPps > 0 && sourceMax >= autoBanPps
      ? "red"
      : autoBanPps > 0 && sourceMax >= autoBanPps * 0.6
        ? "amber"
        : "cyan";
  const conntrackTone: Tone = !online ? "red" : conntrackPct >= 85 ? "red" : conntrackPct >= 60 ? "amber" : "green";
  const loadTone: Tone = !online ? "red" : loadPct >= 85 ? "red" : loadPct >= 70 ? "amber" : "green";

  const primaryStatus = !online ? "OFFLINE" : dropRate > 0 ? "MITIGATING" : "ARMED";
  const ingressStatus = !online ? "NO SIGNAL" : "LIVE";
  const pressureStatus = !online
    ? "OFFLINE"
    : autoBanPps > 0 && sourceMax >= autoBanPps
      ? "BAN THRESHOLD"
      : "ARMED";
  const conntrackStatus = !online
    ? "OFFLINE"
    : status.conntrack.max <= 0
      ? "NO TABLE"
      : conntrackPct >= 85
        ? "CRITICAL"
        : conntrackPct >= 60
          ? "ELEVATED"
          : "NOMINAL";
  const loadStatus = !online ? "OFFLINE" : loadPct >= 85 ? "CRITICAL" : loadPct >= 70 ? "ELEVATED" : "NOMINAL";

  const facts = [
    { label: "EGRESS", value: fmtRate(egressBps), hint: fmtPps(egressPps) },
    { label: "DROP RATE", value: fmtPps(dropRate), hint: `${fmtCount(drops.total)} lifetime` },
    { label: "DROP SET", value: `${status.blocked.length}`, hint: `${status.allowlist.length} allowlisted` },
    { label: "SOURCES", value: `${status.sources.length}`, hint: topSource?.ip ?? "none above floor" },
    { label: "INVALID / FRAG", value: fmtCount(drops.invalid), hint: `${fmtCount(drops.fragments ?? 0)} fragments` },
    { label: "POLICY", value: status.autoBan ? "AUTO-BAN" : "MANUAL", hint: autoBanPps > 0 ? `${fmtPps(autoBanPps)} trigger` : "no auto-ban" },
  ];

  return (
    <section className={cx("ddos-telemetry", !online && "is-offline")} aria-label="Live edge mitigation telemetry">
      <div className="ddos-telemetry-head">
        <div className="ddos-telemetry-title">
          <span className="eyebrow">LIVE TELEMETRY</span>
          <div className="ddos-telemetry-name">
            <strong>Mitigation core</strong>
            <span className={cx("ddos-live-badge", online ? "online" : "offline")}>
              <i />
              {online ? "KERNEL ONLINE" : "NO SIGNAL"}
            </span>
            <span className="ddos-telemetry-chip">{status.mode}</span>
            {status.tight ? <span className="ddos-telemetry-chip hot">TIGHT PROFILE</span> : null}
          </div>
          <span className="ddos-telemetry-sub">
            {status.wan || "edge"} · nftables ingress · sampled {ago(status.sampledAt)}
          </span>
        </div>
        <div className="ddos-telemetry-key">
          <span><i className="ddos-zone-dot nominal" /> NOMINAL 0–60</span>
          <span><i className="ddos-zone-dot elevated" /> ELEVATED 60–85</span>
          <span><i className="ddos-zone-dot critical" /> CRITICAL 85–100</span>
        </div>
      </div>

      <div className="ddos-dials">
        <Dial
          primary
          label="MITIGATION"
          range="0–100%"
          status={primaryStatus}
          valuePct={mitigationPct}
          display={mitigationPct.toFixed(1)}
          unit="%"
          detail={dropRate > 0 ? "traffic denied at kernel" : "no mitigation pressure"}
          tone={mitigationTone}
          peakPct={peakMitigation}
          meta={[
            { label: "OFFERED", value: fmtPps(offeredPps) },
            { label: "DENIED", value: fmtPps(dropRate), tone: dropRate > 0 ? "amber" : undefined },
            { label: "PASSED", value: fmtPps(passedPps) },
            { label: "LIFETIME", value: fmtCount(drops.total) },
          ]}
        />
        <Dial
          label="INGRESS"
          range={`0–${fmtRate(ingressScale)}`}
          status={ingressStatus}
          valuePct={ingressPct}
          display={ingressValue}
          unit={ingressUnit}
          detail={`${fmtPps(ingressPps)} · ${ingressPct.toFixed(1)}% of range`}
          tone={ingressTone}
          peakPct={percent(peakIngressBps, ingressScale)}
          meta={[
            { label: "PEAK", value: fmtRate(peakIngressBps) },
            { label: "PKT PEAK", value: fmtPps(peakIngressPps) },
          ]}
        />
        <Dial
          label="SOURCE PRESSURE"
          range={`0–${fmtPps(pressureScale)}`}
          status={pressureStatus}
          valuePct={pressurePct}
          display={pressureParts.value}
          unit={pressureParts.unit}
          detail={topSource?.ip ?? "no active sources"}
          tone={pressureTone}
          peakPct={percent(peakPressure, pressureScale)}
          markerPct={autoBanPps > 0 ? percent(autoBanPps, pressureScale) : undefined}
          meta={[
            { label: "AUTO-BAN", value: autoBanPps > 0 ? fmtPps(autoBanPps) : "off" },
            { label: "SOURCES", value: `${status.sources.length}` },
          ]}
        />
        <Dial
          label="CONNTRACK"
          range="0–100% table"
          status={conntrackStatus}
          valuePct={conntrackPct}
          display={fmtCount(status.conntrack.count)}
          unit="entries"
          detail={status.conntrack.max > 0 ? `of ${fmtCount(status.conntrack.max)} capacity` : "capacity unavailable"}
          tone={conntrackTone}
          peakPct={peakConntrack}
          meta={[
            { label: "USED", value: conntrackUsed },
            { label: "HEADROOM", value: fmtCount(Math.max(0, status.conntrack.max - status.conntrack.count)) },
          ]}
        />
        <Dial
          label="EDGE LOAD"
          range="0–100%"
          status={loadStatus}
          valuePct={cpuPct}
          display={cpuPct.toFixed(1)}
          unit="% CPU"
          detail={`mem ${memPct.toFixed(1)}% · load ${status.load1.toFixed(2)}`}
          tone={loadTone}
          peakPct={peakCpu}
          secondaryPct={memPct}
          secondaryTone="violet"
          meta={[
            { label: "CPU", value: `${cpuPct.toFixed(1)}%`, tone: "cyan" },
            { label: "MEMORY", value: `${memPct.toFixed(1)}%`, tone: "violet" },
          ]}
        />
      </div>

      <div className="ddos-telemetry-facts">
        {facts.map((fact) => (
          <div key={fact.label} className="ddos-fact">
            <span>{fact.label}</span>
            <strong>{fact.value}</strong>
            <em>{fact.hint}</em>
          </div>
        ))}
      </div>

      <div className="ddos-telemetry-legend">
        <span><i className="ddos-zone-dot nominal" /> normal band</span>
        <span><i className="ddos-zone-dot elevated" /> warning band</span>
        <span><i className="ddos-zone-dot critical" /> critical band</span>
        <span className="mono">
          KERNEL PLANE · {status.mode.toUpperCase()} · {status.limits.udpPps.toLocaleString()} PPS BASE
        </span>
      </div>
    </section>
  );
}
