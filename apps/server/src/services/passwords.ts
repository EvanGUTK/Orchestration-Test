import argon2 from "argon2";
import type { ServerConfig } from "../config.ts";

/** Argon2id hashing. The salt is random per hash and embedded in the PHC string; no pepper or shared salt. */
export class PasswordHasher {
  readonly #opts: { type: 2; memoryCost: number; timeCost: number; parallelism: number };
  #dummy: Promise<string> | undefined;

  constructor(cfg: ServerConfig["argon2"]) {
    this.#opts = { type: argon2.argon2id, ...cfg };
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, this.#opts);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** Burn the same CPU as a real check so unknown usernames are not distinguishable by timing. */
  async verifyDummy(password: string): Promise<void> {
    this.#dummy ??= this.hash("dummy-password-for-timing-equalisation");
    await this.verify(await this.#dummy, password);
  }

  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, this.#opts);
    } catch {
      return false;
    }
  }
}
