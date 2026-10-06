// Tests for src/lib/password-hash.ts: hashes are argon2id with the OWASP
// parameters, the right password verifies, and wrong passwords or broken or
// foreign hashes are a plain mismatch (never an exception).

import { describe, expect, it } from "vitest";

import { ARGON2_OPTIONS, hashPassword, verifyPassword } from "./password-hash";

describe("password hashing", () => {
  it("produces argon2id with m=19456, t=2, p=1 and a fresh salt each time", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(ARGON2_OPTIONS).toEqual({
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  });

  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(
      await verifyPassword({ hash, password: "correct horse battery" }),
    ).toBe(true);
    expect(
      await verifyPassword({ hash, password: "correct horse batterY" }),
    ).toBe(false);
    expect(await verifyPassword({ hash, password: "" })).toBe(false);
  });

  it("treats foreign, empty or truncated hashes as a mismatch", async () => {
    const hash = await hashPassword("pw-1234567890");
    for (const bad of [
      "",
      "salt:abcdef0123456789", // Better Auth's scrypt format
      "$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaA",
      "$argon2id$",
      hash.slice(0, 30),
    ]) {
      await expect(
        verifyPassword({ hash: bad, password: "test-password-0000" }),
      ).resolves.toBe(false);
    }
  });
});
