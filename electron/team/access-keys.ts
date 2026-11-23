import { sshKeys, type MemberKeyRevocationResult, type SshKeyService } from "../sshkeys/service";
import type { TeamService } from "./store";

let pending: Promise<unknown> = Promise.resolve();

/**
 * Serialize member-key reconciliation so a local mutation, a sync pull and the
 * watcher cannot race each other while reading or retiring the same vault.
 */
export function revokeUnauthorizedTeamKeys(
  team: TeamService,
  keys: SshKeyService = sshKeys,
): Promise<MemberKeyRevocationResult> {
  const run = pending.then(() =>
    keys.revokeUnauthorizedMemberKeys((userId, hostId) => team.canUseSshKey(userId, hostId)),
  );
  pending = run.catch(() => undefined);
  return run;
}
