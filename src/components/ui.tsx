import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../lib/format";
import { Icon, type IconName } from "./Icon";

/* ------------------------------------------------------------------ gauge */

export type Tone = "cyan" | "violet" | "green" | "amber" | "red";

const TONES: Record<Tone, { from: string; to: string; glow: string }> = {
  cyan: { from: "#3ef2ff", to: "#1f7fff", glow: "rgba(62,242,255,.42)" },
  violet: { from: "#a78bfa", to: "#6d4dff", glow: "rgba(140,110,255,.4)" },
  green: { from: "#5cffb1", to: "#12b981", glow: "rgba(70,255,176,.34)" },
  amber: { from: "#ffce6b", to: "#ff9d2e", glow: "rgba(255,190,90,.35)" },
  red: { from: "#ff7a92", to: "#ff2d55", glow: "rgba(255,80,110,.36)" },
};

export function toneFor(value: number): Tone {
  if (value >= 90) return "red";
  if (value >= 75) return "amber";
  return "cyan";
}

export function Gauge({
  value,
  label,
  detail,
  tone = "cyan",
  size = 132,
  compact = false,
}: {
  value: number;
  label: string;
  detail?: string;
  tone?: Tone;
  size?: number;
  compact?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const [animated, setAnimated] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimated(value));
    return () => cancelAnimationFrame(frame);
  }, [value]);
  const radius = size / 2 - 9;
  const circumference = 2 * Math.PI * radius;
  const colors = TONES[tone];
  return (
    <div className={cx("gauge", compact && "compact")} style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id={`g-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={colors.from} />
            <stop offset="100%" stopColor={colors.to} />
          </linearGradient>
          <filter id={`f-${id}`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,.07)"
          strokeWidth={7}
          strokeDasharray={`${circumference * 0.76} ${circumference}`}
          strokeLinecap="round"
          transform={`rotate(133 ${size / 2} ${size / 2})`}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#g-${id})`}
          strokeWidth={7}
          strokeLinecap="round"
          strokeDasharray={`${(circumference * 0.76 * Math.min(100, animated)) / 100} ${circumference}`}
          transform={`rotate(133 ${size / 2} ${size / 2})`}
          filter={`url(#f-${id})`}
          style={{ transition: "stroke-dasharray 900ms cubic-bezier(.22,1,.36,1)" }}
        />
        <circle cx={size / 2} cy={size / 2} r={radius - 14} fill="rgba(255,255,255,.018)" />
      </svg>
      <div className="gauge-center">
        <strong>{Math.round(value)}<small>%</small></strong>
        <span>{label}</span>
        {detail ? <em>{detail}</em> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- sparkline */

export function Sparkline({
  data,
  width = 180,
  height = 46,
  tone = "cyan",
  fill = true,
  strokeWidth = 1.6,
}: {
  data: number[];
  width?: number;
  height?: number;
  tone?: Tone;
  fill?: boolean;
  strokeWidth?: number;
}) {
  const id = useId().replace(/:/g, "");
  const colors = TONES[tone];
  const path = useMemo(() => {
    if (data.length < 2) return { line: "", area: "" };
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    const step = width / (data.length - 1);
    const points = data.map((value, index) => ({
      x: index * step,
      y: height - 3 - ((value - min) / span) * (height - 8),
    }));
    let line = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const midX = (previous.x + current.x) / 2;
      line += ` Q ${midX.toFixed(2)} ${previous.y.toFixed(2)} ${current.x.toFixed(2)} ${current.y.toFixed(2)}`;
    }
    const area = `${line} L ${width} ${height} L 0 ${height} Z`;
    return { line, area };
  }, [data, width, height]);

  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`s-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colors.from} stopOpacity="0.34" />
          <stop offset="100%" stopColor={colors.from} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill ? <path d={path.area} fill={`url(#s-${id})`} /> : null}
      <path d={path.line} fill="none" stroke={colors.from} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ panel */

export function Panel({
  title,
  eyebrow,
  actions,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={cx("panel", className)}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
            {title ? <h2>{title}</h2> : null}
          </div>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </header>
      )}
      <div className={cx("panel-body", flush && "flush")}>{children}</div>
    </section>
  );
}

/* --------------------------------------------------------------- stat tile */

export function StatTile({
  label,
  value,
  unit,
  hint,
  tone = "cyan",
  icon,
  data,
}: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  tone?: Tone;
  icon?: IconName;
  data?: number[];
}) {
  return (
    <div className={cx("stat-tile", `tone-${tone}`)} data-spot>
      <div className="stat-head">
        <span className="stat-label">{label}</span>
        {icon ? (
          <span className="stat-icon">
            <Icon name={icon} size={14} />
          </span>
        ) : null}
      </div>
      <div className="stat-value">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {data && data.length > 1 ? <Sparkline data={data} width={220} height={34} tone={tone} /> : null}
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ chips */

export function Chip({
  children,
  tone = "muted",
  dot,
}: {
  children: ReactNode;
  tone?: "muted" | "ok" | "warn" | "err" | "info" | "violet";
  dot?: boolean;
}) {
  return (
    <span className={cx("chip", `chip-${tone}`)}>
      {dot ? <i className="dot" /> : null}
      {children}
    </span>
  );
}

export function StatusDot({
  state,
}: {
  state: "running" | "stopped" | "paused" | "online" | "offline" | "degraded" | "connecting";
}) {
  return <span className={cx("status-dot", state)} />;
}

export function MiniBar({ value, tone = "cyan" }: { value: number; tone?: Tone }) {
  return (
    <span className={cx("mini-bar", `tone-${tone}`)}>
      <span style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </span>
  );
}

/* ------------------------------------------------------------------ modal */

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 560,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-content">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- toasts */

export interface ToastItem {
  id: string;
  level: "info" | "ok" | "warn" | "error";
  title: string;
  detail?: string;
}

export function Toasts({ items, dismiss }: { items: ToastItem[]; dismiss: (id: string) => void }) {
  return (
    <div className="toasts">
      {items.map((item) => (
        <div key={item.id} className={cx("toast", item.level)}>
          <span className="toast-mark">
            <Icon name={item.level === "error" ? "alert" : item.level === "ok" ? "check" : "zap"} size={14} />
          </span>
          <div>
            <strong>{item.title}</strong>
            {item.detail ? <p>{item.detail}</p> : null}
          </div>
          <button className="toast-close" onClick={() => dismiss(item.id)} aria-label="Dismiss">
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- skeleton */

export function Skeleton({ height = 120 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} />;
}
