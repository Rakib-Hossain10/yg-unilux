// Tests for the seed:admin CLI's argument handling (scripts/seed-admin.ts):
// passwords are never accepted as arguments, and create/reset need the right
// flags. The database work is tested in src/lib/seed-admin.test.ts.

import { describe, expect, it } from "vitest";

import packageJson from "../package.json";

import { envFileHasPassword, parseCli } from "./seed-admin";

describe("parseCli", () => {
  it("reads a create command", () => {
    expect(
      parseCli(["--email", "a@example.com", "--name", "YG Admin"]),
    ).toEqual({
      email: "a@example.com",
      name: "YG Admin",
      reset: false,
    });
  });

  it("reads a reset command", () => {
    expect(parseCli(["--email", "a@example.com", "--reset"])).toEqual({
      email: "a@example.com",
      name: undefined,
      reset: true,
    });
  });

  it.each([
    ["--password", "x"],
    ["--password=secret-value"],
    ["-pw", "x"],
    ["--PASS", "x"],
  ])("refuses a password argument: %s", (...args) => {
    const result = parseCli(["--email", "a@example.com", "--reset", ...args]);
    expect(result).toEqual({
      error: expect.stringMatching(/Never pass the password/),
    });
  });

  it.each([
    [[], /--email is required/],
    [["--email", "a@example.com"], /--name is required/],
    [
      ["--email", "a@example.com", "--reset", "--name", "X"],
      /only used when creating/,
    ],
    [
      ["--email", "a@example.com", "--reset", "--role", "admin"],
      /Unrecognised argument \(not shown/,
    ],
    [["--email", "a@example.com", "--reset", "extra"], /not shown/],
  ])("refuses %j", (argv, message) => {
    const result = parseCli(argv as string[]);
    expect("error" in result && result.error).toMatch(message);
  });
});

it("returns help for --help", () => {
  expect(parseCli(["--help"])).toEqual({ help: true });
});

describe("envFileHasPassword", () => {
  it("spots a saved password, also with export or spaces", () => {
    expect(envFileHasPassword("A=1\nSEED_ADMIN_PASSWORD=abc\n")).toBe(true);
    expect(envFileHasPassword("  export SEED_ADMIN_PASSWORD = abc")).toBe(true);
  });
  it("ignores an empty entry, a comment and similar names", () => {
    expect(envFileHasPassword("SEED_ADMIN_PASSWORD=\n")).toBe(false);
    expect(envFileHasPassword("# SEED_ADMIN_PASSWORD=abc")).toBe(false);
    expect(envFileHasPassword("MY_SEED_ADMIN_PASSWORD=abc")).toBe(false);
  });
});

describe("npm script", () => {
  it("runs the CLI with the same node flags as db:indexes", () => {
    expect(packageJson.scripts["seed:admin"]).toBe(
      packageJson.scripts["db:indexes"].replace(
        "sync-indexes.ts",
        "seed-admin.ts",
      ),
    );
  });
});
