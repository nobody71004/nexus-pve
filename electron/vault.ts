import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { keyPath, nexusHome } from "./paths";

/**
 * Secrets are encrypted at rest with AES-256-GCM. The key lives beside the
 * config with owner-only permissions. This is deliberately not OS-keychain
 * bound: the MCP server must be able to read the same vault while the desktop
 * UI is closed, so both processes share one key file.
 */
let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const file = keyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const raw = fs.readFileSync(file);
    if (raw.length !== 32) throw new Error("key file has wrong length");
    cachedKey = raw;
    return raw;
  } catch {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, key, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows ACLs govern here; the file sits inside the per-user profile. */
    }
    cachedKey = key;
    return key;
  }
}

/** Format: v1.<iv b64>.<tag b64>.<ciphertext b64> */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${data.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
  if (!blob.startsWith("v1.")) {
    // Tolerate a value written by an older build in plaintext.
    return blob;
  }
  const [, ivB64, tagB64, dataB64] = blob.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("malformed secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export function homeMode(): string {
  try {
    return fs.statSync(nexusHome()).mode.toString(8);
  } catch {
    return "missing";
  }
}

/**
 * Keyed digest for local integrity metadata (signed policy, audit anchors).
 * It never leaves the machine and is not used to encrypt anything.
 */
export function signPayload(payload: string): string {
  return crypto.createHmac("sha256", loadKey()).update(payload).digest("hex");
}
