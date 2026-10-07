// Tests for src/lib/slug.ts: slugify turns admin-typed names (with accents,
// CJK, punctuation) into URL slugs that pass the models' slug rule, and
// uniqueSlug finds the first free "-2", "-3" ... suffix within a bounded budget.

import { describe, expect, it, vi } from "vitest";

import {
  MAX_SLUG_LENGTH,
  SLUG_PATTERN,
  slugify,
  uniqueSlug,
  UniqueSlugError,
} from "./slug";

describe("slugify", () => {
  it.each([
    ["Arc AR-013A", "arc-ar-013a"],
    ["  Spot   Lights  ", "spot-lights"],
    ["Recessed / Trimless", "recessed-trimless"],
    ["--Already--slugged--", "already-slugged"],
    ["Crème Brûlée Façade", "creme-brulee-facade"],
    ["Straße Øresund Æble Łódź", "strasse-oresund-aeble-lodz"],
    ["Lifud 莱福德", "lifud"],
    ["射灯 Spot", "spot"],
    ["Men's Room", "mens-room"],
    ["Hotel’s Lobby", "hotels-lobby"],
    ["MAGNETIC_TRACK 20mm", "magnetic-track-20mm"],
    ["Ｆｕｌｌｗｉｄｔｈ １２３", "fullwidth-123"],
    ["Œuvre Đakovo Þór ðe ı", "oeuvre-dakovo-thor-de-i"],
    ["A—B–C", "a-b-c"],
    ["x\ny\tz", "x-y-z"],
    ["100% LED!", "100-led"],
    ["ǅemal", "dzemal"],
    ["Ⅻ", "xii"],
  ])("%j -> %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("returns an empty string when nothing ASCII is left", () => {
    expect(slugify("莱福德")).toBe("");
    expect(slugify("  --  ")).toBe("");
    expect(slugify("")).toBe("");
  });

  it("caps the length at a word boundary and never ends on a hyphen", () => {
    const long = Array.from({ length: 40 }, () => "lighting").join(" ");
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug).toMatch(SLUG_PATTERN);
    expect(slug.endsWith("lighting")).toBe(true);
  });

  it("hard-cuts a single word longer than the cap", () => {
    const slug = slugify("a".repeat(500));
    expect(slug).toBe("a".repeat(MAX_SLUG_LENGTH));
  });

  it("accepts a custom cap", () => {
    expect(slugify("spot lights recessed", 10)).toBe("spot");
  });

  it("cuts exactly at a hyphen when the cap falls on a word boundary", () => {
    expect(slugify("spot lights", 4)).toBe("spot");
  });

  it("produces slugs the models accept", () => {
    const inputs = ["Arc AR-013A", "Crème Brûlée", "Lifud 莱福德", "--x--"];
    for (const input of inputs) {
      expect(slugify(input)).toMatch(SLUG_PATTERN);
    }
  });
});

describe("uniqueSlug", () => {
  /* An `exists` check backed by a fixed set of taken slugs. */
  const takenBy =
    (...taken: string[]) =>
    async (slug: string) =>
      taken.includes(slug);

  it("returns the slugified base when it is free", async () => {
    await expect(uniqueSlug("Arc AR-013A", takenBy())).resolves.toBe(
      "arc-ar-013a",
    );
  });

  it("appends -2, -3 ... until a free slug is found", async () => {
    const exists = vi.fn(takenBy("arc", "arc-2", "arc-3"));
    await expect(uniqueSlug("Arc", exists)).resolves.toBe("arc-4");
    expect(exists.mock.calls.map(([slug]) => slug)).toEqual([
      "arc",
      "arc-2",
      "arc-3",
      "arc-4",
    ]);
  });

  it("keeps a suffixed slug within the length cap", async () => {
    const base = "b".repeat(MAX_SLUG_LENGTH);
    const slug = await uniqueSlug(base, takenBy(base));
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug).toMatch(SLUG_PATTERN);
    expect(slug.endsWith("-2")).toBe(true);
  });

  it("shortens a multi-word root at a word boundary for a two-digit suffix", async () => {
    const root = slugify(
      Array.from({ length: 20 }, () => "lighting").join(" "),
    );
    const taken = [
      root,
      ...Array.from({ length: 8 }, (_, i) => `${root}-${i + 2}`),
    ];
    const slug = await uniqueSlug(root, takenBy(...taken));
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug).toMatch(SLUG_PATTERN);
    expect(slug.endsWith("-lighting-10")).toBe(true);
  });

  it("gives up after the attempt budget", async () => {
    const exists = vi.fn(async () => true);
    await expect(uniqueSlug("arc", exists, 5)).rejects.toBeInstanceOf(
      UniqueSlugError,
    );
    expect(exists).toHaveBeenCalledTimes(5);
  });

  it("rejects a base with nothing usable in it, without querying", async () => {
    const exists = vi.fn(async () => false);
    await expect(uniqueSlug("莱福德", exists)).rejects.toBeInstanceOf(
      UniqueSlugError,
    );
    expect(exists).not.toHaveBeenCalled();
  });

  it("passes on an error from the exists check", async () => {
    const exists = async () => {
      throw new Error("db down");
    };
    await expect(uniqueSlug("arc", exists)).rejects.toThrow("db down");
  });
});
