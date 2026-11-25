/**
 * Finish a team mutation at the IPC boundary. The local mutation is already
 * committed, so a failed immediate relay push must not be reported as a
 * failed account operation. Instead, preserve the local result and attach the
 * relay error so the renderer can tell the operator exactly what happened.
 */
export interface TeamSyncPublisher {
  status(): { enabled: boolean };
  syncFresh(): Promise<unknown>;
}

export async function publishTeamMutation<T extends { syncWarning?: string }>(
  result: T,
  sync: TeamSyncPublisher,
  reconcile: () => Promise<void> = async () => {},
): Promise<T> {
  await reconcile();
  if (!sync.status().enabled) return result;
  try {
    await sync.syncFresh();
    return result;
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).trim().slice(0, 500) || "unknown relay error";
    console.error("[nexus] team change saved locally but could not reach the sync relay", error);
    return {
      ...result,
      syncWarning: `The local change was saved, but the team relay sync failed: ${detail}`,
    };
  }
}