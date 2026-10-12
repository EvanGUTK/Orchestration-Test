import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sha256, sha256Hex, toHex, utf8Bytes } from "./sha256.js";

const nodeHex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("pure SHA-256", () => {
  it("matches FIPS 180-4 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches node:crypto at every padding boundary (0..200 bytes) and multi-block inputs", () => {
    for (let length = 0; length <= 200; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + length) & 0xff);
      expect(toHex(sha256(bytes))).toBe(nodeHex(bytes));
    }
    const big = Uint8Array.from({ length: 100_003 }, (_, i) => (i * 7919) & 0xff);
    expect(toHex(sha256(big))).toBe(nodeHex(big));
  });

  it("matches node:crypto for random byte arrays", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 1000 }), (bytes) => {
        expect(toHex(sha256(bytes))).toBe(nodeHex(bytes));
      }),
      { numRuns: 300 },
    );
  });

  it("hashes UTF-8 strings like node:crypto", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 200 }), (text) => {
        expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
      }),
      { numRuns: 200 },
    );
    expect(toHex(utf8Bytes("ünïcødé"))).toBe("c3bc6ec3af63c3b864c3a9");
  });

  it("does not mutate its input", () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    sha256(bytes);
    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
  });
});
