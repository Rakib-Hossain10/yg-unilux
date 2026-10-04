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
const processEnvImports = [
  { name: "process", importNames: ["env"], message: PROCESS_ENV_MESSAGE },
  { name: "node:process", importNames: ["env"], message: PROCESS_ENV_MESSAGE },
];

// Whistleblower code must never see or store an IP (CLAUDE.md rule 7, ADR
// 0005/0022): reporters stay anonymous. In any whistleblower file or folder
// it may not import the IP reader, the rate limiters, the sign-in device
// token, @vercel/functions, Better Auth or our auth modules (Better Auth reads
// client IPs for its limiter) by alias, relative path, /index, import(),
// require or createRequire; may not spell an IP header name; and may not log
// or dump a whole header list. Lint can't see barrel re-exports or a helper
// that imports these indirectly (e.g. requireAdmin() in @/lib/permissions);
// Phase 8 adds a runtime test that whistleblower routes write nothing to
// loginAttempts and store no IP.
const WHISTLEBLOWER_FILES = [
  "src/**/whistleblower*",
  "src/**/whistleblower*/**",
];
const IP_MODULES_MESSAGE =
  "Whistleblower code must never read or store an IP (CLAUDE.md rule 7). Do not use client-ip, rate-limit, sign-in-limit, device-token, auth, Better Auth, @vercel/functions or IP headers here.";
const IP_MODULE_REGEX = String.raw`((^|/)(client-ip|sign-in-limit|rate-limit|device-token|auth|auth-handler)(/index)?(\.[cm]?[jt]sx?)?$)|(^@vercel/functions(/|$))|(^better-auth(/|$))|(^@better-auth/)`;
// The same match for esquery selectors, whose /regex/ can't contain "/".
const IP_MODULE_SELECTOR_REGEX = String.raw`/(client-ip|sign-in-limit|rate-limit|device-token|@vercel.functions|better-auth|lib.auth)/`;
const IP_HEADER_SELECTOR_REGEX = String.raw`/forwarded|x-real-ip|client-ip|true-client-ip|cf-connecting-ip/i`;
// Something that is a whole header list: `headers`, `h.headers`, `req.headers`.
const HEADERS_NAME = String.raw`/^(headers|requestHeaders|headerList|headersList)$/i`;
const whistleblowerSyntax = [
  // import() only with a plain string, so the import rule can see the path.
  "ImportExpression:not([source.type='Literal'])",
  `ImportExpression[source.value=${IP_MODULE_SELECTOR_REGEX}]`,
  "CallExpression[callee.name='require']:not([arguments.0.type='Literal'])",
  `CallExpression[callee.name='require'][arguments.0.value=${IP_MODULE_SELECTOR_REGEX}]`,
  "Identifier[name='createRequire']",
  // Reading the header directly, e.g. headers().get("x-forwarded-for").
  `Literal[value=${IP_HEADER_SELECTOR_REGEX}]`,
  `TemplateElement[value.raw=${IP_HEADER_SELECTOR_REGEX}]`,
  // Dumping a whole header list (QA L3): logging it, serialising it,
  // spreading or iterating it, Object.fromEntries/Array.from over it.
  `CallExpression[callee.object.name='console'] Identifier[name=${HEADERS_NAME}]`,
  `CallExpression[callee.object.name='console'] MemberExpression[property.name='headers']`,
  `CallExpression[callee.object.name='JSON'] > Identifier[name=${HEADERS_NAME}]`,
  `CallExpression[callee.object.name='JSON'] > MemberExpression[property.name='headers']`,
  `CallExpression[callee.property.name=/^(fromEntries|from)$/] > Identifier[name=${HEADERS_NAME}]`,
  `CallExpression[callee.property.name=/^(fromEntries|from)$/] > MemberExpression[property.name='headers']`,
  `SpreadElement > Identifier[name=${HEADERS_NAME}]`,
  `SpreadElement > MemberExpression[property.name='headers']`,
  `CallExpression[callee.property.name=/^(entries|keys|values|forEach)$/][callee.object.name=${HEADERS_NAME}]`,
  `CallExpression[callee.property.name=/^(entries|keys|values|forEach)$/][callee.object.property.name='headers']`,
  `ForOfStatement > Identifier.right[name=${HEADERS_NAME}]`,
  `ForOfStatement > MemberExpression.right[property.name='headers']`,
].map((selector) => ({ selector, message: IP_MODULES_MESSAGE }));

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
      "no-restricted-imports": ["error", { paths: processEnvImports }],
    },
  },
  {
    // Repeats the global rules too: a later config replaces a rule's options.
    files: WHISTLEBLOWER_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: processEnvImports,
          patterns: [{ regex: IP_MODULE_REGEX, message: IP_MODULES_MESSAGE }],
        },
      ],
      "no-restricted-syntax": [
        "error",
        ...noNextPublic.slice(1),
        ...whistleblowerSyntax,
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
    // The e2e test server sets test-only env for its in-memory database and
    // `next start`. Only process.env is allowed; import guards stay on.
    files: ["e2e/test-server.ts"],
    rules: { "no-restricted-properties": "off" },
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
