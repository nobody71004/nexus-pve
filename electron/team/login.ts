import type { TeamLoginInput, TeamUser } from "../../shared/team-types";
import type { TeamService } from "./store";

export interface TeamSyncRefresher {
  status(): { enabled: boolean };
  syncFresh(): Promise<unknown>;
}

/**
 * Pull the relay copy before validating credentials so a member created on
 * another station can sign in without waiting for the next sync poll. If the
 * relay is temporarily unreachable, local accounts can still sign in with the
 * directory already on this computer.
 */
export async function loginWithFreshWorkspace(
  team: TeamService,
  sync: TeamSyncRefresher,
  input: TeamLoginInput,
): Promise<TeamUser> {
  if (sync.status().enabled) {
    try {
      await sync.syncFresh();
    } catch (error) {
      console.error("[nexus] sign-in could not refresh the team workspace; using the local directory", error);
    }
  }
  return team.login(input);
}