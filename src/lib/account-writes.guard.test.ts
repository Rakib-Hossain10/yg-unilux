// Static guard (ADR 0068): src/lib/account-writes.ts is the ONLY source file
// (src/ and scripts/) that writes Better Auth's users through the internal
// adapter or the raw adapter, or deletes verification rows, and nothing
// calls the admin update endpoint from server code.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOTS = ["src", "scripts"].map((dir) => join(process.cwd(), dir));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const isSource = /\.(ts|tsx|mts)$/.test(entry.name);
    const isTest = /\.test\.(ts|tsx)$/.test(entry.name);
    return isSource && !isTest ? [path] : [];
  });
}

const files = ROOTS.flatMap(sourceFiles).map((path) => ({
  name: relative(process.cwd(), path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));

function filesMatching(pattern: RegExp): string[] {
  return files.filter((f) => pattern.test(f.text)).map((f) => f.name);
}

describe("one writer for our user fields", () => {
  it("scans the source tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("only account-writes.ts writes users through Better Auth's adapters", () => {
    const userWrite = new RegExp(
      [
        // internalAdapter.updateUser( / updateUserByEmail(
        String.raw`internalAdapter\s*\.\s*updateUser\w*\s*\(`,
        // const { updateUser } = ctx.context.internalAdapter
        String.raw`\bupdateUser\w*\s*[,}][^;]*=\s*[\w.]*internalAdapter`,
        // adapter.update({ model: "user" ... }) and friends
        String.raw`model:\s*"user"[\s\S]{0,200}?\b(update|updateMany|delete|deleteMany)\b`,
        String.raw`\.(update|updateMany)\(\{\s*model:\s*"user"`,
      ].join("|"),
    );
    expect(filesMatching(userWrite)).toEqual(["src/lib/account-writes.ts"]);
  });

  it("only account-writes.ts deletes verification rows through the adapter", () => {
    expect(
      filesMatching(
        /model:\s*"verification"[\s\S]{0,200}?\bdelete(Many)?\b|\.delete(Many)?\(\{\s*model:\s*"verification"|deleteVerification\w*\s*\(/,
      ),
    ).toEqual(["src/lib/account-writes.ts"]);
  });

  it("no server code calls auth.api.adminUpdateUser (it would bypass the allowlist)", () => {
    expect(filesMatching(/\.adminUpdateUser\s*\(/)).toEqual([]);
  });
});
