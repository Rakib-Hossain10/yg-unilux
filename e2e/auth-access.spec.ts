// Phase 1 exit checks: the seeded admin signs in and reaches /admin; a
// customer gets a real 403 there; a visitor is sent to /login; a forged
// cookie gets no further; CN is geo-blocked and HK/MO/TW are not. Also
// "Keep me signed in": off by default, a 7-day cookie only when checked.

import {
  type APIRequestContext,
  type Page,
  expect,
  test,
} from "@playwright/test";

import { E2E_ADMIN, E2E_CUSTOMER } from "./fixtures/accounts";
import { stubProviders } from "./fixtures/providers";

async function signIn(
  page: Page,
  email: string,
  password: string,
  keepSignedIn = false,
) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  if (keepSignedIn) await page.getByLabel("Keep me signed in").check();
  await page.getByRole("button", { name: "Sign in" }).click();
}

/*
 * True when the current document may connect to Cloudinary's Upload API.
 * The request goes to the in-memory fake (stubProviders); a CSP refusal
 * happens in the browser before any routing, so fetch rejects instead.
 */
async function uploadHostReachable(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      await fetch("https://api.cloudinary.com/v1_1/e2e/image/upload", {
        method: "POST",
        body: new FormData(),
      });
      return true;
    } catch {
      return false;
    }
  });
}

test.describe("content security policy per page", () => {
  /* Every Content-Security-Policy header of a response (all of them apply). */
  async function cspHeaders(
    request: APIRequestContext,
    path: string,
  ): Promise<string[]> {
    const response = await request.get(path, { maxRedirects: 0 });
    return response
      .headersArray()
      .filter(({ name }) => name.toLowerCase() === "content-security-policy")
      .map(({ value }) => value);
  }

  test("/admin has one CSP that allows the upload host; /login's does not", async ({
    request,
  }) => {
    const admin = await cspHeaders(request, "/admin/products/x");
    expect(admin).toHaveLength(1);
    expect(admin[0]).toMatch(
      /connect-src 'self' https:\/\/api\.cloudinary\.com/,
    );

    for (const path of ["/login", "/"]) {
      const page = await cspHeaders(request, path);
      expect(page).toHaveLength(1);
      expect(page[0]).toContain("connect-src 'self';");
      expect(page[0]).not.toContain("api.cloudinary.com");
    }
  });
});

test.describe("admin access", () => {
  test("a visitor is redirected from /admin to /login", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("the seeded admin signs in, reaches /admin and signs out", async ({
    page,
  }) => {
    await stubProviders(page);
    await signIn(page, E2E_ADMIN.email, E2E_ADMIN.password);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Dashboard" }),
    ).toBeVisible();
    await expect(page.getByText(E2E_ADMIN.email)).toBeVisible();
    // Positive twin of the customer test's "no Admin nav" check, so renaming
    // the landmark breaks this test instead of silently weakening that one.
    // .first(): the nav is rendered for the sidebar and the mobile menu.
    await expect(
      page.getByRole("navigation", { name: "Admin" }).first(),
    ).toBeVisible();

    // CSP is fixed per document: arriving from /login by a client-side
    // navigation would keep the login page's connect-src 'self', and the
    // images editor's direct upload to Cloudinary would be blocked. This
    // reaches the upload host from the page the sign-in landed on.
    await expect(uploadHostReachable(page)).resolves.toBe(true);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/$/);
    // And the other way: the home page is a new document with the public
    // CSP, not the admin document's wider connect-src.
    await expect(uploadHostReachable(page)).resolves.toBe(false);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a customer gets a real 403 on /admin", async ({ page }) => {
    await signIn(page, E2E_CUSTOMER.email, E2E_CUSTOMER.password);
    // Still on its temporary password: /login sends it to change it first
    // (Phase 5 plan Q7).
    await expect(page).toHaveURL(/\/change-password$/);
    const response = await page.goto("/admin");
    expect(response?.status()).toBe(403);
    await expect(
      page.getByRole("heading", { name: "No access" }),
    ).toBeVisible();
    // None of the admin shell or dashboard reached the customer.
    await expect(page.getByText("Admin", { exact: true })).toHaveCount(0);
    // includeHidden: the mobile copy of the nav is display:none on desktop.
    await expect(
      page.getByRole("heading", { name: "Dashboard", includeHidden: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Admin", includeHidden: true }),
    ).toHaveCount(0);
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

test.describe("keep me signed in (same for every role)", () => {
  test("unchecked by default: the session cookie ends with the browser", async ({
    page,
    context,
  }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Keep me signed in")).not.toBeChecked();
    await signIn(page, E2E_ADMIN.email, E2E_ADMIN.password);
    await expect(page).toHaveURL(/\/admin$/);
    const session = (await context.cookies()).find((c) =>
      c.name.endsWith("session_token"),
    );
    expect(session, "no session cookie was set").toBeDefined();
    // Playwright reports a browser-session cookie as expires -1.
    expect(session?.expires).toBe(-1);
  });

  test("checked: the session cookie lasts about 7 days", async ({
    page,
    context,
  }) => {
    await signIn(page, E2E_CUSTOMER.email, E2E_CUSTOMER.password, true);
    await expect(page).toHaveURL(/\/change-password$/);
    const session = (await context.cookies()).find((c) =>
      c.name.endsWith("session_token"),
    );
    expect(session, "no session cookie was set").toBeDefined();
    const days = ((session?.expires ?? 0) - Date.now() / 1000) / 86_400;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
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
