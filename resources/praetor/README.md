# Bundled PRAETOR egress

Nexus PVE installs these files under `/opt/praetor-egress` on every configured
SSH host:

- `praetor-egress.mjs` — bundled PRAETOR/1 egress server.
- `praetor-keygen.mjs` — one-shot X-Wing server key generator. The private key
  is created on the host, never sent back to Nexus.
- `praetor-profiles.mjs` — writes the four matching client profiles to the host.
- `praetor-egress.service` — systemd unit. `@NODE@` is replaced by the selected
  Node 20+ executable.
- `praetor-ingress.service` / `praetor-ingress-rule.sh` — idempotent TCP 9443
  firewall allowance.

The two `.mjs` bundles are generated from the `vanta-repo` Praetor source:

```sh
npm run build:praetor
```

The installer keeps an existing `/opt/praetor-egress/server.key` across
updates, so profiles remain valid. It only generates a new key when both the
private key and its public key are missing.
