# Bundled PRAETOR egress

Nexus PVE installs these files under `/opt/praetor-egress` on every configured
SSH host:

- `praetor-egress.mjs` — bundled PRAETOR/1 egress server.
- `praetor-keygen.mjs` — one-shot X-Wing server key generator. The private key
  is created on the host, never sent back to Nexus.
- `praetor-profiles.mjs` — writes the four matching client profiles to the host.
- `praetor-egress.service` — systemd unit. `@NODE@` is replaced by the selected
  Node 20+ executable.
- `praetor-rotate-key.sh` — transactional key rotation. It backs up the current
  keypair and pin bundle, generates a new keypair and four profiles, restarts
  the egress, and restores the old set when the service does not stay active.
- `praetor-ingress.service` / `praetor-ingress-rule.sh` — idempotent TCP 9443
  firewall allowance. On Proxmox it adds or validates a host-level
  `IN ACCEPT -p tcp -dport 9443` rule in the local node's `host.fw` and checks
  the effective legacy or nftables ruleset when the firewall is active. A
  blocked active Proxmox firewall makes the installer fail instead of reporting
  a ready rollout.

The fallback runtime covers `x86_64`/`amd64` and `aarch64`/`arm64`. The
installer verifies the matching SHA-256 from the Node distribution before
extracting it; any other architecture fails with `@@fail=node-arch`.

The two `.mjs` bundles are generated from the `vanta-repo` Praetor source:

```sh
npm run build:praetor
```

The installer keeps an existing `/opt/praetor-egress/server.key` across
updates, so profiles remain valid. It only generates a new key when both the
private key and its public key are missing.

Rotation is explicit. `praetor-rotate-key.sh` regenerates the keypair on the
host, rewrites `/opt/praetor-egress/profiles.json`, and rolls back the old
keypair and profiles if `praetor-egress.service` does not restart and stay
active. Nexus then rewrites its local `praetor/profiles.json` pins to match.
Clients must re-import the refreshed profiles because their pinned public key
is replaced.
