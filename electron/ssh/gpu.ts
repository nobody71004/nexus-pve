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

# Sysfs inventory is the fallback when lspci is not installed and, more
# importantly, tells us which kernel driver owns each display device. That is
# what lets the UI explain vfio-pci passthrough instead of suggesting a driver
# install that would break the guest.
echo "--pci-sysfs"
for dev in /sys/bus/pci/devices/*; do
  [ -r "$dev/vendor" ] || continue
  class=$(cat "$dev/class" 2>/dev/null || true)
  case "$class" in
    0x0300*|0x0302*|0x0380*) ;;
    *) continue ;;
  esac
  pci=$(basename "$dev")
  vendor=$(cat "$dev/vendor" 2>/dev/null || true)
  device=$(cat "$dev/device" 2>/dev/null || true)
  driver=$(basename "$(readlink -f "$dev/driver" 2>/dev/null)" 2>/dev/null || true)
  echo "pcisys|$pci|$vendor|$device|$driver|$class"
done

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
  # A DRM card can exist while the driver exposes no counters. Do not turn that
  # into a fake "live" GPU row: leave it to the PCI/hwmon fallback and the
  # inventory diagnostic instead.
  if [ -z "$busy$membusy$vram_total$vram_used$temp1$temp2$temp3$power$fan_rpm$pwm$sclk$mclk" ]; then
    continue
  fi
  echo "amd|$pci|$vendor|$device|$busy|$membusy|$vram_total|$vram_used|$temp1|$temp2|$temp3|$power|$fan_rpm|$pwm|$sclk|$mclk|$driver"
done

# Some kernels expose amdgpu hwmon without a usable /sys/class/drm/card* path
# (notably passthrough/container setups). Match the generic hwmon device by
# its name and join it back to the PCI address instead of giving up.
echo "--amd-hwmon"
for h in /sys/class/hwmon/hwmon*; do
  [ -r "$h/name" ] || continue
  hw_name=$(cat "$h/name" 2>/dev/null || true)
  [ "$hw_name" = "amdgpu" ] || continue
  pci=$(sed -n 's/^PCI_SLOT_NAME=//p' "$h/device/uevent" 2>/dev/null | head -1)
  [ -n "$pci" ] || pci=$(basename "$(readlink -f "$h/device" 2>/dev/null)" 2>/dev/null || true)
  [ -n "$pci" ] || continue
  busy=$(cat "$h/device/gpu_busy_percent" 2>/dev/null || true)
  membusy=$(cat "$h/device/mem_busy_percent" 2>/dev/null || true)
  vram_total=$(cat "$h/device/mem_info_vram_total" 2>/dev/null || true)
  vram_used=$(cat "$h/device/mem_info_vram_used" 2>/dev/null || true)
  temp1=$(cat "$h/temp1_input" 2>/dev/null || true)
  temp2=$(cat "$h/temp2_input" 2>/dev/null || true)
  temp3=$(cat "$h/temp3_input" 2>/dev/null || true)
  power=$(cat "$h/power1_average" 2>/dev/null || cat "$h/power1_input" 2>/dev/null || true)
  fan_rpm=$(cat "$h/fan1_input" 2>/dev/null || true)
  pwm=$(cat "$h/pwm1" 2>/dev/null || true)
  sclk=$(awk '/\*/ {print $2; exit}' "$h/device/pp_dpm_sclk" 2>/dev/null || true)
  mclk=$(awk '/\*/ {print $2; exit}' "$h/device/pp_dpm_mclk" 2>/dev/null || true)
  driver=$(basename "$(readlink -f "$h/device/driver" 2>/dev/null)" 2>/dev/null || true)
  echo "amdhwmon|$pci|$busy|$membusy|$vram_total|$vram_used|$temp1|$temp2|$temp3|$power|$fan_rpm|$pwm|$sclk|$mclk|$driver"
done

# Scan the PCI device itself as well. Some kernels/passthrough setups do not
# create a usable /sys/class/drm/card* entry even though amdgpu exposes hwmon
# and gpu_busy_percent under the PCI device. This is the fallback for Navi 10
# and other cards that otherwise appear as inventory only.
echo "--amd-pci"
for dev in /sys/bus/pci/devices/*; do
  [ -r "$dev/vendor" ] || continue
  [ "$(cat "$dev/vendor" 2>/dev/null || true)" = "0x1002" ] || continue
  class=$(cat "$dev/class" 2>/dev/null || true)
  case "$class" in
    0x0300*|0x0302*|0x0380*) ;;
    *) continue ;;
  esac
  pci=$(basename "$dev")
  device=$(cat "$dev/device" 2>/dev/null || true)
  driver=$(basename "$(readlink -f "$dev/driver" 2>/dev/null)" 2>/dev/null || true)
  hwmon=""
  for h in "$dev"/hwmon/hwmon*; do
    [ -d "$h" ] || continue
    hwmon="$h"
    break
  done
  if [ -z "$hwmon" ]; then
    target=$(readlink -f "$dev" 2>/dev/null || true)
    for h in /sys/class/hwmon/hwmon*; do
      [ "$(readlink -f "$h/device" 2>/dev/null)" = "$target" ] || continue
      hwmon="$h"
      break
    done
  fi
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
  busy=$(cat "$dev/gpu_busy_percent" 2>/dev/null || true)
  membusy=$(cat "$dev/mem_busy_percent" 2>/dev/null || true)
  vram_total=$(cat "$dev/mem_info_vram_total" 2>/dev/null || true)
  vram_used=$(cat "$dev/mem_info_vram_used" 2>/dev/null || true)
  if [ -z "$busy" ]; then
    for card in /sys/class/drm/card[0-9]*; do
      [ "$(readlink -f "$card/device" 2>/dev/null)" = "$(readlink -f "$dev" 2>/dev/null)" ] || continue
      busy=$(cat "$card/device/gpu_busy_percent" 2>/dev/null || true)
      membusy=$(cat "$card/device/mem_busy_percent" 2>/dev/null || true)
      vram_total=$(cat "$card/device/mem_info_vram_total" 2>/dev/null || true)
      vram_used=$(cat "$card/device/mem_info_vram_used" 2>/dev/null || true)
      break
    done
  fi
  sclk=$(awk '/\*/ {print $2; exit}' "$dev/pp_dpm_sclk" 2>/dev/null || true)
  mclk=$(awk '/\*/ {print $2; exit}' "$dev/pp_dpm_mclk" 2>/dev/null || true)
  # Do not create a live row with no counters; the inventory row + diagnostic
  # is more honest and lets the UI offer the repair path.
  if [ -z "$busy$membusy$vram_total$vram_used$temp1$temp2$temp3$power$fan_rpm$pwm$sclk$mclk" ]; then
    continue
  fi
  echo "amd|$pci|0x1002|$device|$busy|$membusy|$vram_total|$vram_used|$temp1|$temp2|$temp3|$power|$fan_rpm|$pwm|$sclk|$mclk|$driver"
done

# Driver diagnostics are separate from counters: a VFIO-bound card has no
# amdgpu counters by design and must never be claimed from the host.
echo "--amd-diag"
for dev in /sys/bus/pci/devices/*; do
  [ -r "$dev/vendor" ] || continue
  [ "$(cat "$dev/vendor" 2>/dev/null || true)" = "0x1002" ] || continue
  class=$(cat "$dev/class" 2>/dev/null || true)
  case "$class" in
    0x0300*|0x0302*|0x0380*) ;;
    *) continue ;;
  esac
  pci=$(basename "$dev")
  driver=$(basename "$(readlink -f "$dev/driver" 2>/dev/null)" 2>/dev/null || true)
  hwmon=""
  for h in "$dev"/hwmon/hwmon*; do
    [ -d "$h" ] && { hwmon=1; break; }
  done
  if [ -z "$hwmon" ]; then
    target=$(readlink -f "$dev" 2>/dev/null || true)
    for h in /sys/class/hwmon/hwmon*; do
      [ "$(readlink -f "$h/device" 2>/dev/null)" = "$target" ] && { hwmon=1; break; }
    done
  fi
  blacklist=0
  if grep -Rhsq '^[[:space:]]*blacklist[[:space:]]\+amdgpu' /etc/modprobe.d 2>/dev/null; then
    blacklist=1
  fi
  echo "amddiag|$pci|$driver|$hwmon|$blacklist"
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

interface PciSysfsEntry {
  vendor: GpuTelemetry["vendor"];
  device?: string;
  driver?: string;
  className?: string;
}

interface AmdDiag {
  driver?: string;
  hwmon: boolean;
  vfio: boolean;
  blacklist: boolean;
}

interface AmdHwmonMetrics {
  utilization?: number;
  memoryUtilization?: number;
  memoryTotal?: number;
  memoryUsed?: number;
  temperatureC?: number;
  hotspotC?: number;
  memoryTemperatureC?: number;
  powerW?: number;
  fanRpm?: number;
  fanPercent?: number;
  clockMhz?: number;
  memoryClockMhz?: number;
  driver?: string;
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
  // Check Intel before ATI: "Corporation" contains the letters "ati", which
  // would otherwise misclassify every Intel display device as AMD.
  if (/intel/i.test(name)) return "intel";
  if (/amd|advanced micro|\bati\b/i.test(name)) return "amd";
  return "unknown";
}

function vendorFromPciId(id: string | undefined): GpuTelemetry["vendor"] {
  if (id === "0x10de") return "nvidia";
  if (id === "0x1002") return "amd";
  if (id === "0x8086") return "intel";
  return "unknown";
}

function mergeGpu(target: GpuTelemetry, patch: GpuTelemetry): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const record = target as unknown as Record<string, unknown>;
    if (record[key] === undefined) record[key] = value;
  }
}

function amdGpu(fields: string[], pciNames: Map<string, PciEntry>): GpuTelemetry {
  const pci = fields[1] || undefined;
  const name = pciNames.get(pci ?? "")?.name ?? `AMD GPU ${fields[2] || ""}`.trim();
  const pwm = number(fields[13]);
  return {
    id: pci ?? `amd-${fields[2] || "unknown"}`,
    index: 0,
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
  };
}

function inventoryError(
  vendor: GpuTelemetry["vendor"],
  sys: PciSysfsEntry | undefined,
  diag: AmdDiag | undefined,
): string {
  const driver = diag?.driver || sys?.driver;
  if (vendor === "amd") {
    if (driver === "vfio-pci" || diag?.vfio) {
      return "AMD GPU is bound to vfio-pci for VM passthrough. Release it from the guest before expecting host telemetry.";
    }
    if (diag?.blacklist) {
      return "amdgpu is blacklisted in /etc/modprobe.d. Remove the blacklist and reboot, then run Auto-install GPU sensors.";
    }
    if (driver === "amdgpu") {
      return "amdgpu is loaded but exposes no hwmon counters. Reboot after a kernel/firmware update, or run Auto-install GPU sensors.";
    }
    if (!driver) {
      return "No kernel driver is bound to this AMD GPU. Run Auto-install GPU sensors to install firmware and load amdgpu.";
    }
    return `AMD GPU is bound to ${driver} without live counters. Run Auto-install GPU sensors to repair the sensor stack.`;
  }
  if (vendor === "nvidia") {
    return "No live NVIDIA counters. Install the NVIDIA driver and nvidia-smi, then reboot.";
  }
  if (vendor === "intel") return "No live telemetry driver exposed for this Intel display device.";
  return "No live telemetry driver exposed for this display device.";
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
  const pciSysfs = new Map<string, PciSysfsEntry>();
  const amdDiag = new Map<string, AmdDiag>();
  const amdHwmon = new Map<string, AmdHwmonMetrics>();
  let nvidiaError: string | undefined;
  let telemetryHint: string | undefined;
  let mode: "nvidia" | "procs" | "pci" | "pci-sysfs" | "amd" | "amd-pci" | "amd-hwmon" | "amd-diag" | null = null;

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
    if (line === "--pci-sysfs") {
      mode = "pci-sysfs";
      continue;
    }
    if (line === "--amd") {
      mode = "amd";
      continue;
    }
    if (line === "--amd-pci") {
      mode = "amd-pci";
      continue;
    }
    if (line === "--amd-hwmon") {
      mode = "amd-hwmon";
      continue;
    }
    if (line === "--amd-diag") {
      mode = "amd-diag";
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

    if (mode === "pci-sysfs") {
      const fields = line.split("|").map((value) => value.trim());
      if (fields.length < 6 || fields[0] !== "pcisys") continue;
      pciSysfs.set(fields[1], {
        vendor: vendorFromPciId(fields[2]),
        device: text(fields[3]),
        driver: text(fields[4]),
        className: text(fields[5]),
      });
      continue;
    }

    if (mode === "amd-diag") {
      const fields = line.split("|").map((value) => value.trim());
      if (fields.length < 5 || fields[0] !== "amddiag") continue;
      amdDiag.set(fields[1], {
        driver: text(fields[2]),
        hwmon: fields[3] === "1",
        blacklist: fields[4] === "1",
        vfio: fields[2] === "vfio-pci",
      });
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

    if (mode === "amd" || mode === "amd-pci") {
      const fields = line.split("|").map((value) => value.trim());
      if (fields.length < 17 || fields[0] !== "amd") continue;
      const next = amdGpu(fields, pciNames);
      const existing = gpus.find((gpu) => gpu.vendor === "amd" && gpu.pci === next.pci);
      if (existing) {
        mergeGpu(existing, next);
      } else {
        next.index = gpus.length;
        gpus.push(next);
      }
      continue;
    }

    if (mode === "amd-hwmon") {
      const fields = line.split("|").map((value) => value.trim());
      if (fields.length < 15 || fields[0] !== "amdhwmon") continue;
      const pci = fields[1];
      if (!pci) continue;
      const pwm = number(fields[11]);
      amdHwmon.set(pci, {
        utilization: number(fields[2]),
        memoryUtilization: number(fields[3]),
        memoryTotal: number(fields[4]),
        memoryUsed: number(fields[5]),
        temperatureC: number(fields[6]) === undefined ? undefined : number(fields[6])! / 1000,
        hotspotC: number(fields[7]) === undefined ? undefined : number(fields[7])! / 1000,
        memoryTemperatureC: number(fields[8]) === undefined ? undefined : number(fields[8])! / 1000,
        powerW: number(fields[9]) === undefined ? undefined : number(fields[9])! / 1_000_000,
        fanRpm: number(fields[10]),
        fanPercent: pwm === undefined ? undefined : Math.round((pwm / 255) * 100),
        clockMhz: number(fields[12]),
        memoryClockMhz: number(fields[13]),
        driver: text(fields[14]),
      });
    }
  }

  for (const [pci, metrics] of amdHwmon) {
    const existing = gpus.find((gpu) => gpu.vendor === "amd" && gpu.pci === pci);
    if (existing) {
      existing.utilization ??= metrics.utilization;
      existing.memoryUtilization ??= metrics.memoryUtilization;
      existing.memoryTotal ??= metrics.memoryTotal;
      existing.memoryUsed ??= metrics.memoryUsed;
      existing.temperatureC ??= metrics.temperatureC;
      existing.hotspotC ??= metrics.hotspotC;
      existing.memoryTemperatureC ??= metrics.memoryTemperatureC;
      existing.powerW ??= metrics.powerW;
      existing.fanRpm ??= metrics.fanRpm;
      existing.fanPercent ??= metrics.fanPercent;
      existing.clockMhz ??= metrics.clockMhz;
      existing.memoryClockMhz ??= metrics.memoryClockMhz;
      existing.driver ??= metrics.driver;
      continue;
    }
    const hasTelemetry = [
      metrics.utilization,
      metrics.memoryUtilization,
      metrics.memoryTotal,
      metrics.memoryUsed,
      metrics.temperatureC,
      metrics.hotspotC,
      metrics.memoryTemperatureC,
      metrics.powerW,
      metrics.fanRpm,
      metrics.fanPercent,
      metrics.clockMhz,
      metrics.memoryClockMhz,
    ].some((value) => value !== undefined);
    if (!hasTelemetry) continue;
    gpus.push({
      id: pci,
      index: gpus.length,
      name: pciNames.get(pci)?.name ?? "AMD GPU",
      vendor: "amd",
      pci,
      ...metrics,
      driver: metrics.driver ?? "amdgpu",
      source: "amdgpu-sysfs",
    });
  }

  // lspci may be missing (minimal hosts), so sysfs display devices are also
  // inventory candidates. Keep the descriptive lspci name when it exists.
  for (const [pci, sys] of pciSysfs) {
    if (pciNames.has(pci)) continue;
    const label = sys.vendor === "unknown" ? "Display device" : `${sys.vendor.toUpperCase()} GPU`;
    pciNames.set(pci, { name: `${label} ${sys.device ?? ""}`.trim(), vendor: sys.vendor });
  }

  // Bring in display devices whose driver exposes no counters (for example an
  // Intel iGPU or a GPU with no management tool installed). These are inventory
  // rows, not fake zero-percent readings.
  const covered = new Set(gpus.map((gpu) => gpu.pci).filter((pci): pci is string => Boolean(pci)));
  const hasLiveAmd = gpus.some((gpu) => gpu.vendor === "amd" && gpu.source !== "inventory");
  for (const [pci, entry] of pciNames) {
    if (covered.has(pci)) continue;
    const sys = pciSysfs.get(pci);
    const diag = amdDiag.get(pci);
    const diagnostic = inventoryError(entry.vendor, sys, diag);
    if (!telemetryHint && entry.vendor === "amd" && !hasLiveAmd) telemetryHint = diagnostic;
    gpus.push({
      id: pci,
      index: gpus.length,
      name: entry.name,
      vendor: entry.vendor,
      pci,
      ...(sys?.driver ? { driver: sys.driver } : {}),
      source: "inventory",
      error: diagnostic,
    });
  }

  for (const gpu of gpus) {
    const appList = processes.get(gpu.id);
    if (appList?.length) gpu.processes = appList;
  }

  const error = nvidiaError && gpus.length === 0 ? nvidiaError : telemetryHint;
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
