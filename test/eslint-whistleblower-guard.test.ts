// Proves the ESLint guard that keeps IP code out of whistleblower files
// (CLAUDE.md rule 7, ADR 0022): every known way to reach an IP from
// whistleblower code is an error there, while the same code elsewhere is not.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: root });
const GUARD = /never read or store an IP/;

/* Lints `code` as if it lived at `file` and returns the guard's messages. */
async function guardMessages(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(root, file),
  });
  return (result?.messages ?? [])
    .map((m) => m.message)
    .filter((m) => GUARD.test(m));
}

// Every way QA found to reach an IP from whistleblower code.
const IMPORTS = [
  `import { clientNetwork } from "@/lib/client-ip";`,
  `import { consumeSignIn } from "@/lib/sign-in-limit";`,
  `import * as limit from "@/lib/sign-in-limit"; void limit;`,
  `import type { ClientNetwork } from "@/lib/client-ip";`,
  `import { clientNetwork } from "../../lib/client-ip";`,
  `import { clientNetwork } from "@/lib/client-ip.ts";`,
  `import { clientNetwork } from "@/lib/client-ip/index";`,
  `import { consume } from "@/lib/rate-limit";`,
  `import { verifyDeviceToken } from "@/lib/device-token";`,
  `import { issueDeviceToken } from "../../lib/device-token";`,
  `import { consume } from "../../lib/rate-limit";`,
  `import { ipAddress } from "@vercel/functions"; void ipAddress;`,
  `export { clearSignIn } from "@/lib/sign-in-limit";`,
  `export async function f() { return import("@/lib/client-ip"); }`,
  "export async function f() { return import(`@/lib/client-ip`); }",
  `export async function f() { return import("@/lib/" + "client-ip"); }`,
  `import { createRequire } from "node:module"; createRequire(import.meta.url)("x");`,
  `export const ip = (h: Headers) => h.get("x-vercel-forwarded-for");`,
  `export const ip = (req: Request) => req.headers.get("x-forwarded-for");`,
  "export const ip = (h: Headers) => h.get(`x-real-ip`);",
];

const GUARDED_FILES = [
  "src/app/whistleblower/page.tsx",
  "src/app/whistleblower/report/actions.ts",
  "src/app/(site)/whistleblower/page.tsx",
  "src/app/api/whistleblower/route.ts",
  "src/app/api/whistleblower/cases/[id]/route.ts",
  "src/lib/whistleblower.ts",
  "src/lib/whistleblower/cases.ts",
  "src/components/whistleblower/form.tsx",
  "src/components/site/whistleblower-form.tsx",
];

describe("ESLint whistleblower IP guard", () => {
  it.each(GUARDED_FILES)(
    "rejects every IP-module import in %s",
    async (file) => {
      for (const code of IMPORTS) {
        expect((await guardMessages(file, code)).length, code).toBeGreaterThan(
          0,
        );
      }
    },
  );

  it("allows the same imports outside whistleblower code", async () => {
    for (const code of IMPORTS) {
      expect(await guardMessages("src/app/api/auth/route.ts", code)).toEqual(
        [],
      );
    }
  });

  it("keeps the global process.env ban in whistleblower files", async () => {
    const [result] = await eslint.lintText(
      `import { env } from "node:process"; void env;`,
      { filePath: path.join(root, "src/app/whistleblower/page.tsx") },
    );
    expect(result?.messages.map((m) => m.message).join("\n")).toMatch(
      /src\/lib\/env\.ts/,
    );
  });

  it("fires on a real probe file on disk, which is then deleted", async () => {
    const parent = path.join(root, "src/app/whistleblower");
    // Remove the whole folder afterwards only if this test created it.
    const created = !existsSync(parent);
    const dir = path.join(parent, "__eslint-probe__");
    const file = path.join(dir, "probe.ts");
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(file, `${IMPORTS[0]}\nvoid clientNetwork;\n`);
      const [result] = await eslint.lintFiles([file]);
      expect(result?.messages.some((m) => GUARD.test(m.message))).toBe(true);
    } finally {
      rmSync(created ? parent : dir, { recursive: true, force: true });
    }
    expect(existsSync(file)).toBe(false);
  });
}, 120_000);
