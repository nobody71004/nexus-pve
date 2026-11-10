import { useMemo, useSyncExternalStore } from "react";
import type { GpuAlertOverrides, GpuAlertThresholdOverride, GpuAlertThresholds } from "../../shared/types";
import {
  DEFAULT_GPU_ALERTS,
  normalizeGpuAlertOverride,
  normalizeGpuAlertOverrides,
  resolveGpuAlertThresholds,
} from "../../shared/gpu-alerts";
import { bridge } from "./bridge";

let currentThresholds: GpuAlertThresholds = { ...DEFAULT_GPU_ALERTS };
let currentOverrides: GpuAlertOverrides = {};
let loaded = false;
let inflight: Promise<GpuAlertThresholds> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function apply(next: GpuAlertThresholds | undefined, overrides: GpuAlertOverrides | undefined): void {
  currentThresholds = { ...DEFAULT_GPU_ALERTS, ...(next ?? {}) };
  currentOverrides = normalizeGpuAlertOverrides(overrides);
  loaded = true;
  emit();
}

export function ensureGpuAlerts(): Promise<GpuAlertThresholds> {
  if (loaded) return Promise.resolve(currentThresholds);
  if (inflight) return inflight;
  const settings = bridge.settings;
  if (!settings?.get) {
    loaded = true;
    return Promise.resolve(currentThresholds);
  }
  inflight = settings
    .get()
    .then((value) => {
      apply(value.gpuAlerts, value.gpuAlertOverrides);
      return currentThresholds;
    })
    .catch(() => {
      loaded = true;
      return currentThresholds;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function saveGpuAlerts(next: GpuAlertThresholds): Promise<GpuAlertThresholds> {
  const settings = bridge.settings;
  if (!settings?.save) throw new Error("Settings are unavailable outside the desktop app.");
  const saved = await settings.save({ gpuAlerts: next });
  apply(saved.gpuAlerts, saved.gpuAlertOverrides);
  return currentThresholds;
}

async function writeGpuAlertOverrides(next: GpuAlertOverrides): Promise<void> {
  const settings = bridge.settings;
  if (!settings?.save) throw new Error("Settings are unavailable outside the desktop app.");
  const saved = await settings.save({ gpuAlertOverrides: next });
  apply(saved.gpuAlerts, saved.gpuAlertOverrides);
}

/** Save a partial override; omitted fields continue to inherit the global thresholds. */
export async function saveGpuAlertOverride(
  hostKey: string,
  override: GpuAlertThresholdOverride | undefined,
): Promise<GpuAlertThresholds> {
  if (!hostKey) throw new Error("A host is required for host-specific GPU limits.");
  const settings = bridge.settings;
  if (!settings?.get || !settings?.save) throw new Error("Settings are unavailable outside the desktop app.");
  // Read the latest map before replacing it so a second window cannot clobber
  // overrides that were saved after this one loaded its settings.
  const latest = await settings.get();
  apply(latest.gpuAlerts, latest.gpuAlertOverrides);
  const normalized = normalizeGpuAlertOverride(override);
  const next = { ...currentOverrides };
  if (normalized) next[hostKey] = normalized;
  else delete next[hostKey];
  await writeGpuAlertOverrides(next);
  return resolveGpuAlertThresholds(currentThresholds, currentOverrides[hostKey]);
}

export function resetGpuAlertOverride(hostKey: string): Promise<GpuAlertThresholds> {
  return saveGpuAlertOverride(hostKey, undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void ensureGpuAlerts();
  return () => {
    listeners.delete(listener);
  };
}

function thresholdsSnapshot(): GpuAlertThresholds {
  return currentThresholds;
}

function overridesSnapshot(): GpuAlertOverrides {
  return currentOverrides;
}

/** Global thresholds, or the effective thresholds for one host when a key is supplied. */
export function useGpuAlerts(hostKey?: string): GpuAlertThresholds {
  const thresholds = useSyncExternalStore(subscribe, thresholdsSnapshot, thresholdsSnapshot);
  const overrides = useSyncExternalStore(subscribe, overridesSnapshot, overridesSnapshot);
  return useMemo(
    () => resolveGpuAlertThresholds(thresholds, hostKey ? overrides[hostKey] : undefined),
    [thresholds, overrides, hostKey],
  );
}

/** Raw partial override for a host; useful for indicating an active host override. */
export function useGpuAlertOverride(hostKey?: string): GpuAlertThresholdOverride | undefined {
  const overrides = useSyncExternalStore(subscribe, overridesSnapshot, overridesSnapshot);
  return hostKey ? overrides[hostKey] : undefined;
}
