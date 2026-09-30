import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Secrets must never reach the browser (ADR 0011). Next.js inlines any
      // process.env.NEXT_PUBLIC_* value into the client bundle, so ban them.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env'][property.name=/^NEXT_PUBLIC_/]",
          message:
            "process.env.NEXT_PUBLIC_* is forbidden: it is inlined into the client bundle. Read config on the server via src/lib/env.ts.",
        },
        {
          selector:
            "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env'][computed=true][property.value=/^NEXT_PUBLIC_/]",
          message:
            "process.env['NEXT_PUBLIC_*'] is forbidden: it is inlined into the client bundle. Read config on the server via src/lib/env.ts.",
        },
        {
          selector:
            "VariableDeclarator[init.type='MemberExpression'][init.object.name='process'][init.property.name='env'] > ObjectPattern > Property[key.name=/^NEXT_PUBLIC_/]",
          message:
            "Destructuring NEXT_PUBLIC_* from process.env is forbidden. Read config on the server via src/lib/env.ts.",
        },
      ],
    },
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
