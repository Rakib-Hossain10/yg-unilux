// QA tests for the task 11 design shell: colour contrast of the text tokens
// actually used on the ink footer and on paper, and that the error pages
// never print a server error message (only the digest).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import GlobalError from "@/app/global-error";
import SiteError from "@/app/(site)/error";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/* Colour tokens straight from globals.css, so the test follows the theme. */
const css = read("../../app/globals.css");
const token = (name: string): string => {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!match?.[1]) throw new Error(`token --color-${name} not found`);
  return match[1];
};

/* WCAG 2.x relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every `text-grey-NNN` class used in a source file. */
function greyTextTokens(source: string): string[] {
  return [
    ...new Set([...source.matchAll(/text-(grey-\d{2,3})/g)].map((m) => m[1]!)),
  ];
}

describe("contrast (WCAG 2.2 AA, 4.5:1 for small text)", () => {
  it("sanity: known ratio for ink on paper", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("every grey text colour in the footer is readable on ink", () => {
    const footer = read("./site-footer.tsx");
    const ink = token("ink");
    const failures = greyTextTokens(footer)
      .map((t) => ({ t, ratio: contrast(token(t), ink) }))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ t, ratio }) => `${t} on ink = ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });

  it("every grey text colour on paper pages is readable on white", () => {
    const paper = token("paper");
    const sources = [
      read("./site-header.tsx"),
      read("./status-page.tsx"),
      read("../../app/(site)/page.tsx"),
      read("../../app/(site)/error.tsx"),
      read("../../app/blocked/page.tsx"),
    ].join("\n");
    const failures = greyTextTokens(sources)
      .map((t) => ({ t, ratio: contrast(token(t), paper) }))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ t, ratio }) => `${t} on paper = ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });
});

describe("error pages never print server details", () => {
  const secret = "MongoServerError: auth failed for mongodb+srv://u:p@host";

  it("(site)/error shows a generic text and only the digest", () => {
    const error = Object.assign(new Error(secret), { digest: "4242424242" });
    const html = renderToStaticMarkup(SiteError({ error, retry: () => {} }));
    expect(html).toContain("Something went wrong");
    expect(html).toContain("4242424242");
    expect(html).not.toContain("MongoServerError");
    expect(html).not.toContain("mongodb+srv");
  });

  it("(site)/error renders no reference line without a digest", () => {
    const html = renderToStaticMarkup(
      SiteError({ error: new Error(secret), retry: () => {} }),
    );
    expect(html).not.toContain("Reference");
    expect(html).not.toContain("MongoServerError");
  });

  it("global-error has its own English document and no error text", () => {
    const error = Object.assign(new Error(secret), { digest: "1" });
    const html = renderToStaticMarkup(GlobalError({ error, retry: () => {} }));
    expect(html).toMatch(/^<html lang="en">/);
    expect(html).toContain("<h1");
    expect(html).not.toContain("MongoServerError");
    // Inline style attributes only (allowed by style-src 'unsafe-inline');
    // no <style> or <script> elements that a stricter CSP would block.
    expect(html).not.toMatch(/<script|<style/);
  });
});
