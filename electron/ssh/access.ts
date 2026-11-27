import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ConfigStore } from "../config";
import { nexusHome } from "../paths";
import type { SshAccessBundle, SshAccessImportResult, SshHostInput } from "../../shared/types";

/**
 * One-step access handoff.
 *
 * Adding a machine by hand means typing an address, a port, a username and a
 * key path — and a single wrong field produces "Permission denied" or a
 * timeout that looks like the host is down. A bundle carries the whole entry
 * (plus the private key, when the recipient has no copy) so importing the file
 * is the only step: keys are written under the app's key directory with 0600,
 * and a card with the same label is updated in place instead of duplicating it.
 *
 * The bundle is a local secret. Nothing here logs or returns key material.
 */

const BUNDLE_VERSION = 1;
const MAX_HOSTS = 50;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

function plain(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readAccessBundle(file: string): SshAccessBundle {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw new Error(`Cannot read the access bundle at ${file} (${reason}).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The access bundle is not valid JSON.");
  }
  const bundle = parsed as Partial<SshAccessBundle> | null;
  if (!bundle || typeof bundle !== "object") throw new Error("The access bundle is empty.");
  if (Number(bundle.version) !== BUNDLE_VERSION) {
    throw new Error(`Unsupported access bundle version ${String(bundle.version)}; this build reads version ${BUNDLE_VERSION}.`);
  }
  if (!Array.isArray(bundle.hosts) || bundle.hosts.length === 0) {
    throw new Error("The access bundle contains no hosts.");
  }
  if (bundle.hosts.length > MAX_HOSTS) {
    throw new Error(`The access bundle contains more than ${MAX_HOSTS} hosts.`);
  }
  return bundle as SshAccessBundle;
}

/** Deterministic, filesystem-safe name so re-importing the same bundle is a no-op. */
function keyFileName(label: string, host: string): string {
  const slug =
    `${label}-${host}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "host";
  const digest = crypto.createHash("sha256").update(`${label}\n${host}`).digest("hex").slice(0, 8);
  return `imported-${slug}-${digest}.key`;
}

function writePrivateKey(file: string, material: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, material.endsWith("\n") ? material : `${material}\n`, { mode: 0o600 });
  try {
    // Windows ignores POSIX modes; on Unix this enforces key-file permissions.
    fs.chmodSync(file, 0o600);
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
}

export function importAccessBundle(store: ConfigStore, file: string, ownerId?: string): SshAccessImportResult {
  const bundle = readAccessBundle(file);
  const existing = store.read().sshHosts;
  const keysDir = path.join(nexusHome(), "sshkeys");
  const added: string[] = [];
  const updated: string[] = [];

  for (const entry of bundle.hosts) {
    const host = plain(entry?.host);
    const username = plain(entry?.username);
    const label = plain(entry?.label) || `${username}@${host}`;
    if (!host || /\s/.test(host)) throw new Error(`Host "${label}" has no usable address.`);
    if (!username) throw new Error(`Host "${label}" has no username.`);
    if (/\s/.test(username)) throw new Error(`Host "${label}" has an invalid username.`);
    const port = Number(entry?.port ?? 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Host "${label}" has an invalid port.`);
    }

    let keyPath = plain(entry?.keyPath) || undefined;
    const material = plain(entry?.privateKey);
    if (material) {
      if (!PRIVATE_KEY.test(material)) throw new Error(`The bundled key for "${label}" is not a private key.`);
      keyPath = path.join(keysDir, keyFileName(label, host));
      writePrivateKey(keyPath, material);
    }

    // Same display name wins, so a handed-over bundle fixes the card the person
    // already has instead of leaving a duplicate next to it. `replaces` covers
    // the card that still holds an old endpoint under a different address.
    const superseded = new Set((entry?.replaces ?? []).map((value) => plain(value).toLowerCase()).filter(Boolean));
    const match =
      existing.find((candidate) => candidate.label.trim().toLowerCase() === label.toLowerCase()) ??
      existing.find((candidate) => superseded.has(candidate.host.trim().toLowerCase())) ??
      existing.find(
        (candidate) =>
          candidate.host.trim().toLowerCase() === host.toLowerCase() &&
          candidate.username.trim().toLowerCase() === username.toLowerCase(),
      );

    const input: SshHostInput = {
      ...(match ? { id: match.id } : {}),
      label,
      host,
      port,
      username,
      authMode: "key",
      ...(keyPath ? { keyPath } : {}),
      ...(plain(entry?.color) ? { color: plain(entry?.color) } : {}),
    };
    store.saveSshHost(input, ownerId);
    (match ? updated : added).push(`${label} (${username}@${host}:${port})`);
  }

  return { ok: true, added, updated };
}
