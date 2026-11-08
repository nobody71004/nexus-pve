import type { ConfigStore } from "../config";
import { sshRunner } from "../ssh/collect";
import { runRemote } from "../ssh/probe";

/**
 * Layer 2 — collection. One SSH round trip gathers the unprivileged view and,
 * when the narrow root helper is installed, a root-only fact block. Nothing is
 * interpreted remotely: the guest returns facts, the desktop evaluates them.
 * That keeps the privileged surface free of policy logic.
 */
const REMOTE_AUDIT = String.raw`set +e
emit() { printf '%s|%s\n' "$1" "$(printf '%s' "$2" | base64 -w0 2>/dev/null)"; }
peer=$(printf '%s' "$SSH_CONNECTION" | awk '{print $1}')
emit peer_ip "$peer"
emit login_user "$(id -un)"
emit helper "$( [ -x /usr/local/sbin/nexus-priv ] && echo present || echo absent )"
emit os_release "$(head -8 /etc/os-release 2>/dev/null)"
emit sshd_raw "$(cat /etc/ssh/sshd_config 2>/dev/null; cat /etc/ssh/sshd_config.d/*.conf 2>/dev/null)"
emit listeners_plain "$(ss -Htuln 2>/dev/null | sed -E 's/[[:space:]]+/ /g' | cut -d' ' -f1,5 | head -80)"
emit uptime "$(uptime -p 2>/dev/null || true)"
if sudo -n /usr/local/sbin/nexus-priv guard collect 2>/dev/null; then
  emit privileged "yes"
else
  emit privileged "no"
fi
exit 0
`;

export interface AuditFacts {
  values: Record<string, string>;
  privileged: boolean;
  peerIp?: string;
  errors: string[];
}

export function parseFacts(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf("|");
    if (index <= 0) continue;
    const key = line.slice(0, index);
    if (!/^[a-z0-9_]+$/i.test(key)) continue;
    try {
      values[key] = Buffer.from(line.slice(index + 1), "base64").toString("utf8");
    } catch {
      values[key] = "";
    }
  }
  return values;
}

export async function collectFacts(store: ConfigStore, hostId: string): Promise<AuditFacts> {
  const errors: string[] = [];
  const result = await runRemote(sshRunner(store, hostId, 180_000), REMOTE_AUDIT, "bash");
  if (!result.ok) {
    throw new Error((result.stderr || result.stdout || "audit command failed").trim().slice(0, 500));
  }
  const values = parseFacts(result.stdout);
  const privileged = values.privileged === "yes";
  delete values.privileged;
  // How this app reaches the host. Disabling password auth on a password-only
  // transport would cut the next scan off from the host.
  values.transport = store.sshHost(hostId)?.authMode === "password" ? "password" : "key";
  if (!privileged) {
    errors.push("root helper unavailable — deep checks and enforcement are disabled on this host");
  }
  for (const key of ["ufw", "apt_pending", "failed_ips"]) {
    if (privileged && values[key] === undefined) errors.push(`collector did not return ${key}`);
  }
  return {
    values,
    privileged,
    peerIp: (values.peer_ip || "").trim() || undefined,
    errors,
  };
}
