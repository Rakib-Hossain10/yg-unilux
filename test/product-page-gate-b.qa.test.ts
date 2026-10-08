// QA gate B (Phase 4a, P4-P7), unit level. Complements the e2e leak test
// (e2e/product-page-gate-b.qa.spec.ts) with what a browser cannot see:
//
// 1. The page render through the REAL Next 16 `unstable_cache` / `updateTag`
//    (test/helpers/next-cache-harness.ts, nothing in next/cache mocked) with
//    every one of the 28 columns filled: a visibility save through the real
//    service + revalidation helper changes the very next render, both ways,
//    in the HTML, the metadata, the JSON-LD and the sitemap.
// 2. The server element tree of the page, expanded through every Server
//    Component: no restricted value is anywhere in it, rendered or not (that
//    tree is what the RSC payload is serialised from), and only the product
//    id crosses into the restricted block.
// 3. A stored name that tries to close the JSON-LD script stays inside it.
// 4. The restricted route's remaining viewer matrix (admin edge cases).

import "./helpers/next-als";

import { Types } from "mongoose";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import ProductPage, {
  generateMetadata,
} from "@/app/(site)/product/[slug]/page";
import sitemap from "@/app/sitemap";
import { ProductDetailClient } from "@/components/site/product/product-detail-client";
import { RestrictedDataProvider } from "@/components/site/product/restricted-block";
import { saveColumnVisibility } from "@/lib/admin/settings";
import { revalidateCatalogInAction } from "@/lib/revalidate";
import {
  DEFAULT_COLUMN_VISIBILITY,
  SETTINGS_KEYS,
} from "@/lib/schemas/settings";
import { CategoryModel, ProductModel, SiteContentModel } from "@/models";
import {
  DEFAULT_RESTRICTED_SPEC_KEYS,
  SPEC_KEYS,
  type SpecKey,
  type SpecValues,
} from "@/models/spec-columns";

import { setupMemoryDb } from "./helpers/memory-db";
import { createNextCacheHarness, nextTick } from "./helpers/next-cache-harness";
import { testPublicId } from "./helpers/public-ids";

const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: getSession,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

import { GET as restrictedRoute } from "@/app/api/catalog/restricted/[productId]/route";

setupMemoryDb("yg_product_page_gate_b");

const harness = createNextCacheHarness();
const ACTOR = new Types.ObjectId().toHexString();

// Every value is a unique token, so a leak is a plain substring match.
const tok = (key: SpecKey, where: string) => `GBQ~${key}~${where}~`;
const specsAt = (where: string): SpecValues =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, [tok(key, where)]]));
/** Tokens of `keys` (any location) found in `text`. */
const leaked = (text: string, keys: readonly SpecKey[]): string[] =>
  keys.filter((key) => text.includes(`GBQ~${key}~`));

const ids = {
  category: new Types.ObjectId(),
  hero: new Types.ObjectId(),
  sibling: new Types.ObjectId(),
  related: new Types.ObjectId(),
  xss: new Types.ObjectId(),
};
const HERO = "gbq-hero-001";
const XSS = "gbq-xss-001";
const LABEL_1 = "GBQLABEL1";

beforeAll(async () => {
  await CategoryModel.create([
    { _id: ids.category, name: "Spots", slug: "spots", parent: null },
  ]);
  const base = {
    mainCategory: ids.category,
    status: "published" as const,
    images: [{ publicId: testPublicId(3), order: 0, kind: "gallery" as const }],
  };
  await ProductModel.create([
    {
      ...base,
      _id: ids.hero,
      name: "Hero",
      slug: HERO,
      family: "Gbqfam",
      modelCode: "GBQ-001",
      specs: specsAt("P"),
      datasheetId: new Types.ObjectId(),
      variants: [
        { modelNo: "GBQ-001A", label: LABEL_1, specs: specsAt("V1") },
        { modelNo: "GBQ-001B", label: "GBQLABEL2", specs: specsAt("V2") },
      ],
    },
    {
      ...base,
      _id: ids.sibling,
      name: "Sibling",
      slug: "gbq-sibling-001",
      family: "Gbqfam",
      specs: specsAt("SIB"),
      variants: [{ modelNo: "GBQ-002A", specs: {} }],
    },
    {
      ...base,
      _id: ids.related,
      name: "Related",
      slug: "gbq-related-001",
      family: "Otherfam",
      specs: specsAt("REL"),
      variants: [{ modelNo: "GBQ-003A", specs: {} }],
    },
    {
      ...base,
      _id: ids.xss,
      // Stored text that tries to end the JSON-LD script and open markup.
      name: 'X</script><img src=x onerror="alert(1)"><!--',
      slug: XSS,
      description: "</SCRIPT ><script>alert(2)</script>",
      specs: {},
      variants: [{ modelNo: "GBQ-XSS", specs: {} }],
    },
  ]);
});

beforeEach(async () => {
  harness.reset();
  getSession.mockReset();
  vi.stubEnv("SITE_URL", "https://www.example.com");
  vi.stubEnv("CLOUDINARY_URL", "cloudinary://123456:secretvalue@demo-cloud");
  await SiteContentModel.deleteOne({ key: SETTINGS_KEYS.columnVisibility });
});

const props = (slug: string) => ({
  params: Promise.resolve({ slug }),
  searchParams: Promise.resolve({}),
});

/** One visitor render as a request would make it: HTML + metadata + sitemap. */
async function visitorRender(slug = HERO): Promise<{
  html: string;
  meta: string;
  sitemap: string;
}> {
  return harness.inRequest(async () => ({
    html: renderToStaticMarkup(await ProductPage(props(slug))),
    meta: JSON.stringify(await generateMetadata(props(slug))),
    sitemap: JSON.stringify(await sitemap()),
  }));
}

/** The admin's save, exactly as the settings action runs it. */
async function saveVisibility(
  changes: Partial<Record<SpecKey, "public" | "restricted">>,
): Promise<void> {
  await nextTick();
  const result = await saveColumnVisibility(ACTOR, {
    ...DEFAULT_COLUMN_VISIBILITY,
    ...changes,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  await harness.inServerAction(() => revalidateCatalogInAction(result.tags));
  await nextTick();
}

const PUBLIC_DEFAULT = SPEC_KEYS.filter(
  (key) => !DEFAULT_RESTRICTED_SPEC_KEYS.includes(key),
);

describe("gate B: the page through the real Next cache follows visibility saves", () => {
  it("default: every public column is shown, no restricted one anywhere", async () => {
    const { html, meta, sitemap: map } = await visitorRender();
    expect(leaked(html, DEFAULT_RESTRICTED_SPEC_KEYS)).toEqual([]);
    expect(leaked(meta, DEFAULT_RESTRICTED_SPEC_KEYS)).toEqual([]);
    expect(leaked(map, SPEC_KEYS)).toEqual([]);
    // The public table shows variant 1's public values (sanity of the grep).
    expect(leaked(html, ["cct", "wattage", "lens"])).toEqual([
      "cct",
      "wattage",
      "lens",
    ]);
    expect(html).toContain(LABEL_1);
  });

  it("restricting a column removes it from the very next render (no stale render)", async () => {
    await visitorRender(); // warm every entry
    await visitorRender(); // served from the cache
    await saveVisibility({ cct: "restricted", lens: "restricted" });
    const { html, meta } = await visitorRender();
    expect(
      leaked(html, ["cct", "lens", ...DEFAULT_RESTRICTED_SPEC_KEYS]),
    ).toEqual([]);
    expect(leaked(meta, ["cct", "lens"])).toEqual([]);
    // The label may hold optic values (ADR 0063 decision 9).
    expect(html).not.toContain(LABEL_1);
    expect(html).toContain("GBQ-001A");
  });

  it("making a column public shows it on the next render, and back hides it again", async () => {
    await visitorRender();
    await saveVisibility({ driver: "public" });
    expect((await visitorRender()).html).toContain(tok("driver", "V1"));
    await saveVisibility({});
    const { html } = await visitorRender();
    expect(leaked(html, DEFAULT_RESTRICTED_SPEC_KEYS)).toEqual([]);
  });

  it("every column public: the strips still carry no spec value of the cards", async () => {
    await saveVisibility(
      Object.fromEntries(SPEC_KEYS.map((key) => [key, "public"])),
    );
    const { html } = await visitorRender();
    for (const section of ["family", "related"]) {
      const start = html.indexOf(`data-section="${section}"`);
      expect(start, section).toBeGreaterThan(0);
      const strip = html.slice(start, html.indexOf("</section>", start));
      expect(strip).toContain("/product/gbq-");
      for (const where of ["SIB", "REL"]) {
        expect(strip.includes(`~${where}~`), `${section} ${where}`).toBe(false);
      }
    }
    // Card values never reach the hero page at all.
    expect(html.includes("~SIB~") || html.includes("~REL~")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The server element tree (what the RSC payload is serialised from)
// ---------------------------------------------------------------------------

interface Walk {
  /** Every string found in any prop, at any depth. */
  strings: string[];
  /** Every element whose type is a function, with its props. */
  elements: { type: unknown; props: Record<string, unknown> }[];
}

/*
 * Expands the page through every component that can be called outside a
 * render (Server Components; also hook-free client leaves, harmless). A
 * component that needs React's dispatcher (hooks, use()) throws and is kept
 * as a leaf: those are the client boundaries, and their props are checked.
 */
async function walk(node: unknown, out: Walk, depth = 0): Promise<void> {
  if (depth > 200 || node === null || node === undefined) return;
  if (typeof node === "string") {
    out.strings.push(node);
    return;
  }
  if (typeof node !== "object") return;
  if (node instanceof Promise) {
    await walk(await node, out, depth + 1);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) await walk(child, out, depth + 1);
    return;
  }
  if (isValidElement(node)) {
    const element = node as ReactElement<Record<string, unknown>>;
    if (typeof element.type === "function") {
      out.elements.push({ type: element.type, props: element.props });
      let rendered: ReactNode | Promise<ReactNode> | undefined;
      try {
        rendered = (element.type as (p: unknown) => ReactNode)(element.props);
      } catch {
        rendered = undefined; // a client component: its props are walked below
      }
      if (rendered !== undefined) await walk(rendered, out, depth + 1);
    }
    for (const value of Object.values(element.props)) {
      await walk(value, out, depth + 1);
    }
    return;
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    await walk(value, out, depth + 1);
  }
}

async function pageTree(slug: string): Promise<Walk> {
  const out: Walk = { strings: [], elements: [] };
  await harness.inRequest(async () =>
    walk(await ProductPage(props(slug)), out),
  );
  return out;
}

describe("gate B: the server element tree holds no restricted value", () => {
  it("no restricted token in any prop of any component, at any depth", async () => {
    const tree = await pageTree(HERO);
    const all = tree.strings.join("\n");
    expect(leaked(all, DEFAULT_RESTRICTED_SPEC_KEYS)).toEqual([]);
    expect(all.includes("~SIB~") || all.includes("~REL~")).toBe(false);
    // The walk really saw the data (public values, both variants).
    expect(all).toContain(tok("cct", "V1"));
    expect(all).toContain(tok("cct", "V2"));
    // No datasheet id anywhere in the tree.
    const hero = await ProductModel.findById(ids.hero).lean();
    expect(all).not.toContain(String(hero?.datasheetId));
  });

  it("only the product id crosses into the restricted block; variants are public fields only", async () => {
    const tree = await pageTree(HERO);
    const providers = tree.elements.filter(
      (element) => element.type === RestrictedDataProvider,
    );
    expect(providers).toHaveLength(1);
    expect(Object.keys(providers[0]!.props).sort()).toEqual([
      "children",
      "productId",
    ]);
    expect(providers[0]!.props.productId).toBe(ids.hero.toHexString());

    const detail = tree.elements.find(
      (element) => element.type === ProductDetailClient,
    );
    const variants = detail?.props.variants as Record<string, unknown>[];
    expect(variants).toHaveLength(2);
    for (const variant of variants) {
      expect(Object.keys(variant).sort()).toEqual([
        "imagePublicId",
        "label",
        "modelNo",
        "specs",
      ]);
      const keys = Object.keys(variant.specs as object) as SpecKey[];
      expect(keys.filter((key) => !PUBLIC_DEFAULT.includes(key))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// JSON-LD cannot be broken out of
// ---------------------------------------------------------------------------

describe("gate B: JSON-LD with hostile stored text", () => {
  it("a name with </script> stays inside the script and parses back exactly", async () => {
    const { html } = await visitorRender(XSS);
    const open = '<script type="application/ld+json">';
    const start = html.indexOf(open) + open.length;
    const end = html.indexOf("</script>", start);
    const body = html.slice(start, end);
    const ld = JSON.parse(body) as { name: string; description: string };
    expect(ld.name).toContain("X</script><img");
    expect(ld.description).toBe("</SCRIPT ><script>alert(2)</script>");
    expect(body).not.toMatch(/<\/?script/i);
    // Outside the script, the name is escaped text, never markup.
    expect(html).not.toMatch(/<img src=x onerror/);
    expect(html).not.toContain("<script>alert(2)");
  });
});

// ---------------------------------------------------------------------------
// The restricted route: admin edge cases
// ---------------------------------------------------------------------------

function signedInAs(user: Record<string, unknown> | null): void {
  getSession.mockResolvedValue(
    user === null
      ? null
      : {
          session: { id: "s1" },
          user: {
            id: "u1",
            role: "customer",
            banned: false,
            banExpires: null,
            mustChangePassword: false,
            accessExpiresAt: null,
            ...user,
          },
        },
  );
}

async function callRoute(id = ids.hero.toHexString()) {
  const response = await restrictedRoute(
    new Request(`http://localhost/api/catalog/restricted/${id}`),
    { params: Promise.resolve({ productId: id }) },
  );
  return {
    status: response.status,
    cache: response.headers.get("cache-control"),
    text: await response.text(),
  };
}

describe("gate B: restricted route matrix (admin and edge cases)", () => {
  const PAST = new Date(Date.now() - 86_400_000);
  const FUTURE = new Date(Date.now() + 86_400_000);

  it.each<[string, Record<string, unknown>, boolean, string]>([
    ["admin", { role: "admin" }, true, "download"],
    [
      "admin with a past accessExpiresAt",
      { role: "admin", accessExpiresAt: PAST },
      true,
      "download",
    ],
    [
      "admin on a temporary password",
      { role: "admin", mustChangePassword: true },
      false,
      "signin",
    ],
    ["banned admin", { role: "admin", banned: true }, false, "expired"],
    [
      "customer, ban expired",
      { banned: true, banExpires: PAST },
      true,
      "download",
    ],
    [
      "customer, ban until tomorrow",
      { banned: true, banExpires: FUTURE },
      false,
      "expired",
    ],
    [
      "customer, access until tomorrow",
      { accessExpiresAt: FUTURE },
      true,
      "download",
    ],
    ["customer, access ended", { accessExpiresAt: PAST }, false, "expired"],
    ["unknown role", { role: "staff" }, false, "signin"],
    ["role list with admin", { role: "customer,admin" }, true, "download"],
  ])("%s", async (_name, user, allowed, state) => {
    signedInAs(user);
    const answer = await callRoute();
    expect(answer.status).toBe(200);
    expect(answer.cache).toBe("private, no-store");
    const body = JSON.parse(answer.text) as Record<string, unknown>;
    expect(body.allowed).toBe(allowed);
    expect(body.state).toBe(state);
    if (!allowed) {
      expect(Object.keys(body).sort()).toEqual(["allowed", "state"]);
      expect(leaked(answer.text, SPEC_KEYS)).toEqual([]);
    } else {
      expect(leaked(answer.text, DEFAULT_RESTRICTED_SPEC_KEYS).sort()).toEqual(
        [...DEFAULT_RESTRICTED_SPEC_KEYS].sort(),
      );
      // Only restricted columns, never a public one or a datasheet id.
      expect(leaked(answer.text, PUBLIC_DEFAULT)).toEqual([]);
      expect(answer.text).not.toMatch(/datasheet|storage|https?:/i);
    }
  });

  it("the answer follows a visibility save on the next call (never cached)", async () => {
    signedInAs({});
    expect((await callRoute()).text).not.toContain(tok("cct", "V1"));
    await saveVisibility({ cct: "restricted" });
    expect((await callRoute()).text).toContain(tok("cct", "V1"));
  });
});
