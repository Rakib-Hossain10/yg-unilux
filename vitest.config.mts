import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": fromRoot("./src"),
      "server-only": fromRoot("./test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    // Fetches the MongoDB binary once before workers start (cold-cache race).
    globalSetup: ["./test/global-setup.ts"],
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["node_modules/**", "e2e/**", ".next/**"],
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
