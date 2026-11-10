import fs from "node:fs";
import path from "node:path";
import type { GpuSetupResult, GpuTelemetry } from "../../shared/types";
import type { ConfigStore } from "../config";
import { runPrivileged } from "./actions";
import { collectSshGpuTelemetry, invalidateSshGpuCache } from "./collect";
import { GPU_SETUP_PATH, checkHelper, installHelper } from "./helper";

const RESOURCE_GPU_SETUP = "nexus-gpu-setup.sh";

/**
 * The app and the installed helper run the same fixed root script. Reading the
 * bundled resource (instead of a second in-code copy) keeps the two paths from
 * drifting apart and lets the helper installer verify its SHA-256.
 */
export function readGpuSetupScript(appRoot: string): string {
  return fs.readFileSync(path.join(appRoot, "resources", RESOURCE_GPU_SETUP), "utf8");
}

function lastUsefulLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("@@"))
    .at(-1);
}

/**
 * Detect OS/GPU support, install the sensor tooling, and load amdgpu when it is
 * safe. A VFIO-bound card is intentionally skipped and reported: claiming it
 * would break the guest that owns it. The follow-up probe is what decides
 * success, so a successful package install is never mistaken for telemetry.
 */
export async function setupGpuSensors(
  store: ConfigStore,
  appRoot: string,
  id: string,
): Promise<GpuSetupResult> {
  const host = store.sshHost(id);
  if (!host) throw new Error(`Unknown Linux host: ${id}`);

  let script: string;
  try {
    script = readGpuSetupScript(appRoot);
  } catch (error) {
    return {
      hostId: host.id,
      ok: false,
      gpus: [],
      output: "",
      error: `GPU setup resource is missing from this build: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    // A fresh host may not have the privileged helper yet. On root and password
    // routes installHelper can do that automatically; on a key-only host it
    // returns the exact bootstrap commands instead of a shell failure.
    const helperStatus = await checkHelper(store, appRoot, id);
    if (helperStatus.state !== "ready") {
      const installed = await installHelper(store, appRoot, id, undefined, { trigger: "auto" });
      if (!installed.ok) {
        return {
          hostId: host.id,
          ok: false,
          gpus: [],
          output: installed.output,
          error: installed.error ?? "Could not install the privileged helper needed for GPU sensor setup.",
        };
      }
    }
    const outcome = await runPrivileged(store, id, script, {
      helper: ["gpu", "setup"],
      timeoutMs: 10 * 60_000,
    });
    invalidateSshGpuCache(id);
    const probe = await collectSshGpuTelemetry(store, id);
    const live = probe.gpus.filter((gpu): gpu is GpuTelemetry => gpu.source !== "inventory");
    const output = outcome.output.trim();
    if (!outcome.ok) {
      return {
        hostId: host.id,
        ok: false,
        gpus: live,
        output,
        error: lastUsefulLine(output) ?? `${host.label}: GPU sensor setup failed`,
      };
    }
    if (live.length === 0) {
      return {
        hostId: host.id,
        ok: false,
        gpus: [],
        output,
        error:
          probe.error ??
          `No live GPU telemetry was exposed after setup. The card may be bound to a VM, or the driver may need a reboot.`,
      };
    }
    return { hostId: host.id, ok: true, gpus: live, output };
  } catch (error) {
    return {
      hostId: host.id,
      ok: false,
      gpus: [],
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The helper path is shown in diagnostics so a stale install is obvious. */
export const GPU_SETUP_HELPER_PATH = GPU_SETUP_PATH;
