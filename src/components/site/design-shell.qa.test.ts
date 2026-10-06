// QA tests for the design shell: colour contrast of the text tokens used on
// the ink footer and on paper, the admin (shadcn) colour pairs and focus ring
// (ADR 0028, 0034), and that error pages never print a server error message.

import { readdirSync, readFileSync } from "node:fs";
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

/* The shadcn variables (:root in globals.css) resolved to hex through the
   tokens they point at, so the test follows the theme (ADR 0034). */
const shadcn = (name: string): string => {
  const match = new RegExp(`--${name}:\\s*var\\(--color-([a-z0-9-]+)\\)`).exec(
    css,
  );
  if (!match?.[1]) throw new Error(`shadcn variable --${name} not found`);
  return token(match[1]);
};

/** Colour of `fg` painted at `alpha` over `bg` (how `ring-ring/50` renders). */
function blend(fg: string, bg: string, alpha: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(channel(fg, i) * alpha + channel(bg, i) * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

describe("admin (shadcn) colour pairs", () => {
  const pairs: [string, string, string, number][] = [
    [
      "primary button text",
      shadcn("primary-foreground"),
      shadcn("primary"),
      4.5,
    ],
    ["body text", shadcn("foreground"), shadcn("background"), 4.5],
    [
      "muted text on background",
      shadcn("muted-foreground"),
      shadcn("background"),
      4.5,
    ],
    ["muted text on muted", shadcn("muted-foreground"), shadcn("muted"), 4.5],
    ["muted text on card", shadcn("muted-foreground"), shadcn("card"), 4.5],
    [
      "secondary button text",
      shadcn("secondary-foreground"),
      shadcn("secondary"),
      4.5,
    ],
    [
      "accent text on accent",
      shadcn("accent-foreground"),
      shadcn("accent"),
      4.5,
    ],
    [
      "destructive text on background",
      shadcn("destructive"),
      shadcn("background"),
      4.5,
    ],
    ["destructive text on muted", shadcn("destructive"), shadcn("muted"), 4.5],
    // The destructive button and badge tint their background with the red.
    [
      "destructive button text (bg destructive/10)",
      shadcn("destructive"),
      blend(shadcn("destructive"), shadcn("background"), 0.1),
      4.5,
    ],
    [
      "destructive button text on hover (bg destructive/20)",
      shadcn("destructive"),
      blend(shadcn("destructive"), shadcn("background"), 0.2),
      4.5,
    ],
    [
      "primary button text on hover (bg primary/80)",
      shadcn("primary-foreground"),
      blend(shadcn("primary"), shadcn("background"), 0.8),
      4.5,
    ],
    // Non-text (WCAG 1.4.11) needs 3:1.
    ["field border on background", shadcn("input"), shadcn("background"), 3],
    ["focus border on background", shadcn("ring"), shadcn("background"), 3],
    [
      "focus ring (ring/50) on background",
      blend(shadcn("ring"), shadcn("background"), 0.5),
      shadcn("background"),
      3,
    ],
    [
      "focus ring (ring/50) on muted",
      blend(shadcn("ring"), shadcn("muted"), 0.5),
      shadcn("muted"),
      3,
    ],
  ];

  it.each(pairs)("%s is readable", (_name, fg, bg, min) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
  });

  it("has no dark theme and pulls in no animation package", () => {
    // A `.dark {` rule, a dark variant, or the tw-animate-css import.
    expect(css).not.toMatch(/\.dark\s*\{|@custom-variant\s+dark|tw-animate/);
  });

  /* The admin UI has no decorative motion and no dark theme (ADR 0034).
     Colour fades (transition-colors) stay: they are hover/focus feedback and
     collapse to instant under prefers-reduced-motion. */
  it("ui components carry no animation or dark-mode classes", () => {
    const dir = fileURLToPath(new URL("../ui/", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
    expect(files.length).toBeGreaterThanOrEqual(16);
    const banned =
      /\b(animate-|fade-(in|out)|zoom-(in|out)|slide-(in|out)|dark:|backdrop-blur|transition-(all|transform|opacity))/;
    const failures = files.filter((f) =>
      banned.test(readFileSync(`${dir}${f}`, "utf8")),
    );
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
