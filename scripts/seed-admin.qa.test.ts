// QA tests for the seed:admin CLI argument handling (scripts/seed-admin.ts):
// error output must never repeat a mistyped password, and the .env.local check
// must cope with Windows line endings and quoting.

import { describe, expect, it } from "vitest";

import { envFileHasPassword, parseCli } from "./seed-admin";

const SECRET = "Sup3r-Secret-Admin-Pass";

describe("parseCli QA", () => {
  it.each([
    [["--email", "a@example.com", "--reset", "-p", SECRET]],
    [["--email", "a@example.com", "--reset", `--passwd=${SECRET}`]],
    [["--email", "a@example.com", "--reset", "--secret", SECRET]],
    [["--email", "a@example.com", `--reset=${SECRET}`]],
    [["--email", "a@example.com", "--reset", "--Password", SECRET]],
  ])("does not echo the value in %j", (argv) => {
    const result = parseCli(argv);
    expect("error" in result).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  // QA finding L-1: node:util parseArgs quotes a stray positional verbatim
  // ("Unexpected argument '<value>'"); parseCli now replaces that message, so
  // a password typed after --reset is never printed.
  it("does not echo a stray positional (a password typed by mistake)", () => {
    const result = parseCli(["--email", "a@example.com", "--reset", SECRET]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("envFileHasPassword QA", () => {
  it("handles CRLF files and quoted values", () => {
    expect(envFileHasPassword("A=1\r\nSEED_ADMIN_PASSWORD=abc\r\n")).toBe(true);
    expect(envFileHasPassword("SEED_ADMIN_PASSWORD=\r\nB=2\r\n")).toBe(false);
    expect(envFileHasPassword('SEED_ADMIN_PASSWORD="abc def"')).toBe(true);
  });
});
