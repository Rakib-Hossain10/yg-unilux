// Tests for the listing URL params (ADR 0065): canonical parsing, dropping of
// junk / restricted / disallowed params, the serialiser, and a seeded
// property test (any junk → bounded canonical output; parse∘serialise = id).

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LISTING_PARAMS,
  facetValueLabel,
  listingFilterKey,
  MAX_FACET_SELECTIONS,
  MAX_LISTING_PAGE,
  NUMERIC_FACET_BOUNDS,
  NUMERIC_FACET_PARAMS,
  parseListingParams,
  publicSpecFacets,
  serialiseListingParams,
  SPEC_FACET_PARAMS,
  WATTAGE_BUCKETS,
  type ListingParamOptions,
  type ListingParams,
} from "./listing-params";

const ALL: ListingParamOptions = {
  publicFacets: SPEC_FACET_PARAMS,
  track: true,
  cat: true,
};

const parse = (query: string, options: ListingParamOptions = ALL) =>
  parseListingParams(new URLSearchParams(query), options);

describe("parseListingParams", () => {
  it("returns the defaults for an empty query", () => {
    expect(parse("")).toEqual(DEFAULT_LISTING_PARAMS);
  });

  it("dedupes and sorts lists, from commas and repeated keys alike", () => {
    const params = parse(
      "cct=4000,3000&cct=3000&ip=65,20&w=41%2B,0-10,0-10&beam=36,24.5&track=20,5&cat=retail-b,office-a",
    );
    expect(params).toMatchObject({
      cct: [3000, 4000],
      ip: [20, 65],
      w: ["0-10", "41+"],
      beam: [24.5, 36],
      track: [5, 20],
      cat: ["office-a", "retail-b"],
    });
  });

  it("accepts Next's searchParams record with arrays", () => {
    expect(
      parseListingParams(
        { cct: ["3000", "2700"], sort: "name", page: "3", other: "x" },
        ALL,
      ),
    ).toMatchObject({ cct: [2700, 3000], sort: "name", page: 3 });
  });

  it("drops malformed and out-of-range values without throwing", () => {
    const params = parse(
      "cct=abc,-3000,3e3,999,30000,0x10,3000&cri=101,90&ugr=19.123,19&ip=6a,100,65&track=15,10&w=5-10,11-20&cat=Bad Slug,ok&sort=price&page=0",
    );
    expect(params).toEqual({
      ...DEFAULT_LISTING_PARAMS,
      cct: [3000],
      cri: [90],
      ugr: [19],
      ip: [65],
      track: [10],
      w: ["11-20"],
      cat: ["ok"],
    });
  });

  it("caps each list at MAX_FACET_SELECTIONS, keeping the smallest", () => {
    const many = Array.from({ length: 30 }, (_, i) => 1000 + i * 100).reverse();
    const params = parse(`cct=${many.join(",")}`);
    expect(params.cct).toHaveLength(MAX_FACET_SELECTIONS);
    expect(params.cct[0]).toBe(1000);
  });

  it("bounds the page and falls back to 1", () => {
    expect(parse("page=2").page).toBe(2);
    expect(parse(`page=${MAX_LISTING_PAGE}`).page).toBe(MAX_LISTING_PAGE);
    for (const bad of ["0", "-1", "1.5", "abc", "10001", "", "1e3"]) {
      expect(parse(`page=${bad}`).page, bad).toBe(1);
    }
  });

  it("drops facets that are not public", () => {
    const params = parse("cct=3000&w=0-10&ip=65&cri=90", {
      publicFacets: ["ip"],
    });
    expect(params.cct).toEqual([]);
    expect(params.w).toEqual([]);
    expect(params.cri).toEqual([]);
    expect(params.ip).toEqual([65]);
  });

  it("drops track and cat unless allowed", () => {
    const params = parse("track=10&cat=office", {
      publicFacets: SPEC_FACET_PARAMS,
    });
    expect(params.track).toEqual([]);
    expect(params.cat).toEqual([]);
  });

  it("never reads inherited keys of a plain record", () => {
    const query = Object.create({ cct: "3000" }) as Record<string, string>;
    expect(parseListingParams(query, ALL).cct).toEqual([]);
    expect(
      parseListingParams(JSON.parse('{"__proto__":{"cct":"3000"}}'), ALL).cct,
    ).toEqual([]);
  });

  it("ignores oversized entries", () => {
    expect(parse(`cct=${"3000,".repeat(200)}`).cct).toEqual([]);
  });
});

describe("publicSpecFacets", () => {
  it("follows the column visibility and fails closed", () => {
    expect(publicSpecFacets()).toEqual([...SPEC_FACET_PARAMS]);
    expect(
      publicSpecFacets({ wattage: "restricted", cct: "restricted" }),
    ).toEqual(["cri", "beam", "ugr", "ip"]);
    expect(
      publicSpecFacets({
        ipRating: "RESTRICTED" as unknown as "restricted",
      }),
    ).not.toContain("ip");
  });
});

describe("serialiseListingParams", () => {
  it("builds a stable canonical query string", () => {
    const params = parse(
      "page=2&sort=name&ip=65&w=41%2B,0-10&cct=4000,3000&cat=b,a&track=10",
    );
    expect(serialiseListingParams(params)).toBe(
      "cat=a,b&track=10&cct=3000,4000&w=0-10,41%2B&ip=65&sort=name&page=2",
    );
    expect(listingFilterKey(params)).toBe(
      "cat=a,b&track=10&cct=3000,4000&w=0-10,41%2B&ip=65",
    );
  });

  it("is empty for the defaults", () => {
    expect(serialiseListingParams({ ...DEFAULT_LISTING_PARAMS })).toBe("");
  });
});

describe("facetValueLabel", () => {
  it("labels values for options and chips", () => {
    expect(facetValueLabel("cct", "3000")).toBe("3000K");
    expect(facetValueLabel("ip", "5")).toBe("IP05");
    expect(facetValueLabel("beam", "24")).toBe("24°");
    expect(facetValueLabel("track", "10")).toBe("10 mm");
    expect(facetValueLabel("w", "41+")).toBe(WATTAGE_BUCKETS[3].label);
  });
});

// ---------------------------------------------------------------------------
// Property test (seeded, no extra dependency)
// ---------------------------------------------------------------------------

/* mulberry32: a small deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = [
  "cct",
  "cri",
  "beam",
  "ugr",
  "w",
  "ip",
  "track",
  "cat",
  "sort",
  "page",
  "junk",
  "__proto__",
  "constructor",
];
const PIECES = [
  "3000",
  "2700",
  "4000",
  "90",
  "24",
  "24.5",
  "65",
  "10",
  "20",
  "5",
  "0-10",
  "41+",
  "11-20",
  "name",
  "newest",
  "catalog",
  "office",
  "a-b",
  "-1",
  "1e9",
  "NaN",
  "%",
  "<script>",
  "Ω",
  " ",
  ",",
  ",,",
  "999999",
  "0",
  "",
];

function junkQuery(next: () => number): URLSearchParams {
  const query = new URLSearchParams();
  const entries = Math.floor(next() * 40);
  for (let i = 0; i < entries; i++) {
    const key = KEYS[Math.floor(next() * KEYS.length)] as string;
    const tokens = Math.floor(next() * 6);
    const value = Array.from(
      { length: tokens },
      () => PIECES[Math.floor(next() * PIECES.length)],
    ).join(next() < 0.5 ? "," : "");
    query.append(key, value);
  }
  return query;
}

function expectBounded(params: ListingParams): void {
  expect(Object.keys(params).sort()).toEqual(
    Object.keys(DEFAULT_LISTING_PARAMS).sort(),
  );
  for (const param of NUMERIC_FACET_PARAMS) {
    const values = params[param];
    const { min, max } = NUMERIC_FACET_BOUNDS[param];
    expect(values.length).toBeLessThanOrEqual(MAX_FACET_SELECTIONS);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) {
      expect(Number.isFinite(v) && v >= min && v <= max).toBe(true);
    }
  }
  expect(params.w.length).toBeLessThanOrEqual(WATTAGE_BUCKETS.length);
  expect(params.track.every((t) => [5, 10, 20].includes(t))).toBe(true);
  expect(params.cat.length).toBeLessThanOrEqual(MAX_FACET_SELECTIONS);
  expect(["catalog", "name", "newest"]).toContain(params.sort);
  expect(Number.isInteger(params.page)).toBe(true);
  expect(params.page >= 1 && params.page <= MAX_LISTING_PAGE).toBe(true);
}

describe("property: any junk → bounded canonical form", () => {
  const optionSets: ListingParamOptions[] = [
    ALL,
    { publicFacets: [] },
    { publicFacets: ["cct", "w"], track: true },
  ];

  it("holds for 600 random queries per option set", () => {
    const next = prng(20261008);
    for (const options of optionSets) {
      const allowed = new Set(options.publicFacets);
      for (let i = 0; i < 600; i++) {
        const query = junkQuery(next);
        const params = parseListingParams(query, options);
        expectBounded(params);
        for (const param of SPEC_FACET_PARAMS) {
          if (!allowed.has(param)) expect(params[param]).toEqual([]);
        }
        if (options.track !== true) expect(params.track).toEqual([]);
        if (options.cat !== true) expect(params.cat).toEqual([]);
        // Round trip: the canonical string parses back to the same value,
        // and serialising again gives the same string.
        const text = serialiseListingParams(params);
        const again = parseListingParams(new URLSearchParams(text), options);
        expect(again).toEqual(params);
        expect(serialiseListingParams(again)).toBe(text);
      }
    }
    // Explicit timeout: ~6,000 assertions per set are slow under full-suite load.
  }, 30_000);
});
