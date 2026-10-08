// Helpers shared by the product-page specs (P5-P9 and QA gate B): served
// pictures for next/image (the Cloudinary fake serves none), hydration,
// the restricted route's answer, axe and the no-horizontal-scroll check.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import {
  expect,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";

/** A solid-colour PNG, so images really load and have a natural size. */
export function solidPng(width: number, height: number, rgb: number[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => rgb).flat()),
  ]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const DEFAULT_PNG = solidPng(400, 300, [200, 196, 190]);

/* Answer every next/image request; `delayMs` holds them back (CLS test). */
export async function serveImages(page: Page, delayMs = 0): Promise<void> {
  await page.route("**/_next/image**", async (route) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: DEFAULT_PNG,
    });
  });
}

/** Hydration is done once React has attached its handlers to `target`. */
export async function waitForHydration(target: Locator): Promise<void> {
  await expect
    .poll(() =>
      target.evaluate((el) =>
        Object.keys(el).some((key) => key.startsWith("__reactProps")),
      ),
    )
    .toBe(true);
}

/**
 * Opens `path` and waits for the restricted route's answer (the block has
 * then settled). Returns the page response and the route's response.
 */
export async function gotoAndWaitForRestricted(
  page: Page,
  path: string,
): Promise<{ response: Response | null; route: Response }> {
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes("/api/catalog/restricted/") &&
      response.request().method() === "GET",
  );
  const response = await page.goto(path);
  const route = await answered;
  return { response, route };
}

const axeSource = readFileSync(
  join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

/** axe (WCAG 2.0-2.2 A/AA) violations of the page, one line each. */
export async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const result = await window.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    return (
      result.violations as {
        id: string;
        nodes: { target: string[] }[];
      }[]
    ).map(
      (v) =>
        `${v.id} (${v.nodes.length}): ${v.nodes
          .slice(0, 3)
          .map((node) => node.target.join(" "))
          .join(" | ")}`,
    );
  });
}

/** Pixels the page scrolls horizontally (0 = none). */
export function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}
