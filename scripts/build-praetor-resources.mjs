import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const praetor = path.resolve(root, "..", "vanta-repo", "praetor");
const outdir = path.join(root, "resources", "praetor");

if (!path.isAbsolute(praetor)) {
  throw new Error("Praetor source directory is not absolute");
}

await build({
  absWorkingDir: praetor,
  entryPoints: [path.join(praetor, "bin", "praetor-egress.js")],
  outfile: path.join(outdir, "praetor-egress.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  banner: { js: "// Generated from vanta-repo/praetor by scripts/build-praetor-resources.mjs" },
});

await build({
  stdin: {
    contents: [
      'import fs from "node:fs";',
      'import { generateServerKeypair } from "./src/index.js";',
      'const [secretPath, publicPath] = process.argv.slice(2);',
      'if (!secretPath || !publicPath) { console.error("usage: praetor-keygen.mjs <secret> <public>"); process.exit(2); }',
      'const pair = generateServerKeypair();',
      'fs.writeFileSync(secretPath, `${Buffer.from(pair.secretKey).toString("base64")}\\n`, { mode: 0o600 });',
      'fs.writeFileSync(publicPath, `${Buffer.from(pair.publicKey).toString("base64")}\\n`, { mode: 0o644 });',
      'console.log(JSON.stringify({ ok: true, publicKey: Buffer.from(pair.publicKey).toString("base64") }));',
    ].join("\n"),
    resolveDir: praetor,
    sourcefile: "praetor-keygen-entry.mjs",
  },
  outfile: path.join(outdir, "praetor-keygen.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  banner: { js: "// Generated from vanta-repo/praetor by scripts/build-praetor-resources.mjs" },
});

console.log(`wrote PRAETOR resources to ${path.relative(root, outdir)}`);
