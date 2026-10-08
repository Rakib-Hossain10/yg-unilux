// P7 unit tests: the restricted block's pure rules (answer parsing, the
// no-store fetch, variant matching, rows) and the server render of the slots
// (visitor fallback only, four button states, no fetch during render).

import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatasheetButtonState as RouteState } from "@/lib/datasheet-state";

import { DatasheetButton } from "./datasheet-button";
import { ProductDetailClient } from "./product-detail-client";
import { RestrictedDataProvider } from "./restricted-block";
import {
  datasheetUrl,
  loadRestrictedAnswer,
  parseRestrictedAnswer,
  restrictedRows,
  restrictedSpecsFor,
  restrictedUrl,
  type DatasheetButtonState,
  type RestrictedAnswer,
} from "./restricted-data";
import { DatasheetSlot, RestrictedSpecsSlot } from "./restricted-slots";
import type { SwitchVariant } from "./variant-selection";

// The page's copy of the state union must equal the route's (compile time).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const statesMatch: Same<DatasheetButtonState, RouteState> = true;
void statesMatch;

const PRODUCT_ID = "0123456789abcdef01234567";

type Allowed = Extract<RestrictedAnswer, { allowed: true }>;

const ALLOWED: Allowed = {
  allowed: true,
  state: "download",
  keys: ["batchNo", "chipType", "driver"],
  specs: { chipType: ["Bridgelux"] },
  variants: [
    {
      modelNo: "AR-013A1",
      specs: { chipType: ["Bridgelux"], driver: ["Lifud"] },
    },
    {
      modelNo: "AR-013A2",
      specs: { chipType: ["Bridgelux"], driver: ["Philips"] },
    },
  ],
};

describe("parseRestrictedAnswer", () => {
  it("reads a refused answer with its state only", () => {
    expect(
      parseRestrictedAnswer({ allowed: false, state: "signin", keys: ["x"] }),
    ).toEqual({ allowed: false, state: "signin" });
  });

  it("reads an allowed answer and keeps only known keys and string values", () => {
    const answer = parseRestrictedAnswer({
      allowed: true,
      state: "download",
      keys: ["driver", "nope", 3, "driver"],
      specs: { driver: ["Lifud", 4, ""], evil: ["x"], cct: "3000K" },
      variants: [
        { modelNo: "A1", specs: { driver: ["Philips"] } },
        { modelNo: 7 },
        null,
      ],
    });
    expect(answer).toEqual({
      allowed: true,
      state: "download",
      keys: ["driver"],
      specs: { driver: ["Lifud"] },
      variants: [{ modelNo: "A1", specs: { driver: ["Philips"] } }],
    });
  });

  it("rejects unknown shapes and states", () => {
    for (const body of [
      null,
      "x",
      [],
      { message: "Product not found." },
      { allowed: false, state: "granted" },
      { allowed: "yes", state: "download" },
      { allowed: true, state: "download", keys: [] },
    ]) {
      expect(parseRestrictedAnswer(body)).toBeNull();
    }
  });
});

describe("loadRestrictedAnswer", () => {
  const ok = (body: unknown, status = 200) =>
    vi.fn<typeof fetch>(async () => Response.json(body, { status }));

  it("asks the route with no-store, same-origin cookies and the signal", async () => {
    const fetchImpl = ok({ allowed: false, state: "expired" });
    const controller = new AbortController();
    await expect(
      loadRestrictedAnswer(PRODUCT_ID, controller.signal, fetchImpl),
    ).resolves.toEqual({ allowed: false, state: "expired" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`/api/catalog/restricted/${PRODUCT_ID}`);
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
  });

  it("resolves null on a 400/404, a network error, bad JSON or an abort", async () => {
    const signal = new AbortController().signal;
    expect(
      await loadRestrictedAnswer(PRODUCT_ID, signal, ok({ message: "x" }, 404)),
    ).toBeNull();
    expect(
      await loadRestrictedAnswer(PRODUCT_ID, signal, ok({ message: "x" }, 400)),
    ).toBeNull();
    expect(
      await loadRestrictedAnswer(
        PRODUCT_ID,
        signal,
        vi.fn<typeof fetch>(async () => {
          throw new TypeError("offline");
        }),
      ),
    ).toBeNull();
    expect(
      await loadRestrictedAnswer(
        PRODUCT_ID,
        signal,
        vi.fn<typeof fetch>(async () => new Response("<html>")),
      ),
    ).toBeNull();
    const aborted = new AbortController();
    const slow = vi.fn<typeof fetch>(async () => {
      aborted.abort();
      return Response.json(ALLOWED);
    });
    expect(
      await loadRestrictedAnswer(PRODUCT_ID, aborted.signal, slow),
    ).toBeNull();
  });

  it("builds encoded URLs and never a storage URL", () => {
    expect(restrictedUrl("a/b")).toBe("/api/catalog/restricted/a%2Fb");
    expect(datasheetUrl(PRODUCT_ID)).toBe(`/api/datasheet/${PRODUCT_ID}`);
  });
});

describe("restrictedSpecsFor / restrictedRows", () => {
  it("follows the selected variant by index when the model no. matches", () => {
    expect(restrictedSpecsFor(ALLOWED, 1, "AR-013A2").driver).toEqual([
      "Philips",
    ]);
  });

  it("matches by model no. (case-insensitive) when the index disagrees", () => {
    expect(restrictedSpecsFor(ALLOWED, 0, "ar-013a2").driver).toEqual([
      "Philips",
    ]);
  });

  it("falls back to product values for an unknown model or no variants", () => {
    expect(restrictedSpecsFor(ALLOWED, 5, "ZZ-1")).toEqual(ALLOWED.specs);
    expect(
      restrictedSpecsFor({ ...ALLOWED, variants: [] }, 0, undefined),
    ).toEqual(ALLOWED.specs);
  });

  it("shows every restricted column any variant fills, in key order", () => {
    expect(restrictedRows(ALLOWED)).toEqual([
      { key: "chipType", label: "Chip type" },
      { key: "driver", label: "Driver" },
    ]);
    expect(restrictedRows({ ...ALLOWED, specs: {}, variants: [] })).toEqual([]);
  });
});

describe("DatasheetButton", () => {
  const html = (state: DatasheetButtonState) =>
    renderToStaticMarkup(
      createElement(DatasheetButton, { state, productId: PRODUCT_ID }),
    );

  it("download is a plain link to the datasheet route", () => {
    const out = html("download");
    expect(out).toContain(`href="/api/datasheet/${PRODUCT_ID}"`);
    expect(out).toContain("Download datasheet");
    expect(out).not.toMatch(/r2|cloudflarestorage|X-Amz|\.xlsx"/i);
  });

  it("expired links to contact, signin to /login, coming-soon has no link", () => {
    expect(html("expired")).toContain('href="/contact"');
    expect(html("expired")).toContain("Access expired — contact us");
    expect(html("signin")).toContain('href="/login"');
    expect(html("signin")).toContain("Sign in to download");
    expect(html("coming-soon")).toContain("Datasheet coming soon");
    expect(html("coming-soon")).not.toContain("<a");
  });
});

describe("restricted slots: server render", () => {
  afterEach(() => vi.unstubAllGlobals());

  const variants: SwitchVariant[] = [
    { modelNo: "AR-013A1", label: null, imagePublicId: null, specs: {} },
  ];
  // children as createElement arguments (lint), optional for the types.
  const Detail = ProductDetailClient as FunctionComponent<{
    variants: readonly SwitchVariant[];
    children?: ReactNode;
  }>;
  const Restricted = RestrictedDataProvider as FunctionComponent<{
    productId: string;
    children?: ReactNode;
  }>;
  const render = (children: ReactNode) =>
    renderToStaticMarkup(
      createElement(
        Detail,
        { variants },
        createElement(Restricted, { productId: PRODUCT_ID }, children),
      ),
    );

  it("renders only the visitor fallback and never fetches", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = render([
      createElement(DatasheetSlot, {
        key: "d",
        productId: PRODUCT_ID,
        hasDatasheet: true,
      }),
      createElement(RestrictedSpecsSlot, { key: "r" }),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toContain('data-slot="datasheet"');
    expect(out).toContain('data-slot="restricted-specs"');
    expect(out).toContain("Sign in to download");
    expect(out).toContain("Sign in to see them");
    expect(out).toContain("min-h-31");
    expect(out).not.toContain("/api/datasheet/");
    expect(out).not.toContain("/api/catalog/restricted");
  });

  it("shows coming soon when the product has no datasheet", () => {
    const out = render(
      createElement(DatasheetSlot, {
        productId: PRODUCT_ID,
        hasDatasheet: false,
      }),
    );
    expect(out).toContain("Datasheet coming soon");
    expect(out).not.toContain("Sign in to download");
  });
});
