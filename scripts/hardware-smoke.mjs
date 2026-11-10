/**
 * SSH hardware parser smoke test.
 *
 * Feeds the exact section format emitted by the remote probe through
 * parseProbe(), covering CPU topology, physical disk models, serials and NIC
 * link details without requiring a Linux host in the test environment.
 */
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const bundle = buildSync({
  entryPoints: [path.join(root, "electron", "ssh", "probe.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  external: ["ssh2"],
  logLevel: "silent",
});
const module = { exports: {} };
new Function("module", "exports", "require", bundle.outputFiles[0].text)(module, module.exports, require);
const { parseProbe } = module.exports;

const host = {
  id: "hardware-smoke",
  label: "hardware-smoke",
  host: "192.0.2.40",
  port: 22,
  username: "root",
  authMode: "key",
  hasSecret: false,
  color: "#3ef2ff",
  createdAt: 0,
};

const output = `@@ident
hostname=compute-01
PRETTY_NAME="Ubuntu 24.04.1 LTS"
VERSION_ID="24.04"
kernel=6.8.0-45-generic
arch=x86_64
uptime=993120

@@cpu
AMD EPYC 9354 32-Core Processor
64
0.42 0.31 0.22 2/123 4567
cpu  100 0 100 800 0 0 0 0 0 0
cpu  140 0 120 900 0 0 0 0 0 0
mhz=3250
sockets=2
physical_cores=32
cores_per_socket=16

@@mem
MemTotal: 131072000 kB
MemFree: 52428800 kB
MemAvailable: 65536000 kB
SwapTotal: 8388608 kB
SwapFree: 7340032 kB

@@disk
/dev/nvme0n1p2 400000000000 150000000000 250000000000 38% /

@@block
NAME="nvme0n1" TYPE="disk" MODEL="Samsung SSD 990 PRO 4TB" SIZE="4000787030016" ROTA="0" SERIAL="S7KHNJ0X123456"
NAME="sda" TYPE="disk" MODEL="HGST HUH721010AL" SIZE="1000204886016" ROTA="1" SERIAL="7SH1ABCD"

@@net
eth0: 123456789 100 0 0 0 0 0 0 987654321 100 0 0 0 0 0 0
lo: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0

@@netinfo
eth0|10000|up|1500|aa:bb:cc:dd:ee:ff
lo|1000|unknown|65536|00:00:00:00:00:00

@@temp
x86_pkg_temp-thermal_zone0|45000

@@psi
--cpu
some avg10=1.00 avg60=0.50 avg300=0.20
full avg10=0.00 avg60=0.00 avg300=0.00
--memory
some avg10=2.00 avg60=1.00 avg300=0.50
full avg10=0.20 avg60=0.10 avg300=0.05
--io
some avg10=0.60 avg60=0.30 avg300=0.10
full avg10=0.10 avg60=0.05 avg300=0.00

@@gpu
--pci
--amd
@@end`;

const snapshot = parseProbe(host, output, { latencyMs: 73, ok: true });

check("CPU model is preserved", snapshot.cpu.model === "AMD EPYC 9354 32-Core Processor", snapshot.cpu.model);
check("logical thread count is parsed", snapshot.cpu.cores === 64, `${snapshot.cpu.cores} threads`);
check("physical core count is parsed", snapshot.cpu.physicalCores === 32, `${snapshot.cpu.physicalCores} cores`);
check("physical socket count is parsed", snapshot.cpu.sockets === 2, `${snapshot.cpu.sockets} sockets`);
check("average CPU clock is parsed", snapshot.cpu.mhz === 3250, `${snapshot.cpu.mhz} MHz`);
check("memory totals are parsed", snapshot.memory.total === 131072000 * 1024 && snapshot.memory.available === 65536000 * 1024, `${Math.round(snapshot.memory.total / 1024 ** 3)} GiB`);

const nvme = snapshot.blockDevices.find((device) => device.name === "nvme0n1");
const hdd = snapshot.blockDevices.find((device) => device.name === "sda");
check("physical disk models with spaces are parsed", nvme?.model === "Samsung SSD 990 PRO 4TB", nvme?.model);
check("physical disk sizes are byte-exact", nvme?.size === 4000787030016, `${nvme?.size} bytes`);
check("physical disk serial and type are preserved", nvme?.serial === "S7KHNJ0X123456" && nvme?.type === "disk", nvme?.serial);
check("rotational media is distinguished from SSDs", nvme?.rotational === false && hdd?.rotational === true);

check("NIC link speed, state and MAC are parsed", snapshot.nics[0]?.name === "eth0" && snapshot.nics[0]?.speedMbps === 10000 && snapshot.nics[0]?.state === "up" && snapshot.nics[0]?.mac === "aa:bb:cc:dd:ee:ff", snapshot.nics[0]?.mac);
check("NIC byte counters are parsed", snapshot.nics[0]?.rx === 123456789 && snapshot.nics[0]?.tx === 987654321);
check("loopback is excluded from hardware NICs", snapshot.nics.length === 1);
check("temperature sensors are parsed", snapshot.temps[0]?.label === "x86_pkg_temp" && snapshot.temps[0]?.celsius === 45, snapshot.temps[0]?.label);

const noTopology = parseProbe(
  host,
  `@@ident\nhostname=edge\n@@cpu\nARMv8 Processor\n4\n0.10 0.10 0.10 1/1 1\ncpu  10 0 10 80 0 0 0 0 0 0\ncpu  20 0 10 90 0 0 0 0 0 0\nmhz=\nsockets=0\nphysical_cores=0\ncores_per_socket=0\n@@end`,
  { latencyMs: 20, ok: true },
);
check("unknown topology is not invented", noTopology.cpu.physicalCores === undefined && noTopology.cpu.sockets === undefined, `${noTopology.cpu.cores} threads`);

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
