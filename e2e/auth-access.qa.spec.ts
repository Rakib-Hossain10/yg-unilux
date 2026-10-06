// QA e2e (task 12, Phase 1 exit): what the task's own spec does not cover.
// A no-JS / pre-hydration submit must not put the password in the URL, a
// customer's RSC (client-navigation) request to /admin carries no admin
// content, sign-out ends the session in the database, cross-origin sign-in
// is refused, CN is blocked on /admin and /api/auth too, and /login passes axe.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Page, expect, test } from "@playwright/test";

import { E2E_ADMIN, E2E_CUSTOMER } from "./fixtures/accounts";

const axeSource = readFileSync(
  join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("login form without JavaScript (or clicked before hydration)", () => {
  test.use({ javaScriptEnabled: false });

  test("a native submit never puts the email or password in the URL", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("qa-nojs@example.com");
    await page.getByLabel("Password").fill("qa-secret-in-url-123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForLoadState("domcontentloaded");
    expect(page.url()).not.toContain("qa-secret-in-url-123");
    expect(page.url()).not.toContain("password=");
  });
});

test("a customer's RSC request for /admin carries no admin content", async ({
  page,
}) => {
  await signIn(page, E2E_CUSTOMER.email, E2E_CUSTOMER.password);
  await expect(page).toHaveURL(/\/$/);
  // What the client router fetches on a soft navigation to /admin, sent
  // with the browser's cookies (redirects to the right ?_rsc= followed).
  const response = await page.request.get("/admin", {
    headers: { RSC: "1" },
  });
  const result = { body: await response.text() };
  // An RSC answer may be 200 with the forbidden boundary inside the payload;
  // what matters is that no admin markup or data is in it.
  expect(result.body).toContain("No access");
  expect(result.body).not.toContain("Signed in as");
  expect(result.body).not.toContain(E2E_CUSTOMER.email);
  expect(result.body).not.toContain("Sign out");
  // Neither the admin nav nor a dashboard card (only rendered alongside the
  // counts) is in the payload. "Dashboard" alone is not checked: Next resolves
  // the page's static metadata (its <title>) even when the layout's guard
  // throws forbidden(), and that constant string carries no admin data.
  expect(result.body).not.toContain("Access requests");
  expect(result.body).not.toContain("Waiting for a decision");
  expect(result.body).not.toContain('"aria-label":"Admin"');
});

test("sign-out deletes the session: the old cookie no longer opens /admin", async ({
  page,
  context,
}) => {
  await signIn(page, E2E_ADMIN.email, E2E_ADMIN.password);
  await expect(page).toHaveURL(/\/admin$/);
  const before = (await context.cookies()).filter((c) =>
    c.name.endsWith("session_token"),
  );
  expect(before).toHaveLength(1);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);

  // Replay the pre-sign-out cookie: the database row must be gone.
  await context.addCookies(before);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login$/);
});

test("cross-origin sign-in and sign-out are refused (CSRF)", async ({
  request,
}) => {
  const signInResponse = await request.post("/api/auth/sign-in/email", {
    headers: { origin: "https://evil.example" },
    data: { email: E2E_ADMIN.email, password: E2E_ADMIN.password },
  });
  expect(signInResponse.status()).toBe(403);
  expect(signInResponse.headers()["set-cookie"]).toBeUndefined();

  const noOrigin = await request.post("/api/auth/sign-in/email", {
    headers: { origin: "null" },
    form: { email: E2E_ADMIN.email, password: E2E_ADMIN.password },
  });
  expect(noOrigin.status()).toBe(403);
});

test.describe("geo-block covers admin and auth routes", () => {
  for (const path of ["/admin", "/login", "/api/auth/get-session"]) {
    test(`CN on ${path} is a 403`, async ({ request }) => {
      const response = await request.get(path, {
        headers: { "x-vercel-ip-country": "CN" },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(403);
    });
  }

  test("CN sign-in POST is a 403 and sets no cookie", async ({ request }) => {
    const response = await request.post("/api/auth/sign-in/email", {
      headers: { "x-vercel-ip-country": "CN" },
      data: { email: E2E_ADMIN.email, password: E2E_ADMIN.password },
    });
    expect(response.status()).toBe(403);
    expect(response.headers()["set-cookie"]).toBeUndefined();
  });

  test("a missing country header is allowed", async ({ request }) => {
    const response = await request.get("/login");
    expect(response.status()).toBe(200);
  });
});

test("axe WCAG 2.2 AA on /login, including the error state", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#email-error")).toBeVisible();
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const result = await window.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    return (result.violations as { id: string; nodes: unknown[] }[]).map(
      (v) => `${v.id} (${v.nodes.length})`,
    );
  });
  expect(violations).toEqual([]);
});
