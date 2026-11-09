// Write the four Nexus PRAETOR client profiles for one installed egress.
// This file is copied to the host and runs through the same Node runtime as
// the egress. It only writes public material (the server public key).
import fs from "node:fs";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const keyFile = arg("key-file");
const output = arg("out", "/opt/praetor-egress/profiles.json");
const host = arg("host", "127.0.0.1");
const label = arg("label", host);
const hostId = arg("id", "host");
const port = Number(arg("port", "9443"));
if (!keyFile) {
  console.error("usage: praetor-profiles.mjs --key-file <server.pub> --host <endpoint> [--port 9443] --out <profiles.json>");
  process.exit(2);
}

const publicKey = fs.readFileSync(keyFile, "utf8").replace(/\s+/g, "");
if (!publicKey) {
  console.error("server public key is empty");
  process.exit(3);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("port must be 1-65535");
  process.exit(4);
}

const endpointHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
const endpoint = `${endpointHost}:${port}`;
const now = new Date().toISOString();
const suites = [
  {
    suite: "PSEAL",
    description: "Default PRAETOR/1 profile: SIV + commitment record protection over a pinned hybrid X-Wing handshake.",
    tags: ["pq", "siv", "default", "nexus"],
    color: "mint",
    autoConnect: true,
  },
  {
    suite: "FAST",
    description: "Throughput-sensitive routing profile; the current egress negotiates PSEAL.",
    tags: ["pq", "aes-gcm", "opt-in", "nexus"],
    color: "violet",
    autoConnect: false,
  },
  {
    suite: "BOLT",
    description: "Lower per-cell cost routing profile; the current egress negotiates PSEAL.",
    tags: ["pq", "aegis", "opt-in", "nexus"],
    color: "amber",
    autoConnect: false,
  },
  {
    suite: "PMARINE",
    description: "Experimental PMARINE (PSEAL/2) preset over AEGIS-256; the current egress negotiates PSEAL.",
    tags: ["pq", "aegis-256", "experimental", "nexus"],
    color: "ice",
    autoConnect: false,
  },
];

const profiles = suites.map((entry) => ({
  id: `nexus-${hostId}-${entry.suite.toLowerCase()}`,
  name: `Nexus ${label} ${entry.suite}`.slice(0, 80),
  description: entry.description.slice(0, 300),
  location: label.slice(0, 80),
  endpoint,
  protocol: "PRAETOR/1",
  suite: entry.suite,
  transport: "tcp",
  cellSize: 1024,
  serverPublicKey: publicKey,
  autoConnect: entry.autoConnect,
  tags: entry.tags,
  color: entry.color,
  createdAt: now,
  updatedAt: now,
}));

fs.writeFileSync(output, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ ok: true, count: profiles.length, endpoint }));
