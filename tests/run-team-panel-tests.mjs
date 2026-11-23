import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "tests", ".tmp-team-panel.e2e.cjs");

let exitCode = 1;
try {
  await build({
    entryPoints: [path.join(root, "tests", "team-panel-dialog.e2e.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    // Keep one React instance shared by the test and the app components, and
    // leave jsdom to its Node-compatible CommonJS entry point.
    external: ["jsdom", "react", "react/*", "react-dom", "react-dom/*"],
    define: {
      "import.meta.env.DEV": "true",
    },
    sourcemap: "inline",
    logLevel: "warning",
  });

  const result = spawnSync(process.execPath, ["--test", bundle], {
    cwd: root,
    stdio: "inherit",
    timeout: 60_000,
  });
  if (result.error) console.error(result.error.message);
  exitCode = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(bundle, { force: true });
}

process.exit(exitCode);
