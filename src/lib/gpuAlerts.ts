import { useSyncExternalStore } from "react";
import type { GpuAlertThresholds } from "../../shared/types";
import { DEFAULT_GPU_ALERTS } from "../../shared/gpu-alerts";
import { bridge } from "./bridge";

let current: GpuAlertThresholds = { ...DEFAULT_GPU_ALERTS };
let loaded = false;
let inflight: Promise<GpuAlertThresholds> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function apply(next: GpuAlertThresholds | undefined): void {
  current = { ...DEFAULT_GPU_ALERTS, ...(next ?? {}) };
  loaded = true;
  emit();
}

export function ensureGpuAlerts(): Promise<GpuAlertThresholds> {
  if (loaded) return Promise.resolve(current);
  if (inflight) return inflight;
  const settings = bridge.settings;
  if (!settings?.get) {
    loaded = true;
    return Promise.resolve(current);
  }
  inflight = settings
    .get()
    .then((value) => {
      apply(value.gpuAlerts);
      return current;
    })
    .catch(() => {
      loaded = true;
      return current;
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
  apply(saved.gpuAlerts);
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void ensureGpuAlerts();
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): GpuAlertThresholds {
  return current;
}

/** Shared thresholds; every mounted GPU panel updates after one save. */
export function useGpuAlerts(): GpuAlertThresholds {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
