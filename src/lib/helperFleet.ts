import type { HelperState, HelperStatus, SshHostSummary } from "../../shared/types";
import { bridge } from "./bridge";

/**
 * One shared view of privileged-helper readiness.
 *
 * The rail badge, the fleet overview panel and the Linux hosts cards all report
 * the same fact, so they read from one store instead of each opening their own
 * SSH checks. Components push a fresh status after an install or a check with
 * `noteHelper`, which keeps the badge honest without a second round trip.
 */

export interface HelperFleetState {
  hosts: SshHostSummary[];
  statuses: HelperStatus[];
  loading: boolean;
  checkedAt: number;
  error?: string;
}

type Listener = () => void;

let state: HelperFleetState = { hosts: [], statuses: [], loading: false, checkedAt: 0 };
let inflight: Promise<HelperFleetState> | null = null;
const listeners = new Set<Listener>();

function publish(patch: Partial<HelperFleetState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribeHelpers(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function helperFleet(): HelperFleetState {
  return state;
}

/** Fold in one host's result without re-checking the rest of the fleet. */
export function noteHelper(status: HelperStatus): void {
  const known = state.statuses.some((entry) => entry.hostId === status.hostId);
  publish({
    statuses: known
      ? state.statuses.map((entry) => (entry.hostId === status.hostId ? status : entry))
      : [...state.statuses, status],
    checkedAt: Date.now(),
  });
}

export async function refreshHelpers(options: { force?: boolean } = {}): Promise<HelperFleetState> {
  if (inflight) return inflight;
  // Opening the app and switching tabs should not each cost a command per host.
  if (!options.force && state.checkedAt > 0 && Date.now() - state.checkedAt < 30_000) return state;

  publish({ loading: true });
  inflight = (async () => {
    try {
      const hosts = await bridge.ssh.hosts();
      const report = await Promise.all(
        hosts.map(async (host): Promise<HelperStatus | null> => {
          try {
            return await bridge.ssh.helper(host.id);
          } catch {
            // Keep the host in the denominator as unreadable rather than
            // guessing ready or missing for a box that did not answer.
            return null;
          }
        }),
      );
      publish({
        hosts,
        statuses: report.filter((status): status is HelperStatus => status !== null),
        loading: false,
        checkedAt: Date.now(),
        error: undefined,
      });
    } catch (error) {
      publish({
        loading: false,
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return state;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Hosts that cannot run privileged actions as they stand, plus unreadable ones. */
export function helperAlertCount(fleet: HelperFleetState): number {
  const unreadable = Math.max(0, fleet.hosts.length - fleet.statuses.length);
  return fleet.statuses.filter((status) => status.state !== "ready").length + unreadable;
}

export function helperAlertBreakdown(fleet: HelperFleetState): Partial<Record<HelperState | "unreadable", number>> {
  const counts: Partial<Record<HelperState | "unreadable", number>> = {};
  for (const status of fleet.statuses) {
    if (status.state === "ready") continue;
    counts[status.state] = (counts[status.state] ?? 0) + 1;
  }
  const unreadable = Math.max(0, fleet.hosts.length - fleet.statuses.length);
  if (unreadable > 0) counts.unreadable = unreadable;
  return counts;
}
