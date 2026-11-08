import fs from "node:fs";
import path from "node:path";
import { buildInstallScript } from "./remote";

const EDGE_FILES = [
  "nexus-shieldd.py",
  "nexus-shieldctl",
  "nexus-shield.service",
  "95-nexus-shield.conf",
  "config.example.json",
  "install.sh",
] as const;

/**
 * The resources folder is inside app.asar in a packaged build; Electron's fs
 * shim reads it transparently. The cwd fallback keeps the headless MCP server
 * working when it is started from a source checkout.
 */
export function edgeResourceDir(appRoot: string): string {
  const candidates = [
    path.join(appRoot, "resources", "nexus-shield"),
    path.join(process.cwd(), "resources", "nexus-shield"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "install.sh"))) return candidate;
  }
  throw new Error(
    `Nexus Shield resources are missing. Expected ${path.join(appRoot, "resources", "nexus-shield")} — reinstall the app or run it from the source checkout.`,
  );
}

export function edgeFiles(appRoot: string): Record<string, string> {
  const dir = edgeResourceDir(appRoot);
  const files: Record<string, string> = {};
  for (const name of EDGE_FILES) {
    files[name] = fs.readFileSync(path.join(dir, name), "utf8");
  }
  return files;
}

export function installScript(appRoot: string): string {
  return buildInstallScript(edgeFiles(appRoot));
}
