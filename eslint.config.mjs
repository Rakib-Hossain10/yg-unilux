import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Secrets must never reach the browser (ADR 0011). The bundler inlines any
// NEXT_PUBLIC_* env value into client JS however it is accessed (dot, bracket,
// template literal, alias, cast, non-null assertion), so ban the name itself.
const PUBLIC_ENV_MESSAGE =
  "Env vars named NEXT_PUBLIC_* are inlined into the client bundle and are forbidden. Read config on the server via src/lib/env.ts.";
const noNextPublic = [
  "error",
  {
    selector: "Identifier[name=/^NEXT_PUBLIC_/]",
    message: PUBLIC_ENV_MESSAGE,
  },
  { selector: "Literal[value=/^NEXT_PUBLIC_/]", message: PUBLIC_ENV_MESSAGE },
  {
    selector: "TemplateElement[value.raw=/NEXT_PUBLIC_/]",
    message: PUBLIC_ENV_MESSAGE,
  },
];

// All env access goes through src/lib/env.ts (validated, server-only).
const PROCESS_ENV_MESSAGE =
  "Read environment variables only through src/lib/env.ts (tests: vi.stubEnv).";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-restricted-syntax": noNextPublic,
      "no-restricted-properties": [
        "error",
        { object: "process", property: "env", message: PROCESS_ENV_MESSAGE },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "process",
              importNames: ["env"],
              message: PROCESS_ENV_MESSAGE,
            },
            {
              name: "node:process",
              importNames: ["env"],
              message: PROCESS_ENV_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    // The env module itself, tool configs and Node scripts read process.env.
    files: ["src/lib/env.ts", "*.config.{ts,mts,mjs,js,cjs}", "scripts/**"],
    rules: {
      "no-restricted-properties": "off",
      "no-restricted-imports": "off",
    },
  },
  {
    // This test asserts that NEXT_PUBLIC_ never appears in the repo, so it has
    // to spell the name. It is never bundled.
    files: ["test/repo-security.test.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Not project source:
    ".claude/**",
    ".agents/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
