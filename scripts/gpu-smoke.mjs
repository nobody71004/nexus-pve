/**
 * GPU telemetry parser smoke test.
 *
 * Exercises the exact output shapes emitted by the remote probe without
 * requiring NVIDIA or AMD hardware in the test machine.
 */
import { buildSync } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const bundle = buildSync({
  entryPoints: [path.join(root, "electron", "ssh", "gpu.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
});
const module = { exports: {} };
new Function("module", "exports", "require", bundle.outputFiles[0].text)(module, module.exports, undefined);
const { parseGpuProbe, recordGpuHistory, clearGpuHistory } = module.exports;

const alertBundle = buildSync({
  entryPoints: [path.join(root, "shared", "gpu-alerts.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
});
const alertModule = { exports: {} };
new Function("module", "exports", "require", alertBundle.outputFiles[0].text)(alertModule, alertModule.exports, undefined);
const { DEFAULT_GPU_ALERTS, evaluateGpuAlerts } = alertModule.exports;

const nvidia = parseGpuProbe(`@@gpu
--nvidia
0, GPU-6f0c7b8e-2d7f-4a31-a9f2-demo-a4000, NVIDIA RTX A4000, 550.54.15, 62.2, 73, 44, 16384, 11200, 231.4, 450, 48, 2520, 7001, P2, 4, 16, 0000:41:00.0
--nvidia-procs
GPU-6f0c7b8e-2d7f-4a31-a9f2-demo-a4000, 1234, python3, 8192
--pci
0000:41:00.0 VGA compatible controller: NVIDIA Corporation GA104GL [RTX A4000] [10de:24b0] (rev a1)
--amd
@@end`);
check("NVIDIA telemetry is parsed", nvidia.gpus.length === 1 && nvidia.gpus[0].vendor === "nvidia" && nvidia.gpus[0].source === "nvidia-smi", nvidia.gpus[0]?.name);
check("NVIDIA utilization and temperature are numeric", nvidia.gpus[0]?.utilization === 73 && nvidia.gpus[0]?.temperatureC === 62.2, `${nvidia.gpus[0]?.utilization}% / ${nvidia.gpus[0]?.temperatureC}°C`);
check("NVIDIA VRAM and power are converted", nvidia.gpus[0]?.memoryTotal === 16384 * 1024 ** 2 && nvidia.gpus[0]?.powerW === 231.4, `${nvidia.gpus[0]?.memoryTotal} bytes`);
check("NVIDIA process memory is converted", nvidia.gpus[0]?.processes?.length === 1 && nvidia.gpus[0]?.processes?.[0]?.memoryUsed === 8192 * 1024 ** 2, nvidia.gpus[0]?.processes?.[0]?.name);
check("NVIDIA PCIe and p-state are present", nvidia.gpus[0]?.pcieGeneration === 4 && nvidia.gpus[0]?.pcieWidth === 16 && nvidia.gpus[0]?.pstate === "P2");

const amd = parseGpuProbe(`@@gpu
--pci
0000:43:00.0 Display controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XTX] [1002:744c] (rev c0)
--amd
amd|0000:43:00.0|0x1002|0x744c|42|37|25753026560|9663676416|58000|71000|62000|188300000|1420|100|2100Mhz|1120Mhz|amdgpu
@@end`);
check("AMD telemetry is parsed from sysfs", amd.gpus.length === 1 && amd.gpus[0].vendor === "amd" && amd.gpus[0].source === "amdgpu-sysfs", amd.gpus[0]?.name);
check("AMD utilization and temperatures are parsed", amd.gpus[0]?.utilization === 42 && amd.gpus[0]?.temperatureC === 58 && amd.gpus[0]?.hotspotC === 71, `${amd.gpus[0]?.temperatureC}°C / hotspot ${amd.gpus[0]?.hotspotC}°C`);
check("AMD VRAM and power are converted", amd.gpus[0]?.memoryTotal === 25753026560 && amd.gpus[0]?.powerW === 188.3, `${amd.gpus[0]?.powerW}W`);
check("AMD fan and clocks are parsed", amd.gpus[0]?.fanPercent === 39 && amd.gpus[0]?.fanRpm === 1420 && amd.gpus[0]?.clockMhz === 2100, `${amd.gpus[0]?.fanPercent}% / ${amd.gpus[0]?.clockMhz} MHz`);

// ---- history ring buffer --------------------------------------------------
const historyProbe = parseGpuProbe(`@@gpu
--nvidia
0, GPU-history, NVIDIA RTX A4000, 550.54.15, 60, 50, 40, 16384, 8000, 200, 450, 40, 2000, 7000, P2, 4, 16, 0000:41:00.0
@@end`);
recordGpuHistory("smoke-host", historyProbe.gpus);
const historySecond = recordGpuHistory("smoke-host", [
  { ...historyProbe.gpus[0], utilization: 80, temperatureC: 70 },
]);
check(
  "GPU history appends utilization and temperature samples",
  historySecond[0]?.history?.utilization.length === 2 &&
    historySecond[0]?.history?.utilization[1] === 80 &&
    historySecond[0]?.history?.temperatureC[1] === 70,
  `${historySecond[0]?.history?.utilization.join(", ")}% / ${historySecond[0]?.history?.temperatureC.join(", ")}°C`,
);
let capped = historySecond;
for (let index = 0; index < 130; index += 1) {
  capped = recordGpuHistory("smoke-host", [{ ...historyProbe.gpus[0], utilization: index % 100, temperatureC: 40 }]);
}
check("GPU history keeps only the newest 120 samples", capped[0]?.history?.utilization.length === 120);
clearGpuHistory("smoke-host");
const historyReset = recordGpuHistory("smoke-host", [
  { ...historyProbe.gpus[0], utilization: 12, temperatureC: 45 },
]);
check(
  "GPU history resets when its host is cleared",
  historyReset[0]?.history?.utilization.length === 1 && historyReset[0]?.history?.utilization[0] === 12,
);

// ---- configurable alert thresholds ---------------------------------------
const alertGpu = {
  ...nvidia.gpus[0],
  temperatureC: 88,
  history: { utilization: [], temperatureC: [84, 87, 88, 88] },
  powerW: 420,
  powerLimitW: 450,
  memoryUsed: 15 * 1024 ** 3,
  memoryTotal: 16 * 1024 ** 3,
};
const hotState = evaluateGpuAlerts(alertGpu, DEFAULT_GPU_ALERTS);
check(
  "GPU alert thresholds flag temperature, power and VRAM",
  hotState.temperature && hotState.power && hotState.vram,
  JSON.stringify(hotState),
);
const coolGpu = {
  ...alertGpu,
  temperatureC: 60,
  history: { utilization: [], temperatureC: [55, 58, 60] },
  powerW: 200,
  memoryUsed: 4 * 1024 ** 3,
};
const coolState = evaluateGpuAlerts(coolGpu, DEFAULT_GPU_ALERTS);
check(
  "GPU alerts stay quiet below their limits",
  !coolState.temperature && !coolState.power && !coolState.vram,
  JSON.stringify(coolState),
);
check(
  "GPU power alerts need a known board limit",
  !evaluateGpuAlerts({ ...alertGpu, powerLimitW: undefined }, DEFAULT_GPU_ALERTS).power,
);
const customState = evaluateGpuAlerts(coolGpu, { temperatureC: 50, temperatureSamples: 2, powerPct: 40, vramPct: 20 });
check(
  "custom GPU alert thresholds are applied",
  customState.temperature && customState.power && customState.vram,
  JSON.stringify(customState),
);
const twoSamples = evaluateGpuAlerts(
  { ...alertGpu, history: { utilization: [], temperatureC: [87.5, 88] } },
  DEFAULT_GPU_ALERTS,
);
check(
  "one or two hot samples do not trigger a sustained thermal alert",
  twoSamples.temperatureNow && !twoSamples.temperature && twoSamples.temperatureStreak === 2,
  JSON.stringify(twoSamples),
);
const resetState = evaluateGpuAlerts(
  { ...alertGpu, history: { utilization: [], temperatureC: [88, 88, 60, 88] } },
  DEFAULT_GPU_ALERTS,
);
check(
  "a cool sample resets the sustained thermal streak",
  resetState.temperatureNow && !resetState.temperature && resetState.temperatureStreak === 1,
  JSON.stringify(resetState),
);
check(
  "the sustained thermal window defaults to three samples",
  DEFAULT_GPU_ALERTS.temperatureSamples === 3 && hotState.temperatureSamples === 3,
  `${DEFAULT_GPU_ALERTS.temperatureSamples} samples`,
);

const inventory = parseGpuProbe(`@@gpu
--pci
0000:00:02.0 VGA compatible controller: Intel Corporation Raptor Lake-P [Iris Xe Graphics] [8086:a7a0] (rev 04)
--amd
@@end`);
check("Unsupported display devices remain inventory-only", inventory.gpus.length === 1 && inventory.gpus[0].source === "inventory" && inventory.gpus[0].utilization === undefined, inventory.gpus[0]?.name);
check("Inventory-only devices explain the missing telemetry", /telemetry driver/i.test(inventory.gpus[0]?.error ?? ""));

const failure = parseGpuProbe(`@@gpu
nvidia_error=NVIDIA-SMI has failed because it could not communicate with the driver.
--pci
--amd
@@end`);
check("A driver failure is surfaced instead of a fake zero", failure.gpus.length === 0 && /could not communicate/i.test(failure.error ?? ""));

const empty = parseGpuProbe(`@@gpu
--pci
--amd
@@end`);
check("A GPU-less host returns an empty list", empty.gpus.length === 0 && empty.error === undefined);

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
