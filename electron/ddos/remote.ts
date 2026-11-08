import type { ConfigStore } from "../config";
import { runRemote, toRunner } from "../ssh/probe";

/**
 * Everything the app does on the edge goes through the configured SSH host.
 * The edge is reached with its own key (or stored password); no new credential
 * is introduced, and the host stays visible under Connections.
 */
export async function runEdge(
  store: ConfigStore,
  hostId: string,
  script: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string; latencyMs: number }> {
  const host = store.sshHost(hostId);
  if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
  if (host.username !== "root") {
    throw new Error(
      `${host.label}: the edge installer needs root. This host logs in as "${host.username}"; use a root key or install the shield manually.`,
    );
  }
  const password = host.authMode === "password" ? store.sshSecretFor(host.id) : undefined;
  if (host.authMode === "password" && !password) throw new Error(`${host.label}: stored password is missing`);
  return runRemote(toRunner(store.publicSshHost(host), timeoutMs, password), script, "bash");
}

export async function edgeCommand(
  store: ConfigStore,
  hostId: string,
  command: string,
  timeoutMs = 45_000,
): Promise<string> {
  const result = await runEdge(store, hostId, `set -euo pipefail\n${command}\n`, timeoutMs);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(" ");
    throw new Error(`${command.split(" ")[0]} failed: ${detail || `ssh exited ${result.code ?? "?"}`}`);
  }
  return result.stdout;
}

/** POSIX single-quote escaping for values embedded in a remote bash script. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Stages a set of text files and runs install.sh in one SSH session. The
 * payload travels over stdin (`bash -s`), so there is no command-line length
 * limit and no quoting of the Python source.
 */
export function buildInstallScript(files: Record<string, string>, entry = "bash /tmp/nexus-shield-src/install.sh"): string {
  const lines = ["set -euo pipefail", "rm -rf /tmp/nexus-shield-src", "mkdir -p /tmp/nexus-shield-src"];
  for (const [name, content] of Object.entries(files)) {
    const safe = name.replace(/[^A-Za-z0-9_.-]/g, "");
    lines.push(`cat > /tmp/nexus-shield-src/${safe} <<'NEXUS_SHIELD_EOF'`);
    lines.push(content.replace(/\r\n/g, "\n").replace(/\s+$/, ""));
    lines.push("NEXUS_SHIELD_EOF");
  }
  lines.push(entry);
  return `${lines.join("\n")}\n`;
}

/** Pulls the first complete JSON object out of a shell transcript. */
export function extractJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
