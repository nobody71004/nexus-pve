import type { GpuHistory, GpuProcess, GpuTelemetry } from "../../shared/types";

/**
 * Read-only GPU probe. NVIDIA is queried through nvidia-smi; AMD is read from
 * the amdgpu sysfs interface; lspci supplies names and catches display devices
 * whose driver does not expose live counters. It never writes to the host and
 * every command is allowed to fail independently, so one missing tool cannot
 * hide the other vendor or the rest of the server probe.
 */
export const GPU_PROBE_BODY = String.raw`
echo "@@gpu"
if command -v nvidia-smi >/dev/null 2>&1; then
  NV_OUT=$(nvidia-smi --query-gpu=index,uuid,name,driver_version,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.used,power.draw,power.limit,fan.speed,clocks.current.graphics,clocks.current.memory,pstate,pcie.link.gen.current,pcie.link.width.current,pci.bus_id --format=csv,noheader,nounits 2>&1)
  NV_RC=$?
  if [ "$NV_RC" -eq 0 ]; then
    echo "--nvidia"
    printf '%s\n' "$NV_OUT"
    if PROCS=$(nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null); then
      echo "--nvidia-procs"
      printf '%s\n' "$PROCS"
    fi
  else
    echo "nvidia_error=$(printf '%s' "$NV_OUT" | tr '\n' ' ' | cut -c1-240)"
  fi
fi

echo "--pci"
lspci -Dnn 2>/dev/null | grep -E 'VGA compatible|3D controller|Display controller' | head -12 || true

echo "--amd"
for card in /sys/class/drm/card[0-9]*; do
  [ -r "$card/device/vendor" ] || continue
  vendor=$(cat "$card/device/vendor" 2>/dev/null || true)
  [ "$vendor" = "0x1002" ] || continue
  pci=$(basename "$(readlink -f "$card/device" 2>/dev/null)" 2>/dev/null || true)
  device=$(cat "$card/device/device" 2>/dev/null || true)
  driver=$(basename "$(readlink -f "$card/device/driver" 2>/dev/null)" 2>/dev/null || true)
  busy=$(cat "$card/device/gpu_busy_percent" 2>/dev/null || true)
  membusy=$(cat "$card/device/mem_busy_percent" 2>/dev/null || true)
  vram_total=$(cat "$card/device/mem_info_vram_total" 2>/dev/null || true)
  vram_used=$(cat "$card/device/mem_info_vram_used" 2>/dev/null || true)
  hwmon=""
  for h in "$card/device/hwmon"/hwmon*; do
    [ -d "$h" ] || continue
    hwmon="$h"
    break
  done
  temp1=""
  temp2=""
  temp3=""
  power=""
  fan_rpm=""
  pwm=""
  if [ -n "$hwmon" ]; then
    temp1=$(cat "$hwmon/temp1_input" 2>/dev/null || true)
    temp2=$(cat "$hwmon/temp2_input" 2>/dev/null || true)
    temp3=$(cat "$hwmon/temp3_input" 2>/dev/null || true)
    power=$(cat "$hwmon/power1_average" 2>/dev/null || cat "$hwmon/power1_input" 2>/dev/null || true)
    fan_rpm=$(cat "$hwmon/fan1_input" 2>/dev/null || true)
    pwm=$(cat "$hwmon/pwm1" 2>/dev/null || true)
  fi
  sclk=$(awk '/\*/ {print $2; exit}' "$card/device/pp_dpm_sclk" 2>/dev/null || true)
  mclk=$(awk '/\*/ {print $2; exit}' "$card/device/pp_dpm_mclk" 2>/dev/null || true)
  echo "amd|$pci|$vendor|$device|$busy|$membusy|$vram_total|$vram_used|$temp1|$temp2|$temp3|$power|$fan_rpm|$pwm|$sclk|$mclk|$driver"
done
`;

export const GPU_PROBE = `export LC_ALL=C\n${GPU_PROBE_BODY}\necho "@@end"\n`;

export interface GpuProbeResult {
  gpus: GpuTelemetry[];
  error?: string;
}

interface PciEntry {
  name: string;
  vendor: GpuTelemetry["vendor"];
}

function gpuSection(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "@@gpu") {
      inside = true;
      continue;
    }
    if (inside && trimmed.startsWith("@@")) break;
    if (inside) out.push(line);
  }
  return out;
}

function number(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (!raw || /^\[?n\/a\]?$/i.test(raw) || /^not supported$/i.test(raw)) return undefined;
  const parsed = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw || /^\[?n\/a\]?$/i.test(raw) || /^not supported$/i.test(raw)) return undefined;
  return raw;
}

function mibToBytes(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 1024 * 1024);
}

function vendorFromName(name: string): GpuTelemetry["vendor"] {
  if (/nvidia/i.test(name)) return "nvidia";
  if (/amd|ati|advanced micro/i.test(name)) return "amd";
  if (/intel/i.test(name)) return "intel";
  return "unknown";
}

function parsePci(lines: string[]): Map<string, PciEntry> {
  const out = new Map<string, PciEntry>();
  for (const line of lines) {
    const match = /^([0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7])\s+[^:]+:\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const name = match[2]
      .replace(/\s+\[[0-9a-fA-F]{4}:[0-9a-fA-F]{4}\](?:\s+\(rev [^)]+\))?$/, "")
      .replace(/\s+\(rev [^)]+\)$/, "")
      .trim();
    if (!name) continue;
    out.set(match[1], { name, vendor: vendorFromName(name) });
  }
  return out;
}

/**
 * Parses the raw `@@gpu` section. The parser is deliberately independent of
 * SSH transport so it can be tested with captured command output.
 */
export function parseGpuProbe(stdout: string): GpuProbeResult {
  const lines = gpuSection(stdout);
  const gpus: GpuTelemetry[] = [];
  const processes = new Map<string, GpuProcess[]>();
  const pciNames = new Map<string, PciEntry>();
  let nvidiaError: string | undefined;
  let mode: "nvidia" | "procs" | "pci" | "amd" | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "--nvidia") {
      mode = "nvidia";
      continue;
    }
    if (line === "--nvidia-procs") {
      mode = "procs";
      continue;
    }
    if (line === "--pci") {
      mode = "pci";
      continue;
    }
    if (line === "--amd") {
      mode = "amd";
      continue;
    }
    if (line.startsWith("nvidia_error=")) {
      nvidiaError = line.slice("nvidia_error=".length).trim().slice(0, 240) || "nvidia-smi failed";
      continue;
    }

    if (mode === "pci") {
      for (const [pci, entry] of parsePci([line])) pciNames.set(pci, entry);
      continue;
    }

    if (mode === "procs") {
      const fields = line.split(",").map((value) => value.trim());
      if (fields.length < 4) continue;
      const uuid = fields[0];
      const list = processes.get(uuid) ?? [];
      list.push({
        pid: number(fields[1]),
        name: text(fields[2]) ?? "process",
        memoryUsed: mibToBytes(number(fields[3])),
      });
      processes.set(uuid, list);
      continue;
    }

    if (mode === "nvidia") {
      const fields = line.split(",").map((value) => value.trim());
      if (fields.length < 18) continue;
      const index = number(fields[0]) ?? gpus.length;
      const uuid = fields[1] || `nvidia-${index}`;
      const pci = text(fields[17]);
      const name = text(fields[2]) ?? pciNames.get(pci ?? "")?.name ?? `NVIDIA GPU ${index}`;
      gpus.push({
        id: uuid,
        index,
        name,
        vendor: "nvidia",
        ...(pci ? { pci } : {}),
        utilization: number(fields[5]),
        memoryUtilization: number(fields[6]),
        temperatureC: number(fields[4]),
        memoryTotal: mibToBytes(number(fields[7])),
        memoryUsed: mibToBytes(number(fields[8])),
        powerW: number(fields[9]),
        powerLimitW: number(fields[10]),
        fanPercent: number(fields[11]),
        clockMhz: number(fields[12]),
        memoryClockMhz: number(fields[13]),
        pstate: text(fields[14]),
        driver: text(fields[3]),
        pcieGeneration: number(fields[15]),
        pcieWidth: number(fields[16]),
        ...(processes.get(uuid) ? { processes: processes.get(uuid) } : {}),
        source: "nvidia-smi",
      });
      continue;
    }

    if (mode === "amd") {
      const fields = line.split("|").map((value) => value.trim());
      if (fields.length < 17 || fields[0] !== "amd") continue;
      const pci = fields[1] || undefined;
      const name = pciNames.get(pci ?? "")?.name ?? `AMD GPU ${fields[2] || ""}`.trim();
      const pwm = number(fields[13]);
      gpus.push({
        id: pci ?? `amd-${gpus.length}`,
        index: gpus.length,
        name,
        vendor: "amd",
        ...(pci ? { pci } : {}),
        utilization: number(fields[4]),
        memoryUtilization: number(fields[5]),
        memoryTotal: number(fields[6]),
        memoryUsed: number(fields[7]),
        temperatureC: number(fields[8]) === undefined ? undefined : number(fields[8])! / 1000,
        hotspotC: number(fields[9]) === undefined ? undefined : number(fields[9])! / 1000,
        memoryTemperatureC: number(fields[10]) === undefined ? undefined : number(fields[10])! / 1000,
        powerW: number(fields[11]) === undefined ? undefined : number(fields[11])! / 1_000_000,
        fanRpm: number(fields[12]),
        fanPercent: pwm === undefined ? undefined : Math.round((pwm / 255) * 100),
        clockMhz: number(fields[14]),
        memoryClockMhz: number(fields[15]),
        driver: text(fields[16]),
        source: "amdgpu-sysfs",
      });
    }
  }

  // Bring in display devices whose driver exposes no counters (for example an
  // Intel iGPU or a GPU with no management tool installed). These are inventory
  // rows, not fake zero-percent readings.
  const covered = new Set(gpus.map((gpu) => gpu.pci).filter((pci): pci is string => Boolean(pci)));
  for (const [pci, entry] of pciNames) {
    if (covered.has(pci)) continue;
    gpus.push({
      id: pci,
      index: gpus.length,
      name: entry.name,
      vendor: entry.vendor,
      pci,
      source: "inventory",
      error: "No live telemetry driver exposed for this display device.",
    });
  }

  for (const gpu of gpus) {
    const appList = processes.get(gpu.id);
    if (appList?.length) gpu.processes = appList;
  }

  const error = nvidiaError && gpus.length === 0 ? nvidiaError : undefined;
  return { gpus, ...(error ? { error } : {}) };
}

const GPU_HISTORY_SAMPLES = 120;
const gpuHistory = new Map<string, Map<string, GpuHistory>>();

/** Stable identity across polls: NVIDIA UUID, AMD/Intel PCI address, else index. */
function gpuHistoryKey(gpu: GpuTelemetry): string {
  return gpu.id || gpu.pci || `${gpu.vendor}-${gpu.index}`;
}

function pushSample(series: number[], value: number | undefined): number[] {
  if (value === undefined || !Number.isFinite(value)) return series;
  return [...series, value].slice(-GPU_HISTORY_SAMPLES);
}

/**
 * Keep a small in-memory ring buffer per configured host and GPU so the UI can
 * draw utilization and temperature trends. History lives as long as the app
 * process and is never written to disk.
 */
export function recordGpuHistory(hostKey: string, gpus: GpuTelemetry[]): GpuTelemetry[] {
  let hostHistory = gpuHistory.get(hostKey);
  if (!hostHistory) {
    hostHistory = new Map();
    gpuHistory.set(hostKey, hostHistory);
  }
  const seen = new Set<string>();
  const withHistory = gpus.map((gpu) => {
    const key = gpuHistoryKey(gpu);
    seen.add(key);
    const previous = hostHistory!.get(key) ?? { utilization: [], temperatureC: [] };
    const next: GpuHistory = {
      utilization: pushSample(previous.utilization, gpu.utilization),
      temperatureC: pushSample(previous.temperatureC, gpu.temperatureC),
    };
    hostHistory!.set(key, next);
    return { ...gpu, history: next };
  });
  for (const key of hostHistory.keys()) {
    if (!seen.has(key)) hostHistory.delete(key);
  }
  return withHistory;
}

/** Drop history when a host is removed or its connection settings change. */
export function clearGpuHistory(hostKey: string): void {
  gpuHistory.delete(hostKey);
}
