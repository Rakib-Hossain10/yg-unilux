// Password hashing for Better Auth (`emailAndPassword.password.hash/verify`):
// argon2id with OWASP's parameters, instead of Better Auth's default scrypt.
// Hashes are self-describing PHC strings ("$argon2id$v=19$m=19456,t=2,p=1$...").

import "server-only";

import { type Algorithm, type Options, hash, verify } from "@node-rs/argon2";

/*
 * `Algorithm` is an ambient const enum, which isolatedModules can't read, so
 * the value is spelled out: @node-rs/argon2 2.2.1 index.d.ts Argon2id = 2.
 */
const ARGON2ID: Algorithm = 2;

/*
 * OWASP Password Storage Cheat Sheet, argon2id minimum: m = 19 MiB, t = 2,
 * p = 1. It costs an attacker 19 MiB of memory per guess (which defeats GPU
 * farms far better than scrypt's defaults), while one hash takes roughly
 * 20-50 ms and 19 MiB on a Vercel function, so a sign-in burst can't exhaust
 * the instance. Raise memoryCost (and keep t >= 2) if hardware allows;
 * verify() reads the parameters from each stored hash, so old hashes keep
 * working after a change.
 */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const satisfies Options;

/** Hashes a password with argon2id and a fresh random salt. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * True when `password` matches `hashed`. Anything that is not a valid
 * argon2id hash counts as a mismatch: every hash we store is argon2id, so
 * another format means a corrupted or foreign record, and answering "wrong
 * password" (401) reveals less than an error would.
 */
export async function verifyPassword(data: {
  hash: string;
  password: string;
}): Promise<boolean> {
  if (!data.hash.startsWith("$argon2id$")) return false;
  try {
    return await verify(data.hash, data.password);
  } catch {
    // @node-rs/argon2 rejects a PHC string it can't parse (e.g. truncated).
    // That is a broken record, not a match: report "wrong password". The
    // error carries nothing worth logging and may echo the hash.
    return false;
  }
}
