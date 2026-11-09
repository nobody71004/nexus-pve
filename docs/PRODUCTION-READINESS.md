# Production Readiness Roadmap — NexusPVE + PRAETOR/1

**Status:** Phase 0L local toolchain and preflight work completed 2026-11-09;
source/binary reconciliation, line-ending renormalization, the PRAETOR Rust run
and signing/audit procurement remain. Phase 0A remains blocked by the GitHub
Actions billing issue. This is not a release-ready claim.
**Date:** 2026-11-09
**Scope:** NexusPVE 1.0.6 desktop console, and the PRAETOR/1 protocol plus its
Rust/JavaScript executables and egress service.

**Execution constraint (2026-11-09):** GitHub Actions is unavailable because of
an account billing issue. Phase 0's CI/release work is **deferred, not waived**.
Local work that does not require a runner can proceed; anything that depends on
a green workflow is marked BLOCKED until the account is restored. No release gate
may be treated as passed on the basis of a local build alone.

**Phase 0L progress (2026-11-09):** the stale `.github-repo` and `.public-build`
copies plus debug/generated artifacts were archived under
`artifacts/cleanup-2026-11-09/`; line-ending policy added; Electron `45.2.3`,
electron-builder `26.18.0` and esbuild `0.28.2` installed; `npm run
preflight:local` writes a report; packaged smoke passes 12/12. Runtime audit is
clean; six moderate build-time `minimatch` findings remain documented in
`docs/SECURITY-EXCEPTIONS.md`.

---

## 1. What "production ready" means here

This plan targets a **controlled production deployment**, not a claim that either
project is certified or suitable for life-critical use.

For NexusPVE, production ready means:

- a supported Windows 10/11 x64 operator console, deployed by a small operations
  team, managing Proxmox VE, Linux/SSH hosts and the edge shield;
- signed, verifiable installers and updates;
- documented backup, upgrade, rollback and incident procedures;
- automated tests and a release pipeline that cannot ship an unverified binary;
- no open critical or high security findings in the application, its privileged
  helpers, or its update channel.

For PRAETOR/1, production ready means:

- the Rust implementation is the production runtime; the JavaScript build is a
  reference/interop implementation only;
- the protocol composition and handshake have had an **independent** security
  audit, with findings closed;
- fuzzing, constant-time review, key lifecycle and operational procedures are in
  place;
- signed Windows/Linux binaries, checksums, SBOM and reproducible build
  instructions are published.

PRAETOR/1 cannot honestly be called production ready before the independent
audit. Until then the correct label is **production candidate / controlled
pilot**. That distinction is a gate in this plan, not a documentation nuance.

### Assumptions

These assumptions keep the plan finite. If any are wrong, the scope changes.

1. NexusPVE remains a **local-first Windows operator console** for one operations
   team. It is not becoming a multi-tenant SaaS control plane.
2. The target fleet is on the order of tens of Proxmox nodes, hundreds of guests,
   and up to roughly one hundred SSH hosts. Capacity targets will be measured and
   written down.
3. A code-signing identity will be purchased or provisioned. Without it, Windows
   SmartScreen and enterprise deployment will remain a blocker.
4. PRAETOR's first production use is a **controlled pilot**, not classified,
   life-critical or high-value data. A FIPS 140-3 or CNSA 2.0 claim is explicitly
   out of scope.
5. One senior engineer can own the work, with part-time security review and a
   separate budget for the PRAETOR audit.

---

## 2. Baseline: what is actually true today

These are observed facts, not aspirations.

### NexusPVE

| Check | Result |
|---|---|
| Version / remote | `1.0.6`, remote `main` at `6268a8b`; release `v1.0.6` exists |
| Typecheck | passes |
| Test suite | 4/4 edge-safety Python tests pass |
| Runtime dependency audit | 0 vulnerabilities (`npm audit --omit=dev`) |
| Full dependency audit | **19 vulnerabilities: 1 critical, 13 high, 5 moderate** in the build/dev chain |
| Electron | `33.4.11`; current line is `45.x` and the installed major carries numerous advisories |
| Code signing | every local EXE reports **`NotSigned`** |
| CI / Release workflows | fail in 2–4 seconds with **zero steps executed**; consistent with the account-level Actions billing/runner block seen earlier |
| Installer | portable EXE only; no MSI/MSIX, no uninstall/upgrade path |
| Auto-update | none |
| Crash reporting / structured logs | none |
| SBOM / checksums / provenance | README checksums only; no SBOM or signed provenance |
| Test depth | no unit tests for vault, auth, SSH, PVE client, IPC, team store or PRAETOR installer; one packaged smoke path |
| Repo state | nested `.github-repo` clone is stale at 1.0.5; working tree has uncommitted smoke-harness/workflow changes and widespread line-ending noise |
| PRAETOR resource build | reads `../vanta-repo/praetor`, outside this repository; generated bundle is committed |
| PVE TLS verification | **off by default** (`NEXUS_PVE_TLS_VERIFY === "1"`, UI default `false`) |
| SSH host-key verification | OpenSSH path uses `StrictHostKeyChecking=accept-new`; the `ssh2` password path has **no `hostVerifier`** |
| Electron isolation | `contextIsolation: true`, `nodeIntegration: false`, but **`sandbox: false`** and no Electron fuses |
| Vault | AES-256-GCM, but the master key is a plain file beside the config; not OS-keychain bound |
| Team database | `sql.js` whole-file export on write; scrypt with library defaults; 12-hour sessions; login throttling present |
| MCP destructive actions | gated by a caller-supplied `confirm: true`; an MCP client or model can set that itself |

### PRAETOR/1

| Check | Result |
|---|---|
| Versions | JS `@praetor/protocol` `0.1.0` (private), Rust crate `0.1.0` |
| JS tests | 59/59 pass, including browser parity |
| Rust tests | 34 documented; **not run in this baseline because `cargo` is not installed locally** |
| Cross-language vectors | present and consumed by the Rust tests |
| Security status | explicitly unaudited; JS is not constant-time; PMARINE is experimental |
| Formal verification | none |
| Fuzzing | none in the repository |
| CI | none |
| Repository | no standalone Git repository; files currently resolve to the home-directory repo |
| Release artifacts | no signed `praetor.exe`, no installer, no SBOM, no checksums |
| Key lifecycle | keygen/seal/open/encrypt/decrypt, Shamir, guard quotas and audit chain exist; no rotation/HSM workflow |
| Production runtime | Nexus ships a bundled JS egress plus a downloaded Node 22 runtime, not the Rust binary |

The foundations are real: typed IPC, context isolation, a CSP, encrypted secrets,
human gates, hash-chained security journaling, cross-language vectors, and a
substantial PRAETOR test suite. The gaps are concentrated in release engineering,
security defaults, independent validation and operations.

---

## 3. Workstream A — NexusPVE

### A0. Restore a trustworthy release pipeline (P0, 1–2 weeks)

CI is the preferred gate, but a billing block is not permission to skip local
verification. Do the local items now; defer only the runner-dependent ones.

1. **Unblock GitHub Actions.** Resolve the account billing/runner issue, then land
   a trivial `workflow_dispatch` smoke job to prove a runner actually starts.
   Do not treat a workflow file edit as a fix until a job executes steps.
2. **One source of truth.** Keep the root `nexus-pve` clone as canonical. Remove
   the stale `.github-repo` nested clone from the workspace and from any scripts.
   Reconcile the uncommitted smoke-harness and workflow changes, then verify that
   tag `v1.0.6` still points at a commit that builds the published EXE. If it does
   not, publish a corrected patch release rather than silently rebuilding.
3. **Normalize the repository.** Add `.gitattributes` (`* text=auto eol=lf`,
   `*.ps1 eol=crlf`, `*.bat eol=crlf`), renormalize once, and stop the
   hundreds-of-files line-ending noise. Add `.editorconfig`.
4. **Pin the toolchain.** `engines.node >=22`, `.nvmrc` or `.node-version`, and a
   documented npm version. Node 20 is end-of-life and must leave CI.
5. **Upgrade the security-critical build chain.** Electron `33` → current supported
   major, `electron-builder` `25` → `26.x`, `esbuild` `0.24` → current. Do this in
   separate commits with typecheck, build and packaged smoke after each. Expect
   breakage from Electron's removed/changed APIs; budget for it.
6. **Make dependency health visible.** CI runs `npm audit --omit=dev` as a hard
   gate and the full audit as a reviewed report. Add Dependabot or Renovate with
   grouped updates, and a documented exception file for anything that cannot be
   fixed immediately.
7. **Release provenance.** Every release publishes `SHA256SUMS`, a CycloneDX SBOM,
   a signed Git tag, and a short provenance statement naming the commit, Node
   version and build command.
8. **Start code-signing procurement now.** An OV/EV certificate or a managed
   signing service has a lead time; SmartScreen reputation also takes time.

**Exit criteria (split):** locally, `v1.0.6` source and binary are reconciled, the
lockfile installs cleanly, typecheck/build/tests/smoke pass, and the full audit has
no unexplained critical/high finding. **Deferred while Actions is blocked:** a
pushed commit runs CI to completion and a tag produces a signed, checksummed
artifact from a clean checkout.

### A1. Security defaults and privileged boundaries (P0/P1, 2–4 weeks)

The app can reach root on every configured host. Its defaults must reflect that.

1. **Verify SSH host keys everywhere.** Add a `hostVerifier` to the `ssh2` password
   path backed by a pinned `known_hosts` store or a first-use confirmation that
   shows the fingerprint. Move the OpenSSH path from `accept-new` to `yes` by
   default, with an explicit "trust this new host" action. Add tests for changed
   keys and MITM attempts.
2. **Verify PVE TLS by default.** New hosts should default to `tlsVerify: true`.
   Keep a per-host "allow self-signed" switch with a visible warning; migrate
   existing `false` entries with a one-time warning rather than silently changing
   behavior.
3. **Harden Electron.** Enable `sandbox: true` if the preload permits it. Apply
   Electron fuses after packaging: disable `RunAsNode`, `NODE_OPTIONS` and
   `--inspect`; enable `OnlyLoadAppFromAsar` and ASAR integrity validation; enable
   cookie encryption. Add `webviewTag: false`, deny all permission requests, and
   add a permission-check handler. Verify the fuses in the packaged smoke test.
4. **Validate every IPC boundary.** Schema-validate arguments (unknown fields
   rejected), verify the sender frame is the app origin, enforce role checks on
   every privileged handler, and rate-limit expensive operations. Treat the
   renderer as compromised in tests.
5. **Fix the MCP approval model.** `confirm: true` supplied by the caller is not a
   human approval. Destructive tools should return `approval_required` with a
   digest of the exact action, and only the desktop UI (or a signed approval
   token) can approve it. Add an end-to-end test that a model cannot self-approve
   a VM delete, backup restore or firewall change.
6. **Improve secret storage.** Wrap the vault master key with Windows DPAPI (and
   libsecret/Keychain where supported), keeping the headless MCP server working
   under the same user. Add key rotation, an encrypted export/recovery path, and a
   documented "lose the key, lose the secrets" recovery procedure. Raise scrypt
   cost or move to Argon2id; add rehash-on-login.
7. **Harden the team/session layer.** Shorter admin sessions, configurable idle
   timeout, MFA/TOTP for administrators (optional but recommended), password
   reset/recovery, and audit records for every admin action. Increase login
   throttling coverage to all auth paths.
8. **Audit the privileged helpers.** Review `nexus-priv.sh`, the sudoers drop-in,
   the edge daemon, installer scripts and the PRAETOR staging/install scripts for
   injection, temporary-file races, symlink attacks, unsafe downloads and
   TOCTOU. Add shellcheck, Python linting and targeted tests.
9. **Threat model.** Write a STRIDE-style model covering: compromised renderer,
   malicious MCP client, stolen operator laptop, hostile SSH host, hostile PVE
   endpoint, compromised update feed, compromised dependency, and a user with
   `user` role attempting admin actions.

**Exit criteria:** host-key and TLS verification are on by default and tested; a
renderer compromise cannot reach privileged IPC without passing validation and
authorization; destructive MCP actions require an out-of-band human approval;
the privileged scripts have a reviewed threat model and no open high findings.

### A2. Test depth and quality gates (P1, 3–5 weeks)

The current 4 edge tests are valuable but nowhere near enough for a root-capable
console.

1. **Add a unit-test runner.** Vitest fits the Vite/TypeScript stack. Start with
   the security-critical modules: `vault`, `config`, `team/store`, `ipc`
   validation, `ssh/probe` argument construction, `ssh/transport`, `pve/client`,
   `praetor/profiles`, `praetor/service` parsing, audit chain, and MCP tool
   confirmation logic.
2. **Add integration tests.** A mock PVE server already exists; add an in-process
   `ssh2` test server with fixtures for key auth, password auth, changed host
   keys, timeouts, truncated output and non-zero exits. Test the real command
   builders without touching a live host.
3. **Add Windows E2E.** Playwright's Electron support on a `windows-latest` runner:
   first-run admin bootstrap, login, add host, fleet overview against the mock
   PVE, confirmation-gated VM action, MCP approval denial/approval, logout.
4. **Add upgrade and recovery tests.** Install `1.0.6`, upgrade to the candidate,
   verify hosts/secrets/team data survive; corrupt `team.sqlite` and verify the
   app refuses safely or restores a backup; interrupt an update and verify
   rollback.
5. **Add negative security tests.** Injection payloads in host fields, path
   traversal in resource copy/MCP paths, CSV formula injection (already covered),
   XSS strings in labels, auth/RBAC matrix, rate-limit exhaustion, secret leakage
   in logs and error messages, IPC fuzzing.
6. **Set coverage gates.** Target 70% overall and 90% for vault, auth, IPC
   validation, SSH argument construction and audit logging. Coverage is a floor,
   not a substitute for the negative tests.
7. **Add load tests.** Startup time, fleet refresh with the documented maximum
   host/guest count, memory growth over a 24-hour soak, and UI responsiveness while
   a backup/install runs.
8. **Add static analysis.** ESLint with TypeScript rules, Prettier check,
   `actionlint` and `zizmor` for workflows, CodeQL, gitleaks, and a license/SBOM
   check. Pin third-party Actions by commit SHA.

**Exit criteria:** unit, integration and Windows E2E suites run in CI; coverage
gates met; upgrade/rollback and corruption-recovery tests pass; no high-severity
static-analysis or secret-scanning findings.

### A3. Packaging, signing and updates (P1, 3–4 weeks)

1. **Ship an installer, not only a portable EXE.** NSIS or WiX/MSI with per-user
   and per-machine modes, silent install, upgrade, repair and uninstall. Keep the
   portable build for labs and USB use.
2. **Sign every executable and installer.** Authenticode with RFC 3161
   timestamping; verify signatures in CI and in the packaged smoke test. Sign the
   uninstaller too. Publish the signing certificate thumbprint and verification
   command.
3. **Add a safe update path.** Use a signed update feed with staged rollout,
   explicit user consent, signature and hash verification, and rollback. Portable
   builds can check for updates and hand off to a signed installer; they should
   not silently replace themselves.
4. **Add enterprise deployment guidance.** Intune/SCCM/GPO packaging notes,
   offline update bundles, proxy and custom-CA configuration, per-machine data
   location, and a "no internet" mode.
5. **Add crash reporting and diagnostics.** Local rotating logs with redaction,
   an opt-in crash reporter or local minidumps, and a support bundle containing
   version, OS, redacted config summary and recent logs. No hostnames, IPs,
   tokens or passwords by default.
6. **Harden the packaged runtime.** Verify ASAR integrity and fuses, remove source
   maps from production artifacts, set file version metadata, and document the
   exact Electron/Node/Chromium versions in the release notes.

**Exit criteria:** signed MSI and portable EXE; signature verification passes on a
clean VM; upgrade and rollback work; update feed cannot install an unsigned or
wrong-version artifact; support bundle is sufficient to diagnose a failed install.

### A4. Operations, data and documentation (P1/P2, 2–3 weeks)

1. **Backup and restore.** Document and test backup of `%APPDATA%\NexusPVE`
   including `keys/master.key`, `team.sqlite`, pipelines and incident data.
   Add an in-app export/import and a restore verification command.
2. **Database durability.** Batch/debounce `sql.js` exports instead of writing the
   whole database on every mutation; add a schema-version table, forward
   migrations with tests, `PRAGMA integrity_check` on open, and automatic
   pre-migration backups with rotation.
3. **Audit integrity.** Extend hash chaining to the team activity log and provide
   a verified export. Document what is and is not tamper-evident.
4. **Operational docs.** Administrator guide, security hardening guide, supported
   platforms, capacity limits, upgrade guide, disaster recovery, incident
   response, and a known-limitations page that matches reality.
5. **Project hygiene.** `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, issue/PR
   templates, `CHANGELOG.md`, a support policy, and third-party license notices.
6. **Accessibility.** Keyboard-only operation, focus management, screen-reader
   labels, contrast, and reduced-motion support for the console.

**Exit criteria:** a new administrator can deploy, back up, upgrade, roll back and
recover the app from the docs alone; database migrations and backups are tested;
the audit log is verifiable.

---

## 4. Workstream B — PRAETOR/1 protocol and executable

### B0. Give PRAETOR a real repository and CI (P0, 1–2 weeks)

PRAETOR currently has no standalone Git history and no CI. That is the first
blocker, before any cryptography work.

1. Create a dedicated repository (or a clearly separated monorepo) containing the
   JS reference, Rust crate, shared vectors, docs, fuzz targets and release
   workflows. The current home-directory repo is not an acceptable release
   boundary.
2. Preserve the existing layout and vectors; add a top-level `README`, `LICENSE`,
   `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `CODEOWNERS` and
   `docs/RELEASE.md`.
3. CI matrix: Ubuntu, Windows and macOS; Node 22/24 for the JS reference; Rust
   stable plus the declared MSRV `1.75`; `cargo fmt --check`, `cargo clippy
   --all-targets -- -D warnings`, `cargo test --locked` (debug and release),
   `cargo doc`, `npm ci`, `npm test`, browser parity, and cross-language vectors
   in both directions.
4. Add `cargo audit`, `cargo deny check`, `npm audit`, Dependabot/Renovate, and
   pinned Actions by SHA. Produce a CycloneDX SBOM for each release.
5. Make the Rust crate the production target. Rename/document the JS package as
   the reference implementation; it must not be the runtime for a production
   egress.

**Exit criteria:** a clean checkout builds and tests on all three platforms; the
JS and Rust implementations agree on shared vectors; dependency and license
checks pass; the repository has a tagged, signed release history.

### B1. Cryptographic and implementation hardening (P1, 4–8 weeks)

1. **Close the audit prerequisites first.** Write the audit package: current
   specification, threat model, exact code commit, test-vector coverage, fuzz
   harnesses, known limitations and a contact. Freeze the code before the audit
   starts.
2. **Independent audit.** Commission a focused review of PSEAL/1, PRAETOR-HS/1,
   WIRE and GUARD. Scope it as a composition review, not a review of ChaCha20 or
   ML-KEM. Budget remediation and a re-test. Publish a public summary.
3. **Formal verification.** Build ProVerif and/or Tamarin models for the handshake
   covering secrecy, agreement and key confirmation. Publish the models and
   results, including the bounds of what was checked.
4. **Constant-time and memory-safety review.** Audit secret-dependent branches,
   comparisons and indexing in Rust. Use `subtle` consistently; run `cargo-careful`
   and a Miri subset (excluding the C-backed AEGIS path as needed). Add `dudect`
   or an equivalent leakage test for tag/prefix comparisons. Audit `zeroize`
   coverage for long-term, session and epoch keys.
5. **Fuzzing.** Add `cargo-fuzz` targets for envelope parsing, cell parsing,
   container headers/chunks, handshake messages, guard policy JSON and CLI
   argument parsing. Run a short smoke in CI and a nightly soak with a committed
   corpus. Add regression cases for every finding.
6. **Resource limits and DoS.** Document and enforce maximum message, cell,
   fragment, container and handshake sizes; bound epoch windows and replay state;
   calibrate proof-of-work; add handshake-flood and slowloris tests. Ensure failure
   paths are constant-time and do not allocate unboundedly.
7. **Protocol governance.** Write the versioning and compatibility policy, the
   migration procedure for a suite change (no in-band agility), the deprecation
   policy, and the process for security advisories and CVEs.
8. **Remove the JS egress from production.** The current egress downloads a Node
   22 runtime and runs the JS bundle. Prefer a Rust `praetor-egress` binary built
   from the audited crate, with a static or narrowly pinned runtime. If Node must
   remain temporarily, pin the runtime, verify its signature/hash at install, and
   document the JS side-channel limitation prominently.

**Exit criteria:** audit report with no open critical/high findings; formal models
published; fuzzers run clean for the agreed soak; constant-time review signed off;
resource limits tested; production egress runs the Rust implementation.

### B2. Key lifecycle and operational security (P1/P2, 2–4 weeks)

1. **Key management.** Add passphrase-protected keys with a modern KDF
   (Argon2id where available; otherwise a reviewed scrypt profile), key
   fingerprints, `praetor key inspect`, `praetor key rotate`, and a documented
   cryptoperiod.
2. **Hardware/OS custody.** Integrate PKCS#11/TPM/OS keystore for long-term keys
   where the deployment requires it. Keep the guard in a separate process from
   the data plane. Document what the guard does and does not protect.
3. **Audit anchoring.** Add an exportable audit head and an external anchoring
   option (file, syslog, or a customer-controlled endpoint). Verify the chain on
   startup and expose `praetor audit verify`.
4. **Recovery.** Document Shamir custody, quorum procedures, lost-share recovery
   and emergency rotation. Test the runbook, not just the code.
5. **Operational interface.** `praetor doctor`, `praetor selftest`, structured
   logs, stable exit codes, `--json` on every command, config-file support,
   timeouts, and a loopback-only health/metrics endpoint for the egress service.
6. **Service hardening.** systemd unit with `NoNewPrivileges`, `PrivateTmp`,
   `ProtectSystem=strict`, `ProtectHome`, `CapabilityBoundingSet`, `RestrictAddressFamilies`
   and a dedicated user. Equivalent Windows service guidance if the egress runs
   there.

**Exit criteria:** key rotation and recovery rehearsed; audit chain verifiable;
egress runs as an unprivileged service with a minimal sandbox; operator runbook
covers compromise, rotation, recovery and rollback.

### B3. `praetor.exe` and release artifacts (P1/P2, 2–3 weeks)

1. **Build matrix.** Windows x64 (MSVC), Linux x64 and arm64 (glibc baseline,
   optional musl), macOS optional. Reproducible release builds with `--locked`,
   pinned toolchain, `SOURCE_DATE_EPOCH` and path remapping.
2. **CLI surface.** Stable `--help`/`--version`, `keygen`, `key inspect`,
   `key rotate`, `seal`, `open`, `encrypt`, `decrypt`, `selftest`, `doctor`,
   `bench`, `manifest`, `audit verify`. Shell completions for PowerShell, bash,
   zsh and fish; a man page.
3. **Packaging.** MSI or ZIP for Windows, tarball/package for Linux, optional
   `winget`/Homebrew formulae. Clear PATH and uninstall behavior. Do not require
   a Node runtime for the Rust binary.
4. **Signing and provenance.** Authenticode-sign `praetor.exe`; Sigstore/cosign
   sign the other artifacts; publish `SHA256SUMS`, SBOM and SLSA-style provenance.
   Sign release tags.
5. **Compatibility.** Publish a support matrix (OS, architecture, Rust MSRV,
   protocol version, wire version) and a compatibility policy for the CLI and
   library APIs.

**Exit criteria:** signed `praetor.exe` and Linux binaries; checksums and SBOM
published; a clean machine can install, run `selftest`, seal/open a file and
uninstall; release provenance points to the audited commit.

### B4. Validation and launch (P2/P3, 4–8 weeks + audit lead time)

1. **Pilot.** Deploy the candidate egress on a small, non-critical environment
   with two independent operators. Measure handshake success, throughput, CPU,
   memory, reconnect behavior and operational friction.
2. **Adversarial testing.** Run the fuzz corpora, handshake floods, malformed
   frames, replay/reorder/truncation, key rotation under load, and a rollback
   rehearsal. Fix and re-test.
3. **Audit remediation.** Close findings, get the auditor's re-test letter, and
   publish a summary that states the residual risks honestly.
4. **Release.** Tag `v1.0.0` only after the audit gate, sign everything, publish
   the security status and the supported-use statement.

**Exit criteria:** pilot exit report; no open audit critical/high findings; signed
release; public security status and limitations.

---

## 5. Shared release pipeline

Both projects should share the same principles even if the workflows differ.

| Gate | NexusPVE | PRAETOR |
|---|---|---|
| Clean checkout | `npm ci` from lockfile | `cargo build --locked` + `npm ci` |
| Static checks | TypeScript, ESLint, CodeQL, actionlint | rustfmt, clippy `-D warnings`, cargo-deny |
| Tests | unit, integration, edge, packaged smoke, Windows E2E | JS 59+, Rust 34+, cross-language vectors, fuzz smoke |
| Security | npm audit, secret scan, SBOM, license check | cargo audit, cargo deny, fuzz, SBOM |
| Build | Electron + electron-builder | Rust release + JS reference |
| Sign | Authenticode + timestamp | Authenticode + Sigstore |
| Publish | EXE, MSI, SHA256SUMS, SBOM, provenance | binaries, SHA256SUMS, SBOM, provenance |
| Rollback | signed previous installer + data backup | previous signed binary + key/config compatibility |

Release rules:

- No release from a dirty working tree.
- The tag must match `package.json` / `Cargo.toml`; the workflow fails otherwise.
- The artifact is built once, signed, smoke-tested, and promoted; do not rebuild
  after approval.
- Secrets live in protected CI environments with required reviewers; never in the
  repository or a developer machine.
- Keep the last two signed releases available for rollback.

---

## 6. Phasing and effort

Indicative ranges for one senior engineer plus part-time security help. These are
planning estimates, not commitments.

| Phase | Focus | Duration | Milestone |
|---|---|---|---|
| 0A | GitHub-dependent: unblock Actions, workflow execution, release publication | **blocked** | Deferred until billing is restored |
| 0L | Local-only: repo normalization, dependency upgrades, local preflight, Rust toolchain, signing/audit procurement | 1–2 weeks | Locally verified candidate; CI gates still open |
| 1 | Security defaults, host-key/TLS verification, MCP approval, test harness | 3–5 weeks | NexusPVE 1.1.0-rc |
| 2 | Installer, signing, updates, logging, backup/migration, PRAETOR repo/CI/fuzz | 3–4 weeks | Signed release candidate; PRAETOR production candidate |
| 3 | External pentest, PRAETOR audit, remediation, pilot | 8–12 weeks | Audit reports closed; pilot exit |
| 4 | Final hardening, docs, launch | 2–4 weeks | NexusPVE 1.1.0 GA; PRAETOR 1.0.0 GA for controlled use |

**NexusPVE:** roughly 8–12 weeks to a production candidate; add pentest and
remediation before GA.
**PRAETOR:** roughly 6–10 weeks of engineering to audit-ready, plus 8–12 weeks of
audit/remediation. Do not schedule a production launch before the audit result.

### Phase 0L — what can proceed while Actions is blocked

Do these locally now; they do not require a GitHub runner:

1. Normalize line endings, reconcile the uncommitted tree, remove the stale
   `.github-repo`, and verify that `v1.0.6` source matches the published binary.
2. Upgrade Electron, electron-builder and esbuild; run typecheck, build, tests and
   packaged smoke locally after each change.
3. Add a local preflight script that runs the same checks as CI and writes a
   timestamped report. This is evidence, not a substitute for a green workflow.
4. Install the Rust toolchain and run the 34 PRAETOR tests plus cross-language
   vectors locally; capture the exact toolchain and results.
5. Initialize the standalone PRAETOR repository locally with its CI workflows
   staged, so it is ready when a remote is available.
6. Start code-signing and audit procurement; both have external lead times.

Still blocked on GitHub: workflow execution, Windows runner matrix, release
signing/publishing, SBOM/provenance publication, and any gate that says "CI
passes." Do not mark those gates green until a runner executes real steps.

---

## 7. Go/no-go gates

A release is not production ready unless all of these are true.

### NexusPVE

- [ ] **BLOCKED:** CI and release workflows execute real steps on every supported runner.
- [ ] Clean checkout builds the exact artifact; tag, version and commit agree.
- [ ] No open critical/high findings in app, helpers, dependencies or update chain.
- [ ] Host keys and PVE TLS are verified by default; exceptions are explicit.
- [ ] Destructive MCP actions require human approval not controlled by the caller.
- [ ] Unit + integration + Windows E2E + packaged smoke pass.
- [ ] Signed installer and portable EXE; signature and checksum verified on a clean VM.
- [ ] Upgrade from 1.0.6, rollback, backup and restore tested.
- [ ] Support bundle and logs are sufficient to diagnose a failed install.
- [ ] Threat model, admin guide, security guide and incident runbook published.
- [ ] Independent penetration test closed.

### PRAETOR/1

- [ ] Rust is the production runtime; JS is reference/interop only.
- [ ] Independent audit of PSEAL/1, PRAETOR-HS/1, WIRE and GUARD closed.
- [ ] Formal verification models published; scope and limits stated.
- [ ] Fuzzers run clean for the agreed soak; regressions covered.
- [ ] Constant-time and zeroization review closed.
- [ ] Key generation, rotation, custody, recovery and audit anchoring tested.
- [ ] Signed `praetor.exe` and Linux binaries; checksums, SBOM and provenance published.
- [ ] Pilot exit criteria met; residual risks documented.
- [ ] Security status page states "audited" only if the audit actually covers it.

---

## 8. Decisions needed before implementation

These change the shape of the work, so they should be settled before Phase 1.

1. **Deployment model.** Single operations team on Windows, or multi-user/
   enterprise with SSO and centralized policy? The current plan assumes the former.
2. **Code signing.** Which route: managed cloud signing, an OV certificate, or an
   EV certificate? Who owns the identity and the hardware token?
3. **PRAETOR assurance target.** Controlled pilot, external production, or
   high-assurance/regulated? The audit scope and key-custody work depend on this.
4. **PRAETOR runtime.** Replace the Node egress with a Rust binary now, or keep
   Node temporarily and carry its documented limitations?
5. **Platform support.** Windows-only desktop, or Linux/macOS as supported
   operator platforms? The latter adds packaging and E2E work.
6. **Update policy.** Automatic updates allowed in the target environments, or
   offline/approved-only updates?
7. **Scale target.** Confirm the host/guest counts used for performance and soak
   tests.

---

## 9. Explicit non-goals for this pass

- FIPS 140-3 validation, CNSA 2.0 compliance, or a "military-grade" claim.
- A multi-tenant SaaS control plane or a hosted relay service.
- Mobile clients.
- Rewriting the Proxmox or SSH transports.
- A new cryptographic primitive. PRAETOR's value is the composition; this plan
  hardens and validates it, it does not invent anything new.

---

## 10. First ten local working days

Phase 0A is deferred. This is the local-only starting sequence, in order:

1. Add `.gitattributes`, reconcile the dirty tree, remove `.github-repo`, and
   verify `v1.0.6` source/binary equivalence. Do not delete real uncommitted work
   until it is reviewed.
2. Upgrade Electron, electron-builder and esbuild; keep typecheck, build, test and
   packaged smoke green locally after each change.
3. Add `scripts/local-preflight.mjs` that runs typecheck, build, tests and smoke,
   writes a timestamped JSON report with tool versions and artifact hashes, and
   exits non-zero on failure.
4. Add `SECURITY.md`, a threat-model skeleton, and `docs/RELEASE.md`.
5. Implement SSH host-key verification for the `ssh2` path and change the PVE TLS
   default; add regression tests. These are local behavior changes and do not
   need CI, but they need explicit approval because they affect existing hosts.
6. Add Vitest and the first unit tests for vault, config, SSH arguments and IPC
   validation.
7. Install the Rust toolchain, run the 34 PRAETOR tests and cross-language vectors,
   then run `cargo audit` and `cargo deny` locally.
8. Initialize the standalone PRAETOR repository locally with workflows staged;
   do not create a remote or publish anything yet.
9. Start code-signing procurement and draft the PRAETOR audit RFP.
10. When GitHub billing is restored, land the staged workflows, prove a runner
    executes steps, and close Phase 0A before any release.

Items 1–3 are the local blockers. Items 5–7 are the first security work. Until
Phase 0A closes, no artifact is release-ready, even if local checks pass.

---

## 11. What success looks like

An operator can download a signed NexusPVE installer, verify its signature and
checksum, deploy it through their normal Windows management path, connect to
Proxmox and Linux hosts with verified identities, and recover from a lost laptop
or a bad update using documented backups. Destructive actions require a human
approval that a model cannot forge.

A PRAETOR operator can install a signed Rust binary, verify its provenance, create
and rotate keys under a documented policy, run a sandboxed egress service, and
point to an independent audit and formal model that state exactly what the
protocol does and does not protect. The documentation says "audited" only where
that is true.
