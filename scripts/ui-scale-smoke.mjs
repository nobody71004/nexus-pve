/**
 * UI-scale persistence smoke test.
 *
 * Exercises the config normalization and write path used by the desktop
 * Settings slider without launching Electron.
 */
import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const previousHome = process.env.NEXUS_PVE_HOME;
const tempHome = mkdtempSync(path.join(tmpdir(), "nexus-ui-scale-"));
process.env.NEXUS_PVE_HOME = tempHome;

try {
  const bundle = buildSync({
    entryPoints: [path.join(root, "electron", "config.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", bundle.outputFiles[0].text)(module, module.exports, require);
  const { ConfigStore } = module.exports;
  const store = new ConfigStore();

  check("UI scale defaults to 100", store.settings().uiScale === 100, `${store.settings().uiScale}%`);

  const saved = store.setSettings({ uiScale: 125 });
  check("UI scale saves a slider value", saved.uiScale === 125, `${saved.uiScale}%`);
  check(
    "UI scale is persisted to the config file",
    JSON.parse(readFileSync(store.file, "utf8")).settings.uiScale === 125,
    store.file,
  );
  check("UI scale preserves unrelated settings", saved.pollMs === 8000 && saved.confirmDestructive === true);

  check("UI scale clamps below 75%", store.setSettings({ uiScale: 20 }).uiScale === 75);
  check("UI scale clamps above 150%", store.setSettings({ uiScale: 999 }).uiScale === 150);
  check("UI scale snaps to the 5% slider step", store.setSettings({ uiScale: 133 }).uiScale === 135);
  check("UI scale resets to 100%", store.setSettings({ uiScale: 100 }).uiScale === 100);
} finally {
  if (previousHome === undefined) delete process.env.NEXUS_PVE_HOME;
  else process.env.NEXUS_PVE_HOME = previousHome;
  rmSync(tempHome, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exitCode = 1;
