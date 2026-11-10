import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { GPU_PROBE_BODY, parseGpuProbe } from "./gpu";
import { execSsh2 } from "./transport";
import type {
  SshDisk,
  SshHostInput,
  SshHostSummary,
  SshNic,
  SshPressure,
  SshSample,
  SshSnapshot,
  SshTestResult,
} from "../../shared/types";

/**
 * One read-only pass over a plain Linux host. Everything runs through the
 * operating system's OpenSSH client, so no extra native dependency is shipped
 * and the user's own ssh_config, agent and known_hosts still apply.
 *
 * The remote side only reads /proc, /sys, df and systemctl. Nothing is written
 * and nothing needs sudo: sections that a non-root user cannot read simply come
 * back empty.
 */
const REMOTE_PROBE = `
export LC_ALL=C
echo "@@ident"
echo "hostname=$(hostname 2>/dev/null)"
grep -E '^PRETTY_NAME=' /etc/os-release 2>/dev/null | head -1
grep -E '^VERSION_ID=' /etc/os-release 2>/dev/null | head -1
echo "kernel=$(uname -r 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
echo "uptime=$(cut -d. -f1 /proc/uptime 2>/dev/null)"

echo "@@cpu"
grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//' || true
grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 0
cat /proc/loadavg 2>/dev/null || true
head -1 /proc/stat 2>/dev/null || true
sleep 0.4
head -1 /proc/stat 2>/dev/null || true
echo "mhz=$(awk -F: '/cpu MHz/ {s+=$2; n++} END {if (n>0) printf "%.0f", s/n}' /proc/cpuinfo 2>/dev/null)"
echo "sockets=$(awk -F: '/^physical id/ {gsub(/ /,"",$2); if (!seen[$2]++) n++} END {print n+0}' /proc/cpuinfo 2>/dev/null)"
echo "physical_cores=$(awk -F: '/^physical id/ {s=$2} /^core id/ {c=$2; gsub(/ /,"",s); gsub(/ /,"",c); k=s":"c; if (!seen[k]++) n++} END {print n+0}' /proc/cpuinfo 2>/dev/null)"
echo "cores_per_socket=$(awk -F: '/^cpu cores/ {gsub(/ /,"",$2); print $2; exit}' /proc/cpuinfo 2>/dev/null)"

echo "@@mem"
grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null || true

echo "@@disk"
df -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x ramfs 2>/dev/null | tail -n +2 || true

echo "@@block"
lsblk -bdno NAME,TYPE,MODEL,SIZE,ROTA,SERIAL -P 2>/dev/null | head -12 || true

echo "@@net"
cat /proc/net/dev 2>/dev/null || true

echo "@@netinfo"
for iface in /sys/class/net/*; do
  [ -e "$iface" ] || continue
  name=$(basename "$iface")
  [ "$name" = "lo" ] && continue
  speed=$(cat "$iface/speed" 2>/dev/null || true)
  state=$(cat "$iface/operstate" 2>/dev/null || true)
  mtu=$(cat "$iface/mtu" 2>/dev/null || true)
  mac=$(cat "$iface/address" 2>/dev/null || true)
  echo "$name|$speed|$state|$mtu|$mac"
done

echo "@@temp"
for zone in /sys/class/thermal/thermal_zone*; do
  [ -r "$zone/temp" ] || continue
  echo "$(cat "$zone/type" 2>/dev/null)-$(basename "$zone")|$(cat "$zone/temp" 2>/dev/null)"
done
for chip in /sys/class/hwmon/hwmon*; do
  [ -r "$chip/name" ] || continue
  for t in "$chip"/temp*_input; do
    [ -r "$t" ] || continue
    label=$(cat "\${t%_input}_label" 2>/dev/null)
    [ -n "$label" ] || label=$(basename "$t" _input)
    echo "$(cat "$chip/name" 2>/dev/null)-$label|$(cat "$t" 2>/dev/null)"
  done
done

echo "@@psi"
for f in cpu memory io; do
  [ -r /proc/pressure/$f ] || continue
  echo "--$f"
  cat /proc/pressure/$f 2>/dev/null
done

echo "@@svc"
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | head -40 || true

echo "@@failed"
systemctl list-units --state=failed --plain --no-pager --no-legend 2>/dev/null | awk '{print $1}' | head -20 || true

echo "@@docker"
if command -v docker >/dev/null 2>&1; then
  docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null | head -20 || true
fi

echo "@@proc"
ps -eo comm,%cpu,%mem,rss --sort=-%cpu --no-headers 2>/dev/null | head -8 || true

echo "@@sec"
echo "uid=$(id -u 2>/dev/null || echo -1)"
echo "authlog=$(grep -c 'Failed password' /var/log/auth.log 2>/dev/null | head -1)"
echo "journal=$(journalctl -u ssh -u sshd --since '24 hours ago' --no-pager 2>/dev/null | grep -c 'Failed password')"
if command -v ufw >/dev/null 2>&1; then
  STATUS=$(ufw status 2>/dev/null | head -1)
  [ -n "$STATUS" ] || STATUS=$(sudo -n ufw status 2>/dev/null | head -1)
  echo "ufw=$STATUS"
else
  RULES=$(nft list ruleset 2>/dev/null | grep -c 'hook input')
  [ "$RULES" != "0" ] || RULES=$(sudo -n nft list ruleset 2>/dev/null | grep -c 'hook input')
  echo "nft=$RULES"
fi
[ -r /etc/ufw/ufw.conf ] && grep -m1 '^ENABLED=' /etc/ufw/ufw.conf | sed 's/^/ufwconf=/' || true
# Drop-ins override the main file, so print both and let the last value win.
grep -hE '^(PasswordAuthentication|PermitRootLogin)[[:space:]]' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | head -8 || true
SSHD=$(command -v sshd || echo /usr/sbin/sshd)
if [ -x "$SSHD" ]; then
  { "$SSHD" -T 2>/dev/null || sudo -n "$SSHD" -T 2>/dev/null; } | grep -E '^(passwordauthentication|permitrootlogin) ' || true
fi

${GPU_PROBE_BODY}

echo "@@end"
`;

export interface ProbeRunner {
  host: string;
  port: number;
  username: string;
  keyPath?: string;
  password?: string;
  timeoutMs?: number;
}

function expandHome(value: string): string {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function sshTarget(input: { host: string; username: string; port: number }): string {
  return `${input.username}@${input.host}`;
}

/** Arguments shared by the probe and by ad-hoc command execution. */
export function sshArgs(runner: ProbeRunner): string[] {
  const args = [
    "-p",
    String(runner.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "LogLevel=ERROR",
  ];
  if (runner.keyPath) {
    const key = expandHome(runner.keyPath);
    args.push("-i", key, "-o", "IdentitiesOnly=yes");
  }
  args.push(sshTarget(runner));
  return args;
}

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  latencyMs: number;
}

/**
 * Runs the probe script on the remote host. `bash -s` reads the script from
 * stdin, which keeps quoting out of the ssh command line entirely.
 */
export function runRemote(runner: ProbeRunner, script = REMOTE_PROBE, shell = "bash"): Promise<RunResult> {
  if (runner.password) {
    return execSsh2(runner, `${shell} -s`, { timeoutMs: runner.timeoutMs, feed: script });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("ssh", [...sshArgs(runner), shell, "-s"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({ ok: false, code: null, stdout, stderr: `${stderr}\nprobe timed out`, latencyMs: Date.now() - started });
      }
    }, runner.timeoutMs ?? 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 512_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 32_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: error.message, latencyMs: Date.now() - started });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, latencyMs: Date.now() - started });
    });
    child.stdin.on("error", () => {
      /* The remote side may close stdin early; the exit code still tells the story. */
    });
    child.stdin.end(script);
  });
}



/* --------------------------------------------------------------- parsing */

function sections(stdout: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current = "";
  for (const line of stdout.split(/\r?\n/)) {
    const marker = /^@@(\w+)$/.exec(line.trim());
    if (marker) {
      current = marker[1];
      map.set(current, []);
      continue;
    }
    if (!current) continue;
    map.get(current)!.push(line);
  }
  return map;
}

function clean(lines: string[] | undefined): string[] {
  return (lines ?? []).map((line) => line.trim()).filter((line) => line.length > 0);
}

function num(value: string | undefined): number {
  const parsed = Number((value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function kv(lines: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of clean(lines)) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return out;
}

function meminfoKb(lines: string[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of clean(lines)) {
    const match = /^([A-Za-z_()]+):\s+(\d+)/.exec(line);
    if (match) out[match[1]] = Number(match[2]) * 1024;
  }
  return out;
}

interface CpuStats {
  usage: number;
  load: number[];
  breakdown: { user: number; system: number; iowait: number; steal: number; idle: number };
}

function parseCpu(lines: string[] | undefined): CpuStats {
  const raw = clean(lines);
  const load = (raw[2] ?? "").split(/\s+/).slice(0, 3).map((value) => Number(value) || 0);
  const stat = raw.filter((line) => line.startsWith("cpu "));
  const empty = { user: 0, system: 0, iowait: 0, steal: 0, idle: 100 };
  if (stat.length < 2) return { usage: 0, load, breakdown: empty };
  const read = (line: string) => line.split(/\s+/).slice(1, 9).map((value) => Number(value) || 0);
  const [a, b] = [read(stat[0]), read(stat[1])];
  const delta = a.map((value, index) => Math.max(0, (b[index] ?? 0) - value));
  const total = delta.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { usage: 0, load, breakdown: empty };
  const share = (value: number) => Math.round((value / total) * 1000) / 10;
  const idle = share(delta[3] + delta[4]);
  return {
    usage: Math.min(100, Math.max(0, 100 - idle)),
    load,
    breakdown: {
      user: share(delta[0] + delta[1]),
      system: share(delta[2] + delta[5] + delta[6]),
      iowait: share(delta[4]),
      steal: share(delta[7]),
      idle,
    },
  };
}

function zeroPressure(): SshPressure {
  return { some10: 0, some60: 0, some300: 0, full10: 0, full60: 0, full300: 0 };
}

/** Parses /proc/pressure/{cpu,memory,io}: pressure-stall information in µs. */
function parsePressure(lines: string[] | undefined): SshSnapshot["pressure"] {
  const out = { cpu: zeroPressure(), memory: zeroPressure(), io: zeroPressure() };
  let bucket: keyof typeof out | null = null;
  for (const line of clean(lines)) {
    if (line.startsWith("--")) {
      const name = line.slice(2).trim();
      bucket = name === "cpu" || name === "memory" || name === "io" ? name : null;
      continue;
    }
    if (!bucket) continue;
    const kind = line.startsWith("some") ? "some" : line.startsWith("full") ? "full" : null;
    if (!kind) continue;
    const avg = (window: string) => Number(new RegExp(`avg${window}=([0-9.]+)`).exec(line)?.[1] ?? 0);
    out[bucket][`${kind}10`] = avg("10");
    out[bucket][`${kind}60`] = avg("60");
    out[bucket][`${kind}300`] = avg("300");
  }
  return out;
}

/** Mounts that appear on every host because something bind-mounts into /proc. */
const NOISE_MOUNTS = [
  "/snap",
  "/var/lib/docker/",
  "/var/lib/containerd",
  "/usr/lib/modules",
  "/etc/hosts",
  "/etc/hostname",
  "/etc/resolv.conf",
  "/run/credentials",
];

function parseDisks(lines: string[] | undefined): SshDisk[] {
  const byDevice = new Map<string, SshDisk>();
  for (const line of clean(lines)) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line);
    if (!match) continue;
    const mount = match[6].trim();
    if (NOISE_MOUNTS.some((noise) => mount === noise || mount.startsWith(noise))) continue;
    // Loop devices back squashfs/OCI layers and report the host filesystem again.
    if (match[1].startsWith("/dev/loop")) continue;
    const entry: SshDisk = {
      fs: match[1],
      size: Number(match[2]),
      used: Number(match[3]),
      avail: Number(match[4]),
      mount,
    };
    const existing = byDevice.get(entry.fs);
    // One device can be mounted several times; the root mount is the one people mean.
    if (!existing || (existing.mount !== "/" && entry.mount === "/")) byDevice.set(entry.fs, entry);
  }
  return [...byDevice.values()]
    .sort((left, right) => {
      if (left.mount === "/") return -1;
      if (right.mount === "/") return 1;
      return right.size - left.size;
    })
    .slice(0, 8);
}

function parseBlocks(lines: string[] | undefined): SshSnapshot["blockDevices"] {
  const out: SshSnapshot["blockDevices"] = [];
  for (const line of clean(lines)) {
    // Modern probes use lsblk -P so MODEL may contain spaces. Keep the legacy
    // whitespace parser as a fallback for older captured output.
    const pairs: Record<string, string> = {};
    for (const match of line.matchAll(/([A-Z]+)="([^"]*)"/g)) pairs[match[1]] = match[2];
    if (pairs.NAME) {
      const type = pairs.TYPE?.trim();
      if (type && type !== "disk") continue;
      const serial = pairs.SERIAL?.trim();
      out.push({
        name: pairs.NAME,
        model: pairs.MODEL?.trim() || pairs.NAME,
        size: Number(pairs.SIZE) || 0,
        rotational: pairs.ROTA === "1",
        ...(type ? { type } : {}),
        ...(serial ? { serial } : {}),
      });
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const rotational = parts[parts.length - 1] === "1";
    const size = parts[parts.length - 2];
    const name = parts[0];
    const model = parts.slice(1, parts.length - 2).join(" ") || name;
    const sizeMatch = /^(\d+(?:\.\d+)?)([KMGT]?)i?B?$/.exec(size);
    const unit = sizeMatch?.[2] ?? "";
    const scale = unit === "T" ? 1024 ** 4 : unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
    out.push({ name, model, size: sizeMatch ? Number(sizeMatch[1]) * scale : 0, rotational });
  }
  return out.slice(0, 6);
}

function parseNicInfo(lines: string[] | undefined): Map<string, Partial<SshSnapshot["nics"][number]>> {
  const out = new Map<string, Partial<SshSnapshot["nics"][number]>>();
  for (const line of clean(lines)) {
    const fields = line.split("|");
    const name = fields[0]?.trim();
    if (!name) continue;
    const speed = num(fields[1]);
    const mtu = num(fields[3]);
    out.set(name, {
      ...(speed > 0 ? { speedMbps: speed } : {}),
      ...(fields[2]?.trim() ? { state: fields[2].trim() } : {}),
      ...(mtu > 0 ? { mtu } : {}),
      ...(fields[4]?.trim() ? { mac: fields[4].trim() } : {}),
    });
  }
  return out;
}

/** Tunnel and container plumbing carries counters but is not a real uplink. */
const NOISE_NICS = [
  /^lo$/,
  /^veth/,
  /^br-/,
  /^docker/,
  /^gre/,
  /^ip6gre/,
  /^erspan/,
  /^ip6tnl/,
  /^tunl/,
  /^sit/,
  /^flannel/,
  /^cni/,
  /^virbr/,
  /^lxc/,
  /^waydroid/,
  /^vxlan/,
  /^dummy/,
  /^vnet/,
  /^bond/,
];

function parseNics(lines: string[] | undefined, info = new Map<string, Partial<SshNic>>()): SshNic[] {
  const out: SshNic[] = [];
  for (const line of clean(lines)) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    const name = line.slice(0, at).trim();
    if (!name || NOISE_NICS.some((pattern) => pattern.test(name))) continue;
    const values = line.slice(at + 1).trim().split(/\s+/);
    if (values.length < 16) continue;
    const rx = Number(values[0]) || 0;
    const tx = Number(values[8]) || 0;
    if (rx + tx === 0) continue;
    out.push({ name, rx, tx, ...(info.get(name) ?? {}) });
  }
  return out.sort((left, right) => right.rx + right.tx - (left.rx + left.tx)).slice(0, 5);
}

function parseTemps(lines: string[] | undefined): SshSnapshot["temps"] {
  const out: SshSnapshot["temps"] = [];
  const seen = new Set<string>();
  for (const line of clean(lines)) {
    const at = line.indexOf("|");
    if (at < 0) continue;
    const label = line.slice(0, at).replace(/^(thermal_)?/, "").replace(/-thermal_zone\d+$/, "").trim() || "sensor";
    const raw = num(line.slice(at + 1));
    const celsius = raw > 1000 ? raw / 1000 : raw;
    if (!(celsius > 0 && celsius < 150)) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label: label.slice(0, 24), celsius: Math.round(celsius * 10) / 10 });
  }
  return out.slice(0, 8);
}

function parseProcesses(lines: string[] | undefined): SshSnapshot["processes"] {
  const out: SshSnapshot["processes"] = [];
  for (const line of clean(lines)) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const rss = num(parts[parts.length - 1]) * 1024;
    const mem = num(parts[parts.length - 2]);
    const cpu = num(parts[parts.length - 3]);
    out.push({ command: parts.slice(0, parts.length - 3).join(" ").slice(0, 28), cpu, mem, rss });
  }
  return out.slice(0, 8);
}

function parseContainers(lines: string[] | undefined): SshSnapshot["containers"] {
  return clean(lines)
    .map((line) => {
      const [name, image, ...status] = line.split("|");
      return { name: (name ?? "").trim(), image: (image ?? "").trim(), status: status.join("|").trim() };
    })
    .filter((entry) => entry.name.length > 0)
    .slice(0, 16);
}

export function parseProbe(
  host: SshHostSummary,
  stdout: string,
  meta: { latencyMs: number; stderr?: string; ok: boolean },
): SshSnapshot {
  const parts = sections(stdout);
  const ident = kv(parts.get("ident"));
  const cpuLines = clean(parts.get("cpu"));
  const cpuStats = parseCpu(cpuLines);
  const mem = meminfoKb(parts.get("mem"));
  const memoryTotal = mem.MemTotal ?? 0;
  const available = mem.MemAvailable ?? mem.MemFree ?? 0;
  const sec = kv(parts.get("sec"));
  // Prefer the rolling 24h journal count; auth.log is cumulative since rotation.
  const failedLogins = Number(sec.journal) > 0 ? Number(sec.journal) : Number(sec.authlog) > 0 ? Number(sec.authlog) : 0;
  // `sshd -T` prints effective values in lower case; sshd_config may spell them any way.
  const effective = (key: string) => {
    const raw = sec[key] ?? sec[key.toLowerCase()] ?? sec[key.charAt(0).toUpperCase() + key.slice(1)];
    // Rows come back either as sshd -T ("passwordauthentication no") or as a
    // verbatim config line, so drop the key name before showing the value.
    return raw?.replace(new RegExp(`^\s*${key}\s+`, "i"), "").trim() || undefined;
  };
  const osName = (ident.PRETTY_NAME ?? "").replace(/^"|"$/g, "").trim() || "Linux";
  const cpuMeta = kv(cpuLines);
  const sockets = Number(cpuMeta.sockets) || undefined;
  const coresPerSocket = Number(cpuMeta.cores_per_socket) || undefined;
  const physicalCores =
    Number(cpuMeta.physical_cores) ||
    (sockets && coresPerSocket ? sockets * coresPerSocket : undefined);
  const mhz = Number(cpuMeta.mhz) || undefined;
  const pressure = parsePressure(parts.get("psi"));
  const gpuResult = parseGpuProbe(stdout);

  const services: SshSnapshot["services"] = clean(parts.get("svc")).map((name) => ({ name, state: "running" }));
  const unitName = /^[A-Za-z0-9@_.:\\-]+$/;
  for (const name of clean(parts.get("failed"))) {
    if (!unitName.test(name) || !name.includes(".")) continue;
    services.push({ name, state: "failed" });
  }

  return {
    host,
    status: {
      id: host.id,
      health: meta.ok ? "online" : "offline",
      latencyMs: meta.latencyMs,
      error: meta.ok ? undefined : explainSshFailure(meta.stderr ?? "probe failed"),
      checkedAt: Date.now(),
    },
    identity: {
      hostname: ident.hostname || host.host,
      os: osName,
      kernel: ident.kernel ?? "",
      arch: ident.arch ?? "",
      uptime: Number(ident.uptime) || 0,
    },
    cpu: {
      model: cpuLines[0] ?? "",
      cores: Number(cpuLines[1]) || 0,
      ...(physicalCores ? { physicalCores } : {}),
      ...(sockets ? { sockets } : {}),
      load: cpuStats.load,
      usage: cpuStats.usage,
      mhz,
      breakdown: cpuStats.breakdown,
    },
    pressure,
    memory: {
      total: memoryTotal,
      available,
      used: Math.max(0, memoryTotal - available),
      swapTotal: mem.SwapTotal ?? 0,
      swapUsed: Math.max(0, (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0)),
    },
    disks: parseDisks(parts.get("disk")),
    blockDevices: parseBlocks(parts.get("block")),
    nics: parseNics(parts.get("net"), parseNicInfo(parts.get("netinfo"))),
    temps: parseTemps(parts.get("temp")),
    gpus: gpuResult.gpus,
    ...(gpuResult.error ? { gpuError: gpuResult.error } : {}),
    services,
    containers: parseContainers(parts.get("docker")),
    processes: parseProcesses(parts.get("proc")),
    security: {
      failedLogins,
      firewall:
        sec.ufw?.replace(/^Status:\s*/i, "").trim() ?? (Number(sec.nft) > 0 ? "nftables input hook" : undefined) ??
        (sec.ufwconf ? `ufw ${/yes/i.test(sec.ufwconf) ? "enabled" : "disabled"} (from /etc/ufw/ufw.conf)` : undefined),
      // sshd -T needs root; when it is unavailable the successful password
      // login this snapshot just made is itself proof the method is enabled.
      passwordAuth: effective("PasswordAuthentication") ?? (host.authMode === "password" ? "yes (password login in use)" : undefined),
      permitRootLogin: effective("PermitRootLogin"),
    },
    samples: [],
    fetchedAt: Date.now(),
  };
}

/**
 * Raw ssh2 errors are terse and easy to misread ("getaddrinfo ENOTFOUND" looks
 * like a rejected credential). Translate the common network/auth failures into
 * something an operator can act on, and always keep the original line.
 */
function explainSshFailure(raw: string): string {
  const line = raw.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "ssh probe failed";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(line)) {
    return `${line} — this hostname does not resolve from this PC. Use the server's IPv4 address instead.`;
  }
  if (/ECONNREFUSED/i.test(line)) return `${line} — nothing is listening on that port (sshd down, wrong port, or firewall).`;
  if (/EHOSTUNREACH|ENETUNREACH/i.test(line)) return `${line} — no route to that address from this network.`;
  if (/ETIMEDOUT|timed out/i.test(line)) return `${line} — packets are being dropped; check the provider firewall and that the IP is allocated to this box.`;
  if (/All configured authentication methods failed|Permission denied/i.test(line)) {
    return `${line} — the server rejected the login. Check the username/password, or whether password auth is enabled for that account.`;
  }
  return line;
}

export function summarizeTest(result: RunResult, snapshot: SshSnapshot): SshTestResult {
  return {
    ok: result.ok,
    latencyMs: result.latencyMs,
    hostname: snapshot.identity.hostname,
    os: snapshot.identity.os,
    kernel: snapshot.identity.kernel,
    cores: snapshot.cpu.cores,
    error: result.ok ? undefined : explainSshFailure(result.stderr || "ssh probe failed"),
  };
}

/* ------------------------------------------------------------- sampling */

const HISTORY = new Map<string, SshSample[]>();
const COUNTERS = new Map<string, { at: number; rx: number; tx: number }>();

/** Keeps a short in-memory window so the UI has a sparkline after one poll. */
export function recordSample(hostId: string, snapshot: SshSnapshot): SshSample[] {
  const rx = snapshot.nics.reduce((sum, nic) => sum + nic.rx, 0);
  const tx = snapshot.nics.reduce((sum, nic) => sum + nic.tx, 0);
  const now = snapshot.fetchedAt;
  const previous = COUNTERS.get(hostId);
  let netRx = 0;
  let netTx = 0;
  if (previous && now > previous.at) {
    const seconds = Math.max(0.2, (now - previous.at) / 1000);
    netRx = Math.max(0, (rx - previous.rx) / seconds);
    netTx = Math.max(0, (tx - previous.tx) / seconds);
  }
  COUNTERS.set(hostId, { at: now, rx, tx });
  const history = HISTORY.get(hostId) ?? [];
  history.push({
    t: now,
    cpu: snapshot.cpu.usage,
    mem: snapshot.memory.total > 0 ? (snapshot.memory.used / snapshot.memory.total) * 100 : 0,
    swap: snapshot.memory.swapTotal > 0 ? (snapshot.memory.swapUsed / snapshot.memory.swapTotal) * 100 : 0,
    load1: snapshot.cpu.load[0] ?? 0,
    netRx,
    netTx,
    user: snapshot.cpu.breakdown.user,
    system: snapshot.cpu.breakdown.system,
    iowait: snapshot.cpu.breakdown.iowait,
    steal: snapshot.cpu.breakdown.steal,
    memPressure: snapshot.pressure.memory.some10,
    ioPressure: snapshot.pressure.io.some10,
  });
  const trimmed = history.slice(-120);
  HISTORY.set(hostId, trimmed);
  return trimmed;
}

export function dropSamples(hostId: string): void {
  HISTORY.delete(hostId);
  COUNTERS.delete(hostId);
}

/* ---------------------------------------------------------------- facade */

export interface SshTarget {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  keyPath?: string;
  color: string;
  createdAt: number;
  lastSeenAt?: number;
}

export function toRunner(host: SshHostSummary, timeoutMs = 30_000, password?: string): ProbeRunner {
  return { host: host.host, port: host.port, username: host.username, keyPath: host.keyPath, password, timeoutMs };
}

export function collate(host: SshHostInput): { host: string; username: string; port: number } {
  return { host: host.host, username: host.username, port: host.port ?? 22 };
}
