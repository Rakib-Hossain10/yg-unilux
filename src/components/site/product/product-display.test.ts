// Unit tests for the product page's pure display helpers: sentence-case
// labels, panel/table split from SPEC_COLUMNS placement, Models columns,
// titles and the templated meta description.

import { describe, expect, it } from "vitest";

import type { PublicProductView, PublicVariantView } from "@/lib/catalog/view";
import { specColumnsFor } from "@/models/spec-columns";

import {
  displaySpecs,
  extraSpecGroups,
  metaDescription,
  modelsTableColumns,
  productTitle,
  quickSpecRows,
  sentenceCase,
  specTableGroups,
  variantName,
} from "./product-display";
import { productJsonLd, serializeJsonLd } from "./product-json-ld";

const variant = (
  modelNo: string,
  specs: PublicVariantView["specs"],
  label: string | null = null,
): PublicVariantView => ({ modelNo, label, imagePublicId: null, specs });

const product = (over: Partial<PublicProductView> = {}): PublicProductView => ({
  id: "0123456789abcdef01234567",
  slug: "arc-ar-013a",
  name: "Arc",
  family: "Arc",
  modelCode: "AR-013A",
  productNo: 76,
  type: "Recessed spot",
  description: null,
  mainCategoryId: "0123456789abcdef01234568",
  extraCategoryIds: [],
  areas: [],
  trackSize: null,
  images: [],
  specs: { cct: ["3000K"] },
  variants: [],
  extraSpecs: [],
  publicFiles: [],
  hasDatasheet: false,
  updatedAt: "2026-10-08T00:00:00.000Z",
  ...over,
});

describe("sentenceCase", () => {
  it.each([
    ["Housing Color/Finish", "Housing color/finish"],
    ["IP Rating", "IP rating"],
    ["CCT", "CCT"],
    ["Cut-out Size", "Cut-out size"],
    ["Lumen Efficiency", "Lumen efficiency"],
  ])("%s -> %s", (input, output) => {
    expect(sentenceCase(input)).toBe(output);
  });
});

describe("panel and table split", () => {
  const every = Object.fromEntries(
    [...specColumnsFor("quick"), ...specColumnsFor("table")].map((c) => [
      c.key,
      ["x"],
    ]),
  );

  it("puts exactly the 'quick' columns in the panel, in sheet order", () => {
    expect(quickSpecRows(every).map((row) => row.key)).toEqual(
      specColumnsFor("quick").map((c) => c.key),
    );
  });

  it("groups the 'table' columns in sheet order and hides empty groups", () => {
    const groups = specTableGroups(every);
    expect(groups.flatMap((g) => g.rows.map((r) => r.key))).toEqual(
      specColumnsFor("table").map((c) => c.key),
    );
    expect(specTableGroups({ cri: ["90"] })).toEqual([
      {
        title: "Light source",
        rows: [{ key: "cri", label: "CRI", values: ["90"] }],
      },
    ]);
    expect(specTableGroups({ cri: [] })).toEqual([]);
  });

  it("shows variant 1's merged values, else the product's", () => {
    expect(displaySpecs(product())).toEqual({ cct: ["3000K"] });
    expect(
      displaySpecs(
        product({
          variants: [variant("A", { cct: ["4000K"] }), variant("B", {})],
        }),
      ),
    ).toEqual({ cct: ["4000K"] });
  });
});

describe("extraSpecGroups", () => {
  it("groups by title in stored order and skips blank entries", () => {
    expect(
      extraSpecGroups([
        { group: "Mounting", label: "Ceiling", value: "Plaster" },
        { group: null, label: "Note", value: "Custom finishes" },
        { group: "Mounting", label: "Depth", value: "80 mm" },
        { group: null, label: " ", value: "x" },
      ]),
    ).toEqual([
      {
        title: "Mounting",
        rows: [
          { label: "Ceiling", value: "Plaster" },
          { label: "Depth", value: "80 mm" },
        ],
      },
      {
        title: "Additional information",
        rows: [{ label: "Note", value: "Custom finishes" }],
      },
    ]);
  });
});

describe("modelsTableColumns", () => {
  it("is empty for one variant", () => {
    expect(modelsTableColumns([variant("A", { lumenOutput: ["1"] })])).toEqual(
      [],
    );
  });

  it("keeps lumen output/efficiency and every differing column", () => {
    const columns = modelsTableColumns([
      variant("A", {
        lens: ["PC"],
        cct: ["3000K"],
        lumenOutput: ["900lm"],
        lumenEfficiency: ["90lm/W"],
      }),
      variant("B", {
        lens: ["Reflector"],
        cct: ["3000K"],
        lumenOutput: ["900lm"],
        lumenEfficiency: ["90lm/W"],
      }),
    ]);
    expect(columns).toEqual(["lens", "lumenOutput", "lumenEfficiency"]);
  });
});

describe("names and titles", () => {
  it("variant name falls back to the model no.", () => {
    expect(variantName(variant("AR-1", {}, "Lens"))).toBe("Lens");
    expect(variantName(variant("AR-1", {}, null))).toBe("AR-1");
  });

  it("adds the base model code unless the name has it", () => {
    expect(productTitle({ name: "Arc", modelCode: "AR-013A" })).toBe(
      "Arc AR-013A",
    );
    expect(productTitle({ name: "Arc AR-013A", modelCode: "ar-013a" })).toBe(
      "Arc AR-013A",
    );
    expect(productTitle({ name: "Arc", modelCode: null })).toBe("Arc");
  });

  it("templates a meta description from public values when none is written", () => {
    expect(
      metaDescription(
        product({ specs: { cct: ["3000K", "4000K"], ipRating: ["IP44"] } }),
      ),
    ).toBe(
      "Arc AR-013A: Recessed spot by YG UniLUX. CCT 3000K, 4000K; IP rating IP44.",
    );
    expect(metaDescription(product({ description: "  Own text. " }))).toBe(
      "Own text.",
    );
  });
});

describe("JSON-LD", () => {
  it("escapes '<' so a stored string cannot close the script", () => {
    const ld = productJsonLd(
      product({ name: "</script><script>alert(1)</script>" }),
      [],
      null,
    );
    expect(serializeJsonLd(ld)).not.toContain("<");
  });
});
