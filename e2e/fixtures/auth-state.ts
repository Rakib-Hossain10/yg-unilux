// Shared sign-in state. Sign-in is limited per email (10 per 15 minutes,
// ADR 0022) and a success does not reset it, so specs that each signed in
// again made the full run flaky (gate C, M-1). e2e/global-setup.ts signs the
// e2e admin and customer in ONCE and writes their cookies here; specs load
// them instead of using the login form. Throwaway accounts, in-memory database.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserContext } from "@playwright/test";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export const E2E_ADMIN_STATE_FILE = join(tmpdir(), "yg-e2e-admin-state.json");
export const E2E_CUSTOMER_STATE_FILE = join(
  tmpdir(),
  "yg-e2e-customer-state.json",
);

/** The signed-in cookies written by global setup. */
export function loadState(who: "admin" | "customer"): StorageState {
  const file = who === "admin" ? E2E_ADMIN_STATE_FILE : E2E_CUSTOMER_STATE_FILE;
  return JSON.parse(readFileSync(file, "utf8")) as StorageState;
}
