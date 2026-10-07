// Runs once, after the web server is up and before any spec: signs the e2e
// admin and customer in through the real login form and saves their cookies
// (e2e/fixtures/auth-state.ts), so specs reuse a session instead of signing in
// again and tripping the per-email limiter (gate C, M-1). Uses http://localhost
// because the __Host- device cookie needs it, and never waits for networkidle.

import { chromium, expect, type FullConfig } from "@playwright/test";

import { E2E_ADMIN, E2E_CUSTOMER } from "./fixtures/accounts";
import {
  E2E_ADMIN_STATE_FILE,
  E2E_CUSTOMER_STATE_FILE,
} from "./fixtures/auth-state";

async function signInTo(
  baseURL: string,
  account: { email: string; password: string },
  file: string,
): Promise<void> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      baseURL,
      // Its own bucket for the per-IP limiter, apart from the specs'.
      extraHTTPHeaders: { "x-vercel-forwarded-for": "203.0.113.200" },
    });
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await context.storageState({ path: file });
    await context.close();
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? "http://localhost:3000";
  await signInTo(baseURL, E2E_ADMIN, E2E_ADMIN_STATE_FILE);
  await signInTo(baseURL, E2E_CUSTOMER, E2E_CUSTOMER_STATE_FILE);
}
