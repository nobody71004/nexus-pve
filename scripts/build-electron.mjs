import { build, context } from "esbuild";
import { rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  // cpu-features is an optional native accelerator inside ssh2; ssh2 guards
  // the require in a try/catch, and bundling the .node is neither possible nor needed.
  external: ["electron", "cpu-features"],
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"),
  },
};

const entries = [
  { in: "electron/main.ts", out: "dist-electron/main.cjs" },
  { in: "electron/preload.ts", out: "dist-electron/preload.cjs" },
  { in: "electron/mcp-server.ts", out: "dist-electron/mcp-server.cjs" },
];

await rm("dist-electron", { recursive: true, force: true });

if (watch) {
  const contexts = await Promise.all(
    entries.map((entry) => context({ ...common, entryPoints: [entry.in], outfile: entry.out })),
  );
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("[build] watching electron bundles…");
} else {
  await Promise.all(entries.map((entry) => build({ ...common, entryPoints: [entry.in], outfile: entry.out })));
  console.log("[build] electron bundles written to dist-electron/");
}
