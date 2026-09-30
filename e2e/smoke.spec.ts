import { expect, test } from "@playwright/test";

test("home page responds 200, shows the brand and logs no console errors", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
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
