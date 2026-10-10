// QA gate A (Phase 5, P1-P5) against the production build: the real
// Cache-Control and Referrer-Policy headers Next sends for the account pages
// (which unit tests can't see), the guards' redirects, a `//host` path on
// our own origin never leaving it (safeNextPath L-2 follow-up), HEAD on the
// datasheet route refused with 405 (L-1 fixed: it used to be Next's
// auto-HEAD, which runs GET), and the cron route refusing unauthenticated
// callers over HTTP.

import {
  type APIRequestContext,
  type APIResponse,
  expect,
  request as playwrightRequest,
  test,
} from "@playwright/test";

import { loadState } from "./fixtures/auth-state";

const BASE_URL = "http://localhost:3000";

let visitor: APIRequestContext;
let admin: APIRequestContext;
let customer: APIRequestContext;

test.beforeAll(async () => {
  visitor = await playwrightRequest.newContext({ baseURL: BASE_URL });
  admin = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    storageState: loadState("admin"),
  });
  // E2E_CUSTOMER is still on its temporary password.
  customer = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    storageState: loadState("customer"),
  });
});

test.afterAll(async () => {
  await Promise.all([visitor, admin, customer].map((c) => c.dispose()));
});

const get = (context: APIRequestContext, path: string) =>
  context.get(path, { maxRedirects: 0 });

function expectNoStore(response: APIResponse, label: string): void {
  const value = response.headers()["cache-control"] ?? "";
  expect(value, `${label}: ${value}`).toContain("no-store");
  expect(value, label).not.toMatch(/s-maxage|public/);
}

test.describe("account pages: never stored by a browser or CDN", () => {
  test("visitor: /login, /reset-password (token) and the guarded pages", async () => {
    const login = await get(visitor, "/login");
    expect(login.status()).toBe(200);
    expectNoStore(login, "/login");

    const reset = await get(
      visitor,
      "/reset-password?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&invite=1",
    );
    expect(reset.status()).toBe(200);
    expectNoStore(reset, "/reset-password");
    // The page-wide header stays strict cross-origin; the meta adds
    // no-referrer for this page (checked in account-pages.spec.ts).
    expect(reset.headers()["referrer-policy"]).toBe(
      "strict-origin-when-cross-origin",
    );
    const html = await reset.text();
    expect(html).toContain('name="referrer" content="no-referrer"');

    for (const [path, next] of [
      ["/my-downloads", "/login?next=%2Fmy-downloads"],
      ["/change-password", "/login"],
    ] as const) {
      const response = await get(visitor, path);
      expect([303, 307], path).toContain(response.status());
      expect(response.headers()["location"], path).toBe(next);
      expectNoStore(response, path);
    }
  });

  test("/forgot-password is static and per-visitor-free", async () => {
    const response = await get(visitor, "/forgot-password");
    expect(response.status()).toBe(200);
    const html = await response.text();
    // Static is fine only because nothing personal is in it.
    expect(html).not.toMatch(/@example\.com|Signed in as/);
  });

  test("signed in: /my-downloads (admin) and /change-password (temp customer)", async () => {
    const downloads = await get(admin, "/my-downloads");
    expect(downloads.status()).toBe(200);
    expectNoStore(downloads, "/my-downloads");
    expect(downloads.headers()["cache-control"]).toContain("private");

    const change = await get(customer, "/change-password");
    expect(change.status()).toBe(200);
    expectNoStore(change, "/change-password");

    // A temporary password is sent to change it, never to the history.
    const forced = await get(customer, "/my-downloads");
    expect([303, 307]).toContain(forced.status());
    expect(forced.headers()["location"]).toBe(
      "/change-password?next=%2Fmy-downloads",
    );
  });

  test("a signed-in visit to /login is sent on, never to a foreign next", async () => {
    for (const next of [
      "https://evil.example/",
      "//evil.example",
      "/%2F%2Fevil.example",
      "/..//evil.example",
    ]) {
      const response = await get(
        customer,
        `/login?${new URLSearchParams({ next })}`,
      );
      expect([303, 307], next).toContain(response.status());
      const location = response.headers()["location"] ?? "";
      expect(new URL(location, BASE_URL).host, next).toBe("localhost:3000");
    }
  });
});

test.describe("a // path on our origin never leaves it", () => {
  for (const path of [
    "//evil.example",
    "//evil.example/",
    "/..//evil.example",
  ]) {
    test(`GET ${path} stays on localhost`, async () => {
      // String join, not new URL(path, base): "//host" would be read as a
      // scheme-relative URL and leave our origin before the first request.
      let url = `${BASE_URL}${path}`;
      expect(new URL(url).host).toBe("localhost:3000");
      let final: Awaited<ReturnType<typeof visitor.get>> | null = null;
      // Follow up to 5 redirects by hand and check every hop's host.
      for (let hop = 0; hop < 5; hop += 1) {
        const response = await visitor.get(url, { maxRedirects: 0 });
        const location = response.headers()["location"];
        if (!location || response.status() < 300 || response.status() >= 400) {
          final = response;
          break;
        }
        url = new URL(location, url).href;
        expect(new URL(url).host, `hop ${hop}: ${location}`).toBe(
          "localhost:3000",
        );
      }
      // The chain ended on our own origin with a real answer (no endless
      // redirects, never a hop elsewhere).
      expect(final, "redirect chain did not settle").not.toBeNull();
      expect(new URL(url).host).toBe("localhost:3000");
      expect(final?.status() ?? 0).toBeLessThan(500);
    });
  }
});

test.describe("datasheet and cron routes over HTTP", () => {
  test("HEAD on the datasheet route is 405 (Allow: GET), no-store, never runs GET", async () => {
    const id = "0123456789abcdef01234567";
    const head = await visitor.head(`/api/datasheet/${id}`, {
      maxRedirects: 0,
    });
    expect(head.status()).toBe(405);
    expect(head.headers()["allow"]).toBe("GET");
    expect(head.headers()["cache-control"]).toBe("private, no-store");
  });

  test("the cron route refuses unauthenticated calls, no-store, no detail", async () => {
    for (const headers of <Record<string, string>[]>[
      {},
      { authorization: "Bearer wrong-secret-wrong-secret-wrong-secret" },
    ]) {
      const response = await visitor.get("/api/cron/access-expiry", {
        headers,
        maxRedirects: 0,
      });
      expect(response.status()).toBe(401);
      expect(response.headers()["cache-control"]).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });
});
