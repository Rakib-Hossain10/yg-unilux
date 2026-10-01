import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

// ADR 0017: Mongoose, Better Auth's MongoDB adapter and our own code must all
// load the SAME `mongodb` driver copy. Two copies would mean two connection
// pools and ObjectId/Db instances that fail `instanceof` checks across them.

const root = path.resolve(__dirname, "../..");
const fromRoot = createRequire(path.join(root, "package.json"));

/** The mongodb copy a package would load, resolved from its own entry file. */
function driverPathFrom(pkg: string): string {
  // Resolve the entry point, not "<pkg>/package.json": some packages (e.g.
  // @better-auth/mongo-adapter) don't export their package.json.
  return createRequire(fromRoot.resolve(pkg)).resolve("mongodb/package.json");
}

describe("mongodb driver", () => {
  const ours = fromRoot.resolve("mongodb/package.json");

  it.each(["mongoose", "@better-auth/mongo-adapter"])(
    "%s resolves the same mongodb copy as the app",
    (pkg) => {
      expect(driverPathFrom(pkg)).toBe(ours);
    },
  );
});
