import type {
  GpuAlertOverrides,
  GpuAlertThresholdOverride,
  GpuAlertThresholds,
  GpuTelemetry,
} from "./types";

export const DEFAULT_GPU_ALERTS: GpuAlertThresholds = {
  temperatureC: 85,
  temperatureSamples: 3,
  powerPct: 90,
  vramPct: 90,
};

export const GPU_ALERT_LIMITS: Record<keyof GpuAlertThresholds, { min: number; max: number }> = {
  temperatureC: { min: 30, max: 110 },
  temperatureSamples: { min: 2, max: 20 },
  powerPct: { min: 10, max: 100 },
  vramPct: { min: 10, max: 100 },
};

function normalizeGpuAlertValue(key: keyof GpuAlertThresholds, raw: unknown): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  const limits = GPU_ALERT_LIMITS[key];
  return Math.min(limits.max, Math.max(limits.min, value));
}

/** Keep only explicitly set values, clamped to the same ranges as global settings. */
export function normalizeGpuAlertOverride(input: unknown): GpuAlertThresholdOverride | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const result: GpuAlertThresholdOverride = {};
  for (const key of Object.keys(GPU_ALERT_LIMITS) as Array<keyof GpuAlertThresholds>) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const raw = source[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = normalizeGpuAlertValue(key, raw);
    if (value !== undefined) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Normalize persisted host overrides and discard malformed keys/values. */
export function normalizeGpuAlertOverrides(input: unknown): GpuAlertOverrides {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const result: GpuAlertOverrides = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!/^(?:pve|ssh):[^\s]+$/.test(key) || key.length > 300) continue;
    const value = normalizeGpuAlertOverride(rawValue);
    if (value) result[key] = value;
  }
  return result;
}

/** Merge a host override over the global defaults without dropping inherited fields. */
export function resolveGpuAlertThresholds(
  base: GpuAlertThresholds,
  override?: GpuAlertThresholdOverride,
): GpuAlertThresholds {
  const result = { ...base };
  if (!override) return result;
  for (const key of Object.keys(GPU_ALERT_LIMITS) as Array<keyof GpuAlertThresholds>) {
    const value = override[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  return result;
}

export function pveGpuAlertHostKey(endpointId: string, node: string): string {
  return `pve:${endpointId}:${node}`;
}

export function sshGpuAlertHostKey(hostId: string): string {
  return `ssh:${hostId}`;
}

export interface GpuAlertState {
  /** True only after the configured number of consecutive hot temperature samples. */
  temperature: boolean;
  /** True as soon as the current temperature crosses the threshold. */
  temperatureNow: boolean;
  /** Consecutive samples currently at or above the temperature threshold. */
  temperatureStreak: number;
  /** Configured number of samples required for a sustained thermal alert. */
  temperatureSamples: number;
  power: boolean;
  vram: boolean;
}

export interface SustainedGpuTemperatureAlert {
  gpu: GpuTelemetry;
  state: GpuAlertState;
}

/** VRAM used as a percentage, or the driver's own utilization figure. */
export function gpuVramPct(gpu: GpuTelemetry): number | undefined {
  if (gpu.memoryTotal && gpu.memoryTotal > 0 && gpu.memoryUsed !== undefined) {
    return Math.min(100, Math.max(0, (gpu.memoryUsed / gpu.memoryTotal) * 100));
  }
  return gpu.memoryUtilization;
}

/** Power draw as a percentage of the board limit; undefined when either is missing. */
export function gpuPowerPct(gpu: GpuTelemetry): number | undefined {
  if (gpu.powerW === undefined || !gpu.powerLimitW || gpu.powerLimitW <= 0) return undefined;
  return Math.min(100, Math.max(0, (gpu.powerW / gpu.powerLimitW) * 100));
}

/** Clamp the sample window so an old or hand-edited config cannot make it 0. */
export function gpuTemperatureSampleTarget(thresholds: GpuAlertThresholds): number {
  const target = Math.round(Number(thresholds.temperatureSamples));
  if (!Number.isFinite(target)) return DEFAULT_GPU_ALERTS.temperatureSamples;
  return Math.min(20, Math.max(2, target));
}

/**
 * Count consecutive hot samples at the end of the recorded history. The live
 * reading is treated as the newest sample even if the history has not caught up
 * yet. A single cool sample resets the streak, so a transient spike cannot flag
 * a card on its own.
 */
export function gpuTemperatureStreak(gpu: GpuTelemetry, thresholds: GpuAlertThresholds): number {
  const current = gpu.temperatureC;
  if (current === undefined || !Number.isFinite(current) || current < thresholds.temperatureC) return 0;

  const samples = [...(gpu.history?.temperatureC ?? [])];
  if (samples.length === 0 || samples[samples.length - 1] !== current) samples.push(current);

  let streak = 0;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (!Number.isFinite(sample) || sample < thresholds.temperatureC) break;
    streak += 1;
  }
  return streak;
}

export function evaluateGpuAlerts(gpu: GpuTelemetry, thresholds: GpuAlertThresholds): GpuAlertState {
  const power = gpuPowerPct(gpu);
  const vram = gpuVramPct(gpu);
  const temperatureNow = gpu.temperatureC !== undefined && gpu.temperatureC >= thresholds.temperatureC;
  const temperatureStreak = gpuTemperatureStreak(gpu, thresholds);
  const temperatureSamples = gpuTemperatureSampleTarget(thresholds);
  return {
    temperature: temperatureNow && temperatureStreak >= temperatureSamples,
    temperatureNow,
    temperatureStreak,
    temperatureSamples,
    power: power !== undefined && power >= thresholds.powerPct,
    vram: vram !== undefined && vram >= thresholds.vramPct,
  };
}

/** Pick the hottest sustained thermal alert across a host's GPUs. */
export function findSustainedTemperatureAlert(
  gpus: GpuTelemetry[],
  thresholds: GpuAlertThresholds,
): SustainedGpuTemperatureAlert | null {
  let best: SustainedGpuTemperatureAlert | null = null;
  for (const gpu of gpus) {
    const state = evaluateGpuAlerts(gpu, thresholds);
    if (!state.temperature) continue;
    if (!best || state.temperatureStreak > best.state.temperatureStreak) best = { gpu, state };
  }
  return best;
}
