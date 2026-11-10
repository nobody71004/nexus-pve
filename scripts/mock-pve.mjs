import http from "node:http";
import { pathToFileURL } from "node:url";

const TOKEN = "smoke@pve!agent=mock-secret";
const UPID = (node, type, id) => `UPID:${node}:0000A1B2:000C3D4E:${Math.floor(Date.now() / 1000).toString(16).toUpperCase()}:${type}:${id}:smoke@pve:`;

const NODES = ["pve-smoke", "pve-smoke2"];

// PVE-mods injects raw `sensors -j` output into /nodes/{node}/status as a JSON
// string; stock Proxmox has no /sensors endpoint. pve-smoke exercises the
// /status path, pve-smoke2 exercises the PVE 9 hardware sensors endpoint.
const SENSORS_OUTPUT = JSON.stringify({
  "coretemp-isa-0000": {
    Adapter: "ISA adapter",
    "Package id 0": { temp1_input: 47, temp1_max: 84, temp1_crit: 100 },
    "Core 0": { temp2_input: 44, temp2_max: 84, temp2_crit: 100 },
    "Core 1": { temp3_input: 43, temp3_max: 84, temp3_crit: 100 },
  },
  "nvme-pci-0100": {
    Adapter: "PCI adapter",
    Composite: { temp1_input: 38, temp1_max: 81.85, temp1_crit: 84.85 },
  },
});

function vm(node, vmid, name, type, status) {
  const running = status === "running";
  return {
    id: `${type}/${vmid}`,
    type,
    node,
    vmid,
    name,
    status,
    cpu: running ? 0.21 : 0,
    maxcpu: 4,
    mem: running ? 3.2 * 1024 ** 3 : 0,
    maxmem: 8 * 1024 ** 3,
    disk: 12 * 1024 ** 3,
    maxdisk: 64 * 1024 ** 3,
    uptime: running ? 3600 * 42 : 0,
    netin: running ? 2.4e6 : 0,
    netout: running ? 3.1e6 : 0,
    diskread: running ? 8.2e5 : 0,
    diskwrite: running ? 9.4e5 : 0,
    tags: "prod;smoke",
    template: 0,
    pool: "smoke",
  };
}

export async function startMockServer(port = 0) {
  const state = {
    vms: [
      vm("pve-smoke", 100, "smoke-a", "qemu", "running"),
      vm("pve-smoke", 101, "smoke-b", "lxc", "stopped"),
      vm("pve-smoke2", 102, "smoke-c", "qemu", "running"),
    ],
    schedules: [
      {
        id: "1",
        enabled: 1,
        schedule: "02:30",
        storage: "local",
        mode: "snapshot",
        compress: "zstd",
        all: 1,
        comment: "nightly",
        "next-run": Math.floor(Date.now() / 1000) + 3600,
      },
    ],
    archives: [
      {
        volid: "local:backup/vzdump-qemu-100-2026_11_06-02_30_00.vma.zst",
        content: "backup",
        ctime: Math.floor(Date.now() / 1000) - 86400,
        size: 6.2 * 1024 ** 3,
        format: "zst",
        vmid: 100,
      },
    ],
    actions: [],
    requests: [],
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    state.requests.push(`${req.method} ${url.pathname}${url.search}`);

    const send = (data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
    };
    const fail = (status, message) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: null, message }));
    };

    if (req.headers.authorization !== `PVEAPIToken=${TOKEN}`) {
      return fail(401, "authentication failure");
    }

    const route = segments.slice(2); // drop api2/json
    const method = req.method ?? "GET";

    const body = [];
    req.on("data", (chunk) => body.push(chunk));
    req.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(body).toString("utf8"));

      if (route[0] === "version" && method === "GET") {
        return send({ version: "8.3.2", release: "smoke", repoid: "mock" });
      }

      if (route[0] === "cluster" && route[1] === "status" && method === "GET") {
        return send([
          { type: "cluster", name: "smoke-lab", quorate: 1, nodes: 2 },
          ...NODES.map((name) => ({ type: "node", name, online: 1, level: "" })),
        ]);
      }

      if (route[0] === "cluster" && route[1] === "resources" && method === "GET") {
        return send(state.vms);
      }

      if (route[0] === "cluster" && route[1] === "backup") {
        if (method === "GET") return send(state.schedules);
        if (method === "POST") {
          const id = String(state.schedules.length + 1);
          state.schedules.push({
            id,
            enabled: form.get("enabled") === "1" ? 1 : 0,
            schedule: form.get("schedule") ?? "02:30",
            storage: form.get("storage") ?? "local",
            mode: form.get("mode") ?? "snapshot",
            compress: form.get("compress") ?? "zstd",
            vmid: form.get("vmid") ?? undefined,
            node: form.get("node") ?? undefined,
            all: form.get("all") === "1" ? 1 : undefined,
            comment: form.get("comment") ?? undefined,
          });
          return send(null);
        }
        if (method === "PUT" && route[2]) {
          const job = state.schedules.find((entry) => entry.id === route[2]);
          if (job) {
            if (form.get("enabled") !== null) job.enabled = form.get("enabled") === "1" ? 1 : 0;
            if (form.get("schedule")) job.schedule = form.get("schedule");
            if (form.get("storage")) job.storage = form.get("storage");
            if (form.get("mode")) job.mode = form.get("mode");
            if (form.get("compress")) job.compress = form.get("compress");
          }
          return send(null);
        }
        if (method === "DELETE" && route[2]) {
          state.schedules = state.schedules.filter((entry) => entry.id !== route[2]);
          return send(null);
        }
      }

      if (route[0] === "nodes" && route.length === 1 && method === "GET") {
        return send(
          NODES.map((node, index) => ({
            node,
            status: "online",
            cpu: 0.28 + index * 0.17,
            maxcpu: 16,
            mem: (9 + index) * 1024 ** 3,
            maxmem: 64 * 1024 ** 3,
            disk: 210 * 1024 ** 3,
            maxdisk: 900 * 1024 ** 3,
            uptime: 86400 * (12 + index),
          })),
        );
      }

      if (route[0] === "nodes" && route[1]) {
        const node = route[1];
        if (!NODES.includes(node)) return fail(500, `no such node '${node}'`);

        if (route.length === 2 && route[1] && route[2] === "status") {
          return send({});
        }
        if (route[2] === "status" && method === "GET") {
          return send({
            uptime: 86400 * 13,
            loadavg: [1.42, 1.8, 2.1],
            ksm: { shared: 512 * 1024 ** 2, sharing: 120 },
            cpuinfo: { cores: 16, cpus: 32, mhz: "2904.000", model: "AMD EPYC 7302P 16-Core Processor", sockets: 1 },
            memory: { used: 9.5 * 1024 ** 3, free: 54.5 * 1024 ** 3, total: 64 * 1024 ** 3 },
            swap: { used: 0, free: 8 * 1024 ** 3, total: 8 * 1024 ** 3 },
            rootfs: { used: 210 * 1024 ** 3, free: 690 * 1024 ** 3, total: 900 * 1024 ** 3, avail: 690 * 1024 ** 3 },
            pveversion: "pve-manager/8.3.2/smoke",
            "current-kernel": { version: "6.8.12-4-pve" },
            ...(node === "pve-smoke" ? { sensorsOutput: SENSORS_OUTPUT } : {}),
          });
        }
        if (route[2] === "rrddata") {
          const now = Math.floor(Date.now() / 1000);
          return send(
            Array.from({ length: 40 }, (_, index) => ({
              time: now - (40 - index) * 60,
              cpu: 0.24 + Math.sin(index / 5) * 0.08,
              memused: 9.2 * 1024 ** 3,
              memtotal: 64 * 1024 ** 3,
              netin: 2.1e6 + Math.sin(index / 3) * 4e5,
              netout: 3.4e6 + Math.cos(index / 4) * 6e5,
              loadavg: 1.4 + Math.sin(index / 6) * 0.3,
              iowait: 0.02,
            })),
          );
        }
        if (route[2] === "storage" && route.length === 3) {
          return send([
            {
              storage: "local",
              type: "dir",
              content: "backup,iso,vztmpl",
              active: 1,
              total: 900 * 1024 ** 3,
              used: 310 * 1024 ** 3,
              avail: 590 * 1024 ** 3,
              shared: 0,
            },
            {
              storage: "local-zfs",
              type: "zfspool",
              content: "images,rootdir",
              active: 1,
              total: 1800 * 1024 ** 3,
              used: 640 * 1024 ** 3,
              avail: 1160 * 1024 ** 3,
              shared: 0,
            },
          ]);
        }
        if (route[2] === "disks" && route[3] === "list") {
          return send([
            {
              devpath: "/dev/nvme0n1",
              model: "Samsung PM9A3",
              serial: "SMOKE0001",
              size: 1.92 * 1024 ** 4,
              health: "PASSED",
              type: "nvme",
              wearout: 3,
            },
          ]);
        }
        if (route[2] === "network") {
          return send([
            { iface: "vmbr0", type: "bridge", active: 1, address: "127.0.0.1", cidr: "127.0.0.1/8", gateway: "127.0.0.1" },
            { iface: "eth0", type: "eth", active: 1, speed: "10000" },
          ]);
        }
        if (route[2] === "hardware" && route[3] === "pci") {
          return send([
            {
              id: "0000:41:00.0",
              class: "030000",
              class_name: "VGA compatible controller",
              vendor: "10de",
              vendor_name: "NVIDIA Corporation",
              device: "24b0",
              device_name: "GA104GL [RTX A4000]",
              iommugroup: 22,
            },
            {
              id: "0000:00:1f.3",
              class: "040300",
              class_name: "Audio device",
              vendor: "8086",
              vendor_name: "Intel Corporation",
              device: "a1f0",
              device_name: "Audio controller",
            },
          ]);
        }
        if (route[2] === "hardware" && route[3] === "sensors" && route[4] === "temperature" && route[5] === "cpu") {
          return send(
            node === "pve-smoke2"
              ? [
                  { sensor: "k10temp/Tctl", temperature: 61.5, unit: "celsius", driver: "k10temp", package: 0 },
                  { sensor: "k10temp/Tccd1", temperature: 54, unit: "celsius", driver: "k10temp", package: 0 },
                ]
              : [],
          );
        }
        if (route[2] === "sensors") {
          return fail(500, "no sensors found");
        }
        if (route[2] === "tasks" && route.length === 3 && method === "GET") {
          const now = Math.floor(Date.now() / 1000);
          return send([
            {
              upid: UPID(node, "vzdump", "100"),
              node,
              type: "vzdump",
              id: "100",
              user: "smoke@pve",
              status: "running",
              starttime: now - 60,
            },
            {
              upid: UPID(node, "qmstart", "100"),
              node,
              type: "qmstart",
              id: "100",
              user: "smoke@pve",
              status: "stopped",
              starttime: now - 3600,
              endtime: now - 3590,
              exitstatus: "OK",
            },
            {
              upid: UPID(node, "vzdump", "101"),
              node,
              type: "vzdump",
              id: "101",
              user: "smoke@pve",
              status: "stopped",
              starttime: now - 7200,
              endtime: now - 7000,
              exitstatus: "job errors",
            },
          ]);
        }
        if (route[2] === "tasks" && route[3] && route[4] === "log") {
          return send([
            { n: 1, t: "INFO: starting task" },
            { n: 2, t: "INFO: 42% done" },
            { n: 3, t: "INFO: 100% done" },
            { n: 4, t: "TASK OK" },
          ]);
        }

        if (route[2] === "vzdump" && method === "POST") {
          const vmid = Number(form.get("vmid") ?? 100);
          const nodeTarget = form.get("node") ?? node;
          const volid = `local:backup/vzdump-qemu-${vmid}-${Date.now()}.vma.zst`;
          state.archives.unshift({
            volid,
            content: "backup",
            ctime: Math.floor(Date.now() / 1000),
            size: 4 * 1024 ** 3,
            format: "zst",
            vmid,
          });
          state.actions.push({ type: "vzdump", node: nodeTarget, vmid });
          return send(UPID(nodeTarget, "vzdump", String(vmid)));
        }

        if (route[2] === "qemu" || route[2] === "lxc") {
          const type = route[2];
          if (route.length === 3 && method === "POST") {
            const vmid = Number(form.get("vmid") ?? 200);
            state.actions.push({ type: "restore", node, vmid, archive: form.get("archive") ?? form.get("ostemplate") });
            return send(UPID(node, type === "lxc" ? "vzrestore" : "qmrestore", String(vmid)));
          }
          const vmid = Number(route[3]);
          const guest = state.vms.find((entry) => entry.vmid === vmid && entry.node === node);
          if (!guest) return fail(500, `no such VM ${vmid}`);
          if (route[4] === "status" && route[5] && method === "POST") {
            const action = route[5];
            state.actions.push({ type: "status", node, vmid, action });
            if (action === "start") guest.status = "running";
            if (action === "stop" || action === "shutdown") guest.status = "stopped";
            return send(UPID(node, "qmshutdown", String(vmid)));
          }
          if (route[4] === "config") {
            return send({
              name: guest.name,
              cores: 4,
              sockets: 1,
              memory: 8192,
              ostype: "l26",
              net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0",
              scsi0: "local-zfs:vm-100-disk-0,size=64G",
              onboot: 1,
              agent: 1,
            });
          }
          if (route[4] === "snapshot") {
            if (route[6] === "rollback" && method === "POST") {
              state.actions.push({ type: "rollback", node, vmid, name: route[5] });
              return send(UPID(node, "qmrollback", String(vmid)));
            }
            if (method === "GET") {
              return send([
                { name: "current", description: "You are here!" },
                { name: "pre-change", description: "smoke checkpoint", snaptime: Math.floor(Date.now() / 1000) - 3600 },
              ]);
            }
            if (method === "POST") {
              state.actions.push({ type: "snapshot", node, vmid, name: form.get("snapname") });
              return send(UPID(node, "qmsnapshot", String(vmid)));
            }
            if (method === "DELETE") {
              state.actions.push({ type: "snapshot-delete", node, vmid, name: route[5] });
              return send(null);
            }
          }
          if (route[4] === "agent" && route[5] === "network-get-interfaces") {
            return send({
              result: [
                { name: "lo", "hardware-address": "00:00:00:00:00:00", "ip-addresses": [{ "ip-address": "127.0.0.1", "ip-address-type": "ipv4" }] },
                {
                  name: "eth0",
                  "hardware-address": "aa:bb:cc:dd:ee:ff",
                  "ip-addresses": [{ "ip-address": "10.0.0.50", "ip-address-type": "ipv4" }],
                },
              ],
            });
          }
        }

        if (route[2] === "storage" && route[4] === "content") {
          const storage = route[3];
          if (method === "GET") {
            return send(storage === "local" ? state.archives : []);
          }
          if (method === "DELETE") {
            const volid = route[5];
            state.archives = state.archives.filter((entry) => entry.volid !== volid);
            return send(null);
          }
        }
      }

      if (route[0] === "access" && route[1] === "ticket" && method === "POST") {
        return send({ ticket: "ticket", CSRFPreventionToken: "csrf", username: form.get("username") });
      }

      return fail(501, `mock has no route for ${method} ${url.pathname}`);
    });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startMockServer(Number(process.env.MOCK_PORT ?? 18006));
  console.log(`mock Proxmox API on ${server.url}`);
  console.log(`token: ${TOKEN}`);
}
