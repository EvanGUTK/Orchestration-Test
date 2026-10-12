import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Argon2id password hashing with a per-user random salt and VERSIONED parameters stored next to
 * the hash, PHC-style:
 *
 *   $argon2id$v=19$pv=<paramsVersion>,m=<KiB>,t=<passes>,p=<lanes>$<salt b64>$<tag b64>
 *
 * `pv` names the parameter set; raising it (or any of m/t/p) makes `needsRehash` true so the next
 * successful login transparently upgrades the stored hash. Passwords are NFC-normalized UTF-8 so
 * the same visible password typed through different input methods verifies. Plaintext is never
 * stored or logged.
 */
export type PasswordParams = {
  version: number;
  memoryKiB: number;
  passes: number;
  parallelism: number;
  tagLength: number;
  saltLength: number;
};

/** OWASP 2023 Argon2id baseline (m=19 MiB, t=2, p=1). */
export const PASSWORD_PARAMS_V1: PasswordParams = {
  version: 1,
  memoryKiB: 19_456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
  saltLength: 16,
};

export const CURRENT_PASSWORD_PARAMS = PASSWORD_PARAMS_V1;

type ParsedHash = { params: PasswordParams; salt: Buffer; tag: Buffer };

const PATTERN =
  /^\$argon2id\$v=19\$pv=(\d{1,4}),m=(\d{1,8}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function b64(buffer: Buffer): string {
  return buffer.toString("base64").replace(/=+$/, "");
}

function parse(stored: string): ParsedHash | null {
  const m = PATTERN.exec(stored);
  if (!m) return null;
  const salt = Buffer.from(m[5] as string, "base64");
  const tag = Buffer.from(m[6] as string, "base64");
  const params: PasswordParams = {
    version: Number(m[1]),
    memoryKiB: Number(m[2]),
    passes: Number(m[3]),
    parallelism: Number(m[4]),
    tagLength: tag.length,
    saltLength: salt.length,
  };
  if (salt.length < 8 || tag.length < 16 || params.passes < 1 || params.parallelism < 1) return null;
  if (params.memoryKiB < 8 * params.parallelism) return null;
  return { params, salt, tag };
}

function derive(password: string, salt: Buffer, params: PasswordParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        message: Buffer.from(password.normalize("NFC"), "utf8"),
        nonce: salt,
        parallelism: params.parallelism,
        tagLength: params.tagLength,
        memory: params.memoryKiB,
        passes: params.passes,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Small FIFO semaphore bounding concurrent Argon2 derivations (each uses ~19 MiB and a pool thread). */
class Semaphore {
  #free: number;
  readonly #waiters: (() => void)[] = [];
  constructor(slots: number) {
    this.#free = Math.max(1, slots);
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free -= 1;
    else await new Promise<void>((resolve) => this.#waiters.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.#waiters.shift();
      if (next) next();
      else this.#free += 1;
    }
  }
}

export const DEFAULT_HASH_CONCURRENCY = 2;

export class PasswordHasher {
  readonly params: PasswordParams;
  readonly #limit: Semaphore;
  #dummy: Promise<string> | null = null;

  constructor(params: PasswordParams = CURRENT_PASSWORD_PARAMS, options: { concurrency?: number } = {}) {
    this.params = params;
    this.#limit = new Semaphore(options.concurrency ?? DEFAULT_HASH_CONCURRENCY);
  }

  /** Builds the dummy hash used for unknown usernames ahead of the first login (SEC-FIX-001 L1). */
  async warmup(): Promise<void> {
    this.#dummy ??= this.hash("dummy-password-for-timing-equalization");
    await this.#dummy;
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(this.params.saltLength);
    const tag = await this.#limit.run(() => derive(password, salt, this.params));
    const p = this.params;
    return `$argon2id$v=19$pv=${p.version},m=${p.memoryKiB},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(tag)}`;
  }

  /** Constant-time verification. A malformed stored hash never verifies. */
  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) return false;
    const tag = await this.#limit.run(() => derive(password, parsed.salt, parsed.params));
    return tag.length === parsed.tag.length && timingSafeEqual(tag, parsed.tag);
  }

  /**
   * Burns the same work as a real verification, for unknown usernames, so response timing does
   * not reveal whether an account exists.
   */
  async verifyDummy(password: string): Promise<false> {
    this.#dummy ??= this.hash("dummy-password-for-timing-equalization");
    await this.verify(password, await this.#dummy);
    return false;
  }

  needsRehash(stored: string): boolean {
    const parsed = parse(stored);
    if (!parsed) return true;
    const a = parsed.params;
    const b = this.params;
    return (
      a.version !== b.version ||
      a.memoryKiB !== b.memoryKiB ||
      a.passes !== b.passes ||
      a.parallelism !== b.parallelism ||
      a.tagLength !== b.tagLength ||
      a.saltLength !== b.saltLength
    );
  }
}
