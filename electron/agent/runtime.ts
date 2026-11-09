import path from "node:path";
import type { NexusEvent } from "../../shared/types";
import { ConfigStore, configStore } from "../config";
import { registerAuditTools } from "./audit";
import { PipelineService } from "./pipeline";
import { ToolRegistry } from "./registry";
import { registerPveTools } from "./tools-pve";
import { registerDevTools } from "./tools-dev";
import { registerSecurityTools } from "./tools-security";
import { registerDdosTools } from "./tools-ddos";
import { registerPraetorTools } from "./tools-praetor";
import { registerSshTools } from "./tools-ssh";
import { bindGuardianEmit, guardian } from "../security/guardian";
import { setHelperAppRoot } from "../ssh/helper";
import { setDdosAppRoot } from "../ddos/service";
import { setPraetorAppRoot } from "../praetor/service";

export interface Runtime {
  store: ConfigStore;
  registry: ToolRegistry;
  pipelines: PipelineService;
  appRoot: string;
}

let singleton: Runtime | null = null;

export function createRuntime(appRoot: string, emit: (event: NexusEvent) => void): Runtime {
  if (singleton && singleton.appRoot === appRoot) return singleton;

  const store = configStore;
  const registry = new ToolRegistry();
  registerPveTools(registry);
  registerSshTools(registry);
  registerSecurityTools(registry);
  registerDdosTools(registry);
  registerPraetorTools(registry);
  registerDevTools(registry);
  registerAuditTools(registry);
  const pipelines = new PipelineService({ store, registry, appRoot, emit });

  // The guardian runs inside whichever process owns the runtime: the desktop
  // app while it is open, or the headless MCP server. Its timers are unref'd.
  // The helper installer/version gate needs the same resource directory here.
  setHelperAppRoot(appRoot);
  setDdosAppRoot(appRoot);
  setPraetorAppRoot(appRoot);
  bindGuardianEmit(emit);
  guardian.start();

  singleton = { store, registry, pipelines, appRoot: path.resolve(appRoot) };
  return singleton;
}

export function resetRuntime(): void {
  guardian.stop();
  singleton = null;
}

/** Where the MCP bundle lives, including inside a packaged (asar) install. */
export function mcpServerPath(appRoot: string, packaged: boolean): string {
  const base = path.join(appRoot, "dist-electron", "mcp-server.cjs");
  if (!packaged) return base;
  return base.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}
