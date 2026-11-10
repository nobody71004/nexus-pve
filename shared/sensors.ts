import type { SensorReading } from "./types";

/** Temperature readings only — fans, voltages and watts never masquerade as °C. */
export function isTemperatureSensor(sensor: SensorReading): boolean {
  if (!Number.isFinite(sensor.value)) return false;
  if (/°\s?c|celsius|degrees?\s*c/i.test(sensor.unit)) return true;
  return /temp|thermal|package|tctl|tdie|tccd|coretemp|k10temp|acpitz/i.test(sensor.name);
}

/**
 * CPU package temperature in °C.
 *
 * Proxmox exposes this under several names depending on where the reading came
 * from: coretemp (Intel "Package id 0"), k10temp (AMD "Tctl"/"Tdie"), PVE 9's
 * native sensors API ("coretemp/Package id 0") or an SSH probe
 * ("coretemp-Package id 0"). Prefer the package/junction reading, then the
 * hottest CPU core; never fall back to an NVMe or chipset reading, because the
 * node card labels this value "Package temp".
 */
export function cpuPackageTemp(sensors: SensorReading[]): number | null {
  const temps = sensors.filter(
    (sensor) => isTemperatureSensor(sensor) && sensor.value > -40 && sensor.value < 200,
  );
  if (temps.length === 0) return null;
  const hottest = (pattern: RegExp): number | null => {
    const matches = temps.filter((sensor) => pattern.test(sensor.name));
    return matches.length > 0 ? Math.max(...matches.map((sensor) => sensor.value)) : null;
  };
  const packageTemp = hottest(/package|socket|pkg/i);
  if (packageTemp !== null) return packageTemp;
  const junctionTemp = hottest(/tctl|tdie/i);
  if (junctionTemp !== null) return junctionTemp;
  return hottest(/cpu|coretemp|k10temp|peci|tccd|soc(?:_thermal)?|core\b/i);
}
