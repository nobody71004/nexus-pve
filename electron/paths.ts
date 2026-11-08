import os from "node:os";
import path from "node:path";

/**
 * One home for the desktop app and the standalone MCP server.
 * Electron's `app.getPath('userData')` resolves to the same place on Windows
 * (%APPDATA%/NexusPVE) because productName is "NexusPVE"; on Linux/macOS the
 * defaults below match Electron's path convention.
 */
export function nexusHome(): string {
  if (process.env.NEXUS_PVE_HOME) return path.resolve(process.env.NEXUS_PVE_HOME);
  const appData = process.env.APPDATA;
  if (process.platform === "win32" && appData) return path.join(appData, "NexusPVE");
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "NexusPVE");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config"), "NexusPVE");
}

export const configPath = () => path.join(nexusHome(), "config.json");
export const keyPath = () => path.join(nexusHome(), "keys", "master.key");
export const pipelinesDir = () => path.join(nexusHome(), "pipelines");
export const runsPath = () => path.join(nexusHome(), "runs.json");
export const incidentsDir = () => path.join(nexusHome(), "incidents");
export const mcpConfigPath = () => path.join(nexusHome(), "mcp.json");
