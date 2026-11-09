# Security exceptions

Reviewed: 2026-11-09

## `minimatch` globparts amplification (moderate)

**Status:** accepted temporarily; build/dev scope only.

`npm audit` reports six moderate entries (`@electron/universal`, `app-builder-lib`,
`dmg-builder`, `electron-builder`, `electron-builder-squirrel-windows`,
`minimatch`) that all resolve to the same `minimatch` advisory affecting versions
`7.0.0 - 11.0.0`.

- The runtime dependency audit is clean: `npm audit --omit=dev` reports 0.
- The finding is in the packaging toolchain. It is not loaded by the shipped
  renderer, main process, MCP server or PRAETOR bundle.
- `electron-builder` `26.18.0` is the current release and still pins the affected
  transitive `minimatch` versions.
- `npm audit`'s proposed fix is a downgrade to `electron-builder` `25.1.0`, which
  would reintroduce the high/critical `tar` and `node-gyp` advisories fixed by
  26.18.0. That trade is worse and is not applied.

**Mitigation:** packaging runs from trusted source and CI, not from untrusted
globs or user-supplied patterns. Re-check when electron-builder publishes a
release that updates `minimatch`; remove this exception at that point.

**Owner:** release engineering.
