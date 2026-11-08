import { spawnSync } from "node:child_process";

const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
const versionCheck = "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)";
const python = candidates.find((candidate) => {
  const result = spawnSync(candidate, ["-c", versionCheck], { stdio: "ignore" });
  return !result.error && result.status === 0;
});

if (!python) {
  console.error("Python 3.10+ is required to run the edge safety regression tests.");
  process.exit(1);
}

const result = spawnSync(
  python,
  ["-B", "-m", "unittest", "discover", "-s", "tests", "-p", "test_edge*.py", "-v"],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
