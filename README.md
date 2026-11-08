# Nexus PVE

A portable Windows desktop console for Proxmox VE and Linux fleets. It combines live node and guest telemetry, backup management, VM/CT control, SSH server monitoring, a security guardian, an edge DDoS shield, and approval-gated agent/MCP pipelines in one app.

## Download

- [NexusPVE-1.0.0-portable.exe](./NexusPVE-1.0.0-portable.exe) — 75.2 MB
- SHA-256: `41d5ae47ab9d6e39f940fc06a166d6ba8e18d463ed224d58d9c0ba9737f81889`

- Windows 10/11 x64
- No installer and no Node.js runtime required
- State is stored in `%APPDATA%\NexusPVE` (Linux/macOS: `~/.config/NexusPVE`)

## Features

- **Command deck** — per-node CPU, memory, swap, root filesystem, load, storage, disk health, NICs, sensors, package temperature and RRD history; guest inventory with CPU, memory, disk and uptime; Proxmox task activity; fleet KPI tiles. Every configured Linux/SSH server is rendered beside the Proxmox nodes with its own CPU, memory, root free space, load, uptime and network dials.
- **Backup studio** — vzdump archives across backup-capable storage, size/age totals, coverage, manual backups, restore into a new VM/CT id, archive deletion, and native Proxmox cluster backup schedules.
- **VM/CT control** — start, graceful shutdown, reboot, force stop, reset, suspend/resume; guest detail drawer with config, guest-agent IPs, snapshots and recent tasks. Destructive actions are confirmed and audited.
- **Linux/SSH fleet** — key or stored-password auth, live health and snapshots, helper readiness, one-time sudo elevation for helper repair, file-system and service visibility.
- **Security guardian** — baseline checks, drift detection, scoring, allowlisting, banning and an audit journal.
- **Edge shield** — read-only DDoS status and journal plus approval-gated mode/config changes on a designated SSH edge host.
- **Agent pipelines** — built-in health, backup, maintenance, incident and release pipelines, plus JSON pipelines in the app data folder. Runs stream step state, logs, retries, fan-out and human approval gates.
- **Connections** — multiple Proxmox endpoints and Linux/SSH hosts, API-token or password auth, TLS verification toggle, connection tests, encrypted secret storage, and one-click MCP client configuration for Claude Desktop and Cursor.

## Quick start

1. Launch `NexusPVE-1.0.0-portable.exe`.
2. Open **Connections** and add a Proxmox endpoint, for example `https://pve.example.com:8006`, with a dedicated API token.
3. Add Linux servers over SSH using a key or a stored password.
4. Open **Command Deck** to see every configured Proxmox node and Linux server.

The project ships with fictional demo data only. All example addresses use the RFC 5737 documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`).

## Build from source

Requirements: Node.js 20+, npm, and Windows for the portable target.

```bash
npm install
npm run typecheck
npm run package
```

Output: `release/NexusPVE-1.0.0-portable.exe`.

## Security

- Proxmox API tokens and SSH passwords are stored encrypted in the application data directory, never in this repository.
- The project does not ship with credentials, private keys, real server addresses or personal data.
- Review the code before connecting it to production infrastructure.

## License

GNU General Public License v3.0 only. See [LICENSE](LICENSE).
