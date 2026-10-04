// Phase 1 exit checks: the seeded admin signs in and reaches /admin; a
// customer gets a real 403 there; a visitor is sent to /login; a forged
// cookie gets no further; CN is geo-blocked and HK/MO/TW are not.

import { type Page, expect, test } from "@playwright/test";

import { E2E_ADMIN, E2E_CUSTOMER } from "./fixtures/accounts";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("admin access", () => {
  test("a visitor is redirected from /admin to /login", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("the seeded admin signs in, reaches /admin and signs out", async ({
    page,
  }) => {
    await signIn(page, E2E_ADMIN.email, E2E_ADMIN.password);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
    await expect(page.getByText(E2E_ADMIN.email)).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a customer gets a real 403 on /admin", async ({ page }) => {
    await signIn(page, E2E_CUSTOMER.email, E2E_CUSTOMER.password);
    await expect(page).toHaveURL(/\/$/);
    const response = await page.goto("/admin");
    expect(response?.status()).toBe(403);
    await expect(
      page.getByRole("heading", { name: "No access" }),
    ).toBeVisible();
    await expect(page.getByText("Admin", { exact: true })).toHaveCount(0);
  });

  test("a wrong password gets the generic message", async ({ page }) => {
    await signIn(page, E2E_ADMIN.email, "not-the-password-123");
    // Scoped to the form: Next's route announcer is also role="alert".
    await expect(page.locator("form").getByRole("alert")).toHaveText(
      "Email or password is incorrect.",
    );
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a forged session cookie passes the proxy but not requireAdmin()", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: "__Secure-yg.session_token",
        value: "forged.value",
        domain: "localhost",
        path: "/",
        secure: true,
      },
    ]);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("an admin API-style request without a session is never a 200", async ({
    request,
  }) => {
    const response = await request.get("/admin", { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toBe("/login");
  });
});

test.describe("geo-block (GEO_BLOCK_ENABLED=true on the test server)", () => {
  test("CN gets the 403 page", async ({ request }) => {
    const response = await request.get("/", {
      headers: { "x-vercel-ip-country": "CN" },
    });
    expect(response.status()).toBe(403);
    expect(await response.text()).toContain("not available in your region");
  });

  for (const country of ["HK", "MO", "TW"]) {
    test(`${country} is not blocked`, async ({ request }) => {
      const response = await request.get("/", {
        headers: { "x-vercel-ip-country": country },
      });
      expect(response.status()).toBe(200);
    });
  }
});
