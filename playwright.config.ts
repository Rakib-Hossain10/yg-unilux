import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;
const baseURL = `http://localhost:${PORT}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  ...(isCI ? { workers: 1 } : {}),
  reporter: isCI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Production build, so tests see what Vercel serves (not the dev overlay),
    // started by e2e/test-server.ts against a seeded in-memory MongoDB.
    command:
      "npm run build && node --conditions=react-server --import tsx e2e/test-server.ts",
    url: baseURL,
    // Never reuse whatever runs on :3000 (e.g. `next dev` on the real
    // database): the tests need the seeded test accounts.
    reuseExistingServer: false,
    // First run on a machine downloads the MongoDB binary.
    timeout: 600_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
