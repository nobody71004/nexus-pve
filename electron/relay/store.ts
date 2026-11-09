import fs from "node:fs";
import path from "node:path";
import { nexusHome } from "../paths";
import type { RelayChain } from "../../shared/fabric-types";

interface StoredRelay {
  version: 1;
  chain?: RelayChain;
}

/**
 * relay.json deliberately contains topology only. WireGuard private keys are
 * generated for a deploy and written straight to the remote host; they are not
 * persisted in the desktop profile.
 */
export class RelayStore {
  readonly file = path.join(nexusHome(), "relay.json");

  read(): StoredRelay {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<StoredRelay>;
      return { version: 1, chain: parsed.chain };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
      const bad = path.join(nexusHome(), `relay.corrupt-${Date.now()}.json`);
      try {
        fs.renameSync(this.file, bad);
      } catch {
        /* best effort */
      }
      return { version: 1 };
    }
  }

  write(value: StoredRelay): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows */
    }
  }

  chain(): RelayChain | null {
    return this.read().chain ?? null;
  }

  save(chain: RelayChain): RelayChain {
    this.write({ version: 1, chain });
    return chain;
  }

  remove(): void {
    try {
      fs.unlinkSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
