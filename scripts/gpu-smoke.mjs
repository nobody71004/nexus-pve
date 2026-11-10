/**
 * GPU telemetry parser smoke test.
 *
 * Exercises the exact output shapes emitted by the remote probe without
 * requiring NVIDIA or AMD hardware in the test machine.
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
const {
  DEFAULT_GPU_ALERTS,
  evaluateGpuAlerts,
  normalizeGpuAlertOverride,
  normalizeGpuAlertOverrides,
  resolveGpuAlertThresholds,
  pveGpuAlertHostKey,
  sshGpuAlertHostKey,
} = alertModule.exports;

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

// Some kernels expose the amdgpu hwmon node without a usable DRM card path.
const hwmon = parseGpuProbe(`@@gpu
--pci
0000:05:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 10 [Radeon RX 5600 OEM/5600 XT / 5700/5700 XT] [1002:731f] (rev ca)
--amd
--amd-hwmon
amdhwmon|0000:05:00.0|17|3|8573157376|123456789|52000|61000|56000|123000000|1450|90|2100Mhz|875Mhz|amdgpu
@@end`);
check(
  "AMD telemetry falls back to generic hwmon",
  hwmon.gpus.length === 1 &&
    hwmon.gpus[0]?.source === "amdgpu-sysfs" &&
    hwmon.gpus[0]?.temperatureC === 52 &&
    hwmon.gpus[0]?.hotspotC === 61 &&
    hwmon.gpus[0]?.memoryTemperatureC === 56 &&
    hwmon.gpus[0]?.powerW === 123 &&
    hwmon.gpus[0]?.fanRpm === 1450 &&
    hwmon.gpus[0]?.utilization === 17 &&
    hwmon.gpus[0]?.driver === "amdgpu",
  `${hwmon.gpus[0]?.temperatureC}°C / ${hwmon.gpus[0]?.powerW}W / ${hwmon.gpus[0]?.driver}`,
);
check(
  "generic hwmon uses the PCI inventory name and avoids an inventory duplicate",
  hwmon.gpus.length === 1 && /Navi 10/i.test(hwmon.gpus[0]?.name ?? ""),
  hwmon.gpus[0]?.name,
);

// A PCI-only host (no lspci, no DRM card) still has to produce live AMD
// telemetry when amdgpu exposes counters under the PCI device. This is the
// exact shape that previously fell back to "inventory only".
const pciOnly = parseGpuProbe(`@@gpu
--pci
0000:05:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 10 [Radeon RX 5600 OEM/5600 XT / 5700/5700 XT] [1002:731f] (rev ca)
--pci-sysfs
pcisys|0000:05:00.0|0x1002|0x731f|amdgpu|0x030000
--amd
--amd-pci
amd|0000:05:00.0|0x1002|0x731f|27|11|8573157376|1073741824|54000|63000|58000|156000000|1310|82|1900Mhz|875Mhz|amdgpu
--amd-diag
amddiag|0000:05:00.0|amdgpu|1|0
@@end`);
check(
  "AMD PCI-only sysfs probe produces live telemetry",
  pciOnly.gpus.length === 1 &&
    pciOnly.gpus[0]?.source === "amdgpu-sysfs" &&
    pciOnly.gpus[0]?.utilization === 27 &&
    pciOnly.gpus[0]?.temperatureC === 54 &&
    pciOnly.gpus[0]?.memoryUsed === 1073741824,
  `${pciOnly.gpus[0]?.source} / ${pciOnly.gpus[0]?.temperatureC}°C`,
);
check(
  "AMD PCI-only probe uses the lspci name and avoids an inventory duplicate",
  pciOnly.gpus.length === 1 && /Navi 10/i.test(pciOnly.gpus[0]?.name ?? ""),
  pciOnly.gpus[0]?.name,
);

// A VFIO-bound card belongs to a guest. It must stay inventory-only and explain
// why, rather than suggesting that installing amdgpu would fix the host.
const vfio = parseGpuProbe(`@@gpu
--pci
0000:05:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 10 [Radeon RX 5600 OEM/5600 XT / 5700/5700 XT] [1002:731f] (rev ca)
--pci-sysfs
pcisys|0000:05:00.0|0x1002|0x731f|vfio-pci|0x030000
--amd-diag
amddiag|0000:05:00.0|vfio-pci|0|0
@@end`);
check(
  "VFIO-bound AMD GPUs are inventory-only with a passthrough explanation",
  vfio.gpus.length === 1 &&
    vfio.gpus[0]?.source === "inventory" &&
    /vfio/i.test(vfio.gpus[0]?.error ?? "") &&
    /vfio/i.test(vfio.error ?? ""),
  vfio.gpus[0]?.error,
);

const setupScript = readFileSync(path.join(root, "resources", "nexus-gpu-setup.sh"), "utf8");
check(
  "GPU setup script protects VFIO passthrough and handles AMD firmware",
  setupScript.includes("vfio-pci") &&
    setupScript.includes("firmware-amd-graphics") &&
    setupScript.includes("@@result=") &&
    setupScript.includes("@@end"),
);

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
const hostOverride = normalizeGpuAlertOverride({ temperatureC: 92, powerPct: "", vramPct: 150 });
const hostEffective = resolveGpuAlertThresholds(DEFAULT_GPU_ALERTS, hostOverride);
check(
  "host GPU overrides are partial and clamped",
  hostOverride?.temperatureC === 92 &&
    hostOverride?.powerPct === undefined &&
    hostOverride?.vramPct === 100 &&
    !("temperatureSamples" in (hostOverride ?? {})),
  JSON.stringify(hostOverride),
);
check(
  "untouched host GPU limits inherit the global defaults",
  hostEffective.temperatureC === 92 &&
    hostEffective.temperatureSamples === DEFAULT_GPU_ALERTS.temperatureSamples &&
    hostEffective.powerPct === DEFAULT_GPU_ALERTS.powerPct &&
    hostEffective.vramPct === 100,
  JSON.stringify(hostEffective),
);
const pveKey = pveGpuAlertHostKey("endpoint-1", "pve-node-1");
const sshKey = sshGpuAlertHostKey("ssh-host-1");
const scopedOverrides = normalizeGpuAlertOverrides({
  [pveKey]: { temperatureSamples: 5 },
  [sshKey]: { powerPct: 80 },
  global: { temperatureC: 50 },
});
check(
  "host GPU overrides are scoped to Proxmox nodes and SSH hosts",
  Object.keys(scopedOverrides).length === 2 &&
    scopedOverrides[pveKey]?.temperatureSamples === 5 &&
    scopedOverrides[sshKey]?.powerPct === 80 &&
    !("global" in scopedOverrides),
  Object.keys(scopedOverrides).join(", "),
);

const previousHome = process.env.NEXUS_PVE_HOME;
const tempHome = mkdtempSync(path.join(tmpdir(), "nexus-gpu-alerts-"));
process.env.NEXUS_PVE_HOME = tempHome;
try {
  const configBundle = buildSync({
    entryPoints: [path.join(root, "electron", "config.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const configModule = { exports: {} };
  new Function("module", "exports", "require", configBundle.outputFiles[0].text)(
    configModule,
    configModule.exports,
    require,
  );
  const { ConfigStore } = configModule.exports;
  const store = new ConfigStore();
  store.setSettings({ gpuAlertOverrides: { [pveKey]: { temperatureC: 92 } } });
  const afterGlobalChange = store.setSettings({
    gpuAlerts: { ...DEFAULT_GPU_ALERTS, temperatureC: 80 },
  });
  const persisted = store.settings();
  check(
    "host GPU overrides survive a global threshold save",
    afterGlobalChange.gpuAlerts.temperatureC === 80 &&
      persisted.gpuAlertOverrides[pveKey]?.temperatureC === 92,
    JSON.stringify(persisted.gpuAlertOverrides),
  );
  const cleared = store.setSettings({ gpuAlertOverrides: {} });
  check(
    "host GPU overrides can be cleared without resetting global limits",
    Object.keys(cleared.gpuAlertOverrides).length === 0 && cleared.gpuAlerts.temperatureC === 80,
    JSON.stringify(cleared.gpuAlerts),
  );
} finally {
  if (previousHome === undefined) delete process.env.NEXUS_PVE_HOME;
  else process.env.NEXUS_PVE_HOME = previousHome;
  rmSync(tempHome, { recursive: true, force: true });
}
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
check("Inventory-only devices explain the missing telemetry", /telemetry driver/i.test(inventory.gpus[0]?.error ?? ""), inventory.gpus[0]?.error);

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
