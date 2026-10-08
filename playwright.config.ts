import { defineConfig, devices } from "@playwright/test";

import { E2E_PROVIDER_ENV } from "./e2e/fixtures/providers-port";

const PORT = 3000;
const baseURL = `http://localhost:${PORT}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  // Signs the e2e admin and customer in once (M-1); specs reuse the cookies.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // One worker everywhere. The specs share ONE database (categories and areas
  // are moved up and down, rows are counted); with parallel workers a spec
  // sees the others' data (gate C's M-1 follow-up). Sign-in is no longer the
  // limit (global setup signs in once), so this is only about shared state.
  workers: 1,
  reporter: isCI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      testIgnore:
        /admin-settings-gate-d|admin-product\.spec|admin-import\.spec/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Changes site-wide settings and clears filter numbers on EVERY product
      // in the shared test database, so it must not overlap the other specs
      // (the suite runs on one worker, but keep the order explicit). It starts after them.
      name: "settings-gate-d",
      testMatch: /admin-settings-gate-d/,
      dependencies: ["chromium"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // The Phase 2 exit flow (T18) creates a category, an area, a product and
      // datasheets in the shared database. The catalog spec moves categories
      // and areas up and down and counts list rows, so the two must not
      // overlap: this project runs last, after chromium and settings-gate-d.
      name: "admin-exit",
      testMatch: /admin-product\.spec/,
      dependencies: ["chromium", "settings-gate-d"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // The Phase 3 exit flow (T11) imports products into the shared database
      // (a category, an area and five draft products, removed afterwards). It
      // runs after every other project so no list count sees them.
      name: "admin-import",
      testMatch: /admin-import\.spec/,
      dependencies: ["chromium", "settings-gate-d", "admin-exit"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Production build, so tests see what Vercel serves (not the dev overlay),
    // started by e2e/test-server.ts against a seeded in-memory MongoDB.
    command:
      "npm run build && node --conditions=react-server --import tsx e2e/test-server.ts",
    url: baseURL,
    // Never reuse whatever runs on :3000 (e.g. `next dev` on the real
    // database): the tests need the seeded test accounts.
    reuseExistingServer: false,
    // Fake R2/Cloudinary values for the BUILD too: the admin CSP names the R2
    // host at build time. The test server itself starts the in-memory fakes.
    env: { ...E2E_PROVIDER_ENV },
    // First run on a machine downloads the MongoDB binary.
    timeout: 600_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
