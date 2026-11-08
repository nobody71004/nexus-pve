import { useEffect, useState } from "react";
import type { SpeedTestResult } from "../../shared/types";

/**
 * Speed measurements are shared between the Linux hosts cards, the terminal
 * drawer and the network tab, and survive a restart: a probe moves hundreds of
 * megabytes, so re-running it just to repaint a card is not acceptable.
 */
const KEY = "nexus.speed.v2";
const LIMIT = 8;

export type SpeedHistory = Record<string, SpeedTestResult[]>;

function load(): SpeedHistory {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SpeedHistory;
    if (!parsed || typeof parsed !== "object") return {};
    const clean: SpeedHistory = {};
    for (const [hostId, entries] of Object.entries(parsed)) {
      if (Array.isArray(entries)) clean[hostId] = entries.slice(-LIMIT);
    }
    return clean;
  } catch {
    return {};
  }
}

let state: SpeedHistory = load();
const listeners = new Set<(next: SpeedHistory) => void>();

function emit(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage disabled or full — in-memory history still works */
  }
  for (const listener of listeners) listener(state);
}

export const speedHistory = {
  all: (): SpeedHistory => state,
  latest: (hostId: string): SpeedTestResult | undefined => state[hostId]?.at(-1),
  record(entry: SpeedTestResult): void {
    state = { ...state, [entry.hostId]: [...(state[entry.hostId] ?? []), entry].slice(-LIMIT) };
    emit();
  },
  recordMany(entries: SpeedTestResult[]): void {
    if (entries.length === 0) return;
    const next = { ...state };
    for (const entry of entries) next[entry.hostId] = [...(next[entry.hostId] ?? []), entry].slice(-LIMIT);
    state = next;
    emit();
  },
  forget(hostId: string): void {
    if (!(hostId in state)) return;
    const next = { ...state };
    delete next[hostId];
    state = next;
    emit();
  },
};

export function useSpeedHistory(): SpeedHistory {
  const [snapshot, setSnapshot] = useState<SpeedHistory>(state);
  useEffect(() => {
    listeners.add(setSnapshot);
    setSnapshot(state);
    return () => {
      listeners.delete(setSnapshot);
    };
  }, []);
  return snapshot;
}
