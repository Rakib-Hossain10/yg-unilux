import { expect, test } from "@playwright/test";

test("home page responds 200, shows the brand and logs no console errors", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    // Link prefetches of nav pages that aren't built yet (Phases 2-7) end
    // in 404s, which Chromium logs as resource errors. Script errors and
    // anything else still fail the test.
    if (message.type() !== "error") return;
    if (/^Failed to load resource: .*404/.test(message.text())) return;
    consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-powered-by"]).toBeUndefined();
  await expect(
    page.getByRole("heading", { level: 1, name: "YG UniLUX" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("YG UniLUX");
  expect(consoleErrors).toEqual([]);
});
