// Tests for the cell cleaner (plan "Cell cleaning rules" 1-7): the real
// sheet's cell shapes (synthetic copies, no restricted values), every rule,
// the identity and template columns, and "no CJK ever survives".

import { describe, expect, it } from "vitest";

import {
  MAX_MODEL_NO_LENGTH,
  MAX_PRODUCT_AREAS,
  MAX_PRODUCT_FAMILY_LENGTH,
  MAX_PRODUCT_TYPE_LENGTH,
  MAX_SPEC_OPTIONS,
  MAX_SPEC_VALUE_LENGTH,
} from "@/lib/constants";
import type { SpecKey } from "@/models/spec-columns";

import {
  cleanCategory,
  cleanFamily,
  cleanModelNo,
  cleanNameList,
  cleanProductNo,
  cleanRow,
  cleanSpecCell,
  cleanType,
} from "./clean";

const AT = { sheet: "Sheet1", row: 3 };

/* The cleaned values of one spec cell (null = not applicable). */
function values(key: SpecKey, raw: string | number | undefined) {
  return cleanSpecCell(key, raw, AT).values;
}

function codes(key: SpecKey, raw: string | number | undefined) {
  return cleanSpecCell(key, raw, AT).warnings.map((w) => w.code);
}

describe("cleanSpecCell: the plan's examples (real sheet cell shapes)", () => {
  it.each<[SpecKey, string | number, string[]]>([
    ["driver", "Lifud 莱福德", ["Lifud"]],
    [
      "housingMaterial",
      "Die Casting\nAluminium + PC\n\n压铸铝 + PC ",
      ["Die Casting Aluminium + PC"],
    ],
    ["housingFinish", "White/Black\n\n白色/黑色", ["White", "Black"]],
    ["cct", "3000K\n4000K", ["3000K", "4000K"]],
    ["powerFactor", 0.9, ["0.9"]],
    ["powerFactor", "0.9", ["0.9"]],
    ["lifespan", "50,000 hrs ", ["50,000 hrs"]],
    ["cct", "3000K（暖白）", ["3000K"]],
    ["beamAngle", "20°\n30°\n40°\n60°", ["20°", "30°", "40°", "60°"]],
    ["cri", ">90", [">90"]],
    ["ipRating", "IP20", ["IP20"]],
    ["wattage", "12W", ["12W"]],
    ["lumenEfficiency", "95±", ["95±"]],
    ["sdcm", "≤3", ["≤3"]],
    ["voltageInput", "AC100-240V/50-60Hz", ["AC100-240V/50-60Hz"]],
    ["voltageInput", "220-240V", ["220-240V"]],
    ["lens", "Regular Lens\n\n普通透镜", ["Regular Lens"]],
    [
      "reflector",
      "High Effciency Reflector\n\n高效反射器 ",
      ["High Effciency Reflector"],
    ],
    ["cutOutSize", "Ø90mm", ["Ø90mm"]],
    ["dimensions", "146*D92*H110mm", ["146*D92*H110mm"]],
  ])("%s %j → %j", (key, raw, expected) => {
    const result = cleanSpecCell(key, raw, AT);
    expect(result.values).toEqual(expected);
    expect(result.warnings).toEqual([]);
  });

  it('"铝" → not applicable, with a cjk_only_cell warning naming the cell', () => {
    const result = cleanSpecCell("housingMaterial", "铝", AT);
    expect(result.values).toBeNull();
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "cjk_only_cell",
        severity: "warning",
        sheet: "Sheet1",
        row: 3,
        column: "housingMaterial",
      }),
    ]);
  });
});

describe("rule 1: to string", () => {
  it("formats number cells as plain decimal strings", () => {
    expect(values("powerFactor", 0.1 + 0.2)).toEqual(["0.3"]);
    expect(values("wattage", 12)).toEqual(["12"]);
    expect(values("wattage", 1e21)).toEqual(["1000000000000000000000"]);
  });

  it("treats undefined, empty and non-finite numbers as not applicable", () => {
    expect(values("wattage", undefined)).toBeNull();
    expect(values("wattage", "")).toBeNull();
    expect(values("wattage", Number.NaN)).toBeNull();
  });
});

describe("rule 2: NFKC", () => {
  it("turns full-width letters and digits into ASCII", () => {
    expect(values("cct", "３０００Ｋ")).toEqual(["3000K"]);
    expect(values("ipRating", "ＩＰ６５")).toEqual(["IP65"]);
  });

  it("keeps ≤ ± ° Ø × ~ as they are", () => {
    expect(values("sdcm", "≤3")).toEqual(["≤3"]);
    expect(values("lumenEfficiency", "100±")).toEqual(["100±"]);
    expect(values("beamAngle", "24°")).toEqual(["24°"]);
    expect(values("cutOutSize", "Ø90mm")).toEqual(["Ø90mm"]);
    expect(values("dimensions", "100×100mm")).toEqual(["100×100mm"]);
    expect(values("cct", "2700K～6500K")).toEqual(["2700K~6500K"]);
  });
});

describe("rule 3: line endings and the blank-line cut", () => {
  it("normalises CRLF and CR line endings", () => {
    expect(values("cct", "3000K\r\n4000K")).toEqual(["3000K", "4000K"]);
    expect(values("cct", "3000K\r4000K")).toEqual(["3000K", "4000K"]);
    expect(values("cct", "3000K\u20284000K")).toEqual(["3000K", "4000K"]);
  });

  it("keeps only the text before the first blank line", () => {
    expect(values("lens", "Regular Lens\n\nSecond block")).toEqual([
      "Regular Lens",
    ]);
    // A line of spaces (or an ideographic space) is a blank line too.
    expect(values("lens", "Regular Lens\n \t\nSecond")).toEqual([
      "Regular Lens",
    ]);
    expect(values("lens", "Regular Lens\n\u3000\nSecond")).toEqual([
      "Regular Lens",
    ]);
  });

  it("ignores blank lines before the first text", () => {
    expect(values("lens", "\n\nRegular Lens\n\n普通透镜")).toEqual([
      "Regular Lens",
    ]);
  });
});

describe("rule 4: CJK strip", () => {
  it.each<[SpecKey, string, string[]]>([
    ["driver", "莱福德 Lifud", ["Lifud"]],
    ["cct", "3000K (暖白)", ["3000K"]],
    ["cct", "3000K[暖白]", ["3000K"]],
    ["cct", "3000K（暖白/冷白）", ["3000K"]],
    ["housingFinish", "White/白色", ["White"]],
    ["housingFinish", "White/白色/Black", ["White", "Black"]],
    ["housingMaterial", "Aluminium 铝 + PC", ["Aluminium + PC"]],
    ["housingMaterial", "Aluminium铝Body", ["Aluminium Body"]],
    ["lens", "Lens、透镜", ["Lens"]],
    ["lens", "Lens，透镜", ["Lens"]],
    ["lens", "レンズ Lens", ["Lens"]],
    ["lens", "렌즈 Lens", ["Lens"]],
    ["lens", "ㄅ Lens", ["Lens"]],
    ["lens", "「Lens」", ["Lens"]],
    // U+FE45 and U+FF00 have no NFKC mapping, so the strip must catch them.
    ["lens", "Lens \uFE45", ["Lens"]],
    ["lens", "Lens \uFF00", ["Lens"]],
  ])("%s %j → %j", (key, raw, expected) => {
    expect(values(key, raw)).toEqual(expected);
  });

  it("keeps a sign that belongs to the value, even next to removed CJK", () => {
    expect(values("cri", "Ra90+ 高显色")).toEqual(["Ra90+"]);
    expect(values("dimensions", "高温 -20°C")).toEqual(["-20°C"]);
    expect(values("housingMaterial", "铝 + PC")).toEqual(["PC"]);
    expect(values("cri", "Ra90+高显色")).toEqual(["Ra90+"]);
    expect(values("dimensions", "温度:-20~45°C")).toEqual(["-20~45°C"]);
    expect(values("housingFinish", "White-白色")).toEqual(["White"]);
  });

  it("keeps separators that are not next to removed CJK", () => {
    expect(values("dimensions", "-20~45°C")).toEqual(["-20~45°C"]);
    expect(values("housingMaterial", "Aluminium + PC")).toEqual([
      "Aluminium + PC",
    ]);
    expect(values("cct", "(3000K)")).toEqual(["(3000K)"]);
  });

  it("removes brackets left empty and collapses spaces", () => {
    expect(values("lens", "Regular   Lens ()")).toEqual(["Regular Lens"]);
    expect(values("lens", "  Regular\tLens  ")).toEqual(["Regular Lens"]);
  });
});

describe("rule 5: empty lines and cjk_only_cell", () => {
  it("drops lines left empty", () => {
    expect(values("cct", "3000K\n暖白\n4000K")).toEqual(["3000K", "4000K"]);
  });

  it("warns when a cell held only CJK", () => {
    expect(codes("lens", "普通透镜")).toEqual(["cjk_only_cell"]);
    expect(codes("lens", "\n\n普通透镜")).toEqual(["cjk_only_cell"]);
    expect(codes("lens", "（普通透镜）")).toEqual(["cjk_only_cell"]);
  });

  it("does not warn for a cell that is empty for other reasons", () => {
    expect(codes("lens", "   ")).toEqual([]);
    expect(codes("lens", "()")).toEqual([]);
    expect(codes("lens", "-\n\n无")).toEqual([]);
  });
});

describe("rule 6: not applicable", () => {
  it.each(["-", "\u2013", "\u2014", "/", "", "   ", "\n", "N/A", "n/a", " - "])(
    "%j → not applicable",
    (raw) => {
      expect(values("lens", raw)).toBeNull();
      expect(values("housingFinish", raw)).toBeNull();
      expect(codes("lens", raw)).toEqual([]);
    },
  );

  it("drops not-applicable lines inside a cell", () => {
    expect(values("cct", "3000K\n-\n4000K")).toEqual(["3000K", "4000K"]);
    expect(values("lens", "-\n-")).toBeNull();
  });

  it("keeps a dash that is part of a value", () => {
    expect(values("voltageInput", "AC100-240V")).toEqual(["AC100-240V"]);
    expect(values("ugr", "-5")).toEqual(["-5"]);
  });
});

describe("rule 7: split policy, dedupe, caps", () => {
  it("options: one option per line, no slash split", () => {
    expect(values("cct", "3000K/4000K")).toEqual(["3000K/4000K"]);
    expect(values("driver", "Lifud\nTridonic")).toEqual(["Lifud", "Tridonic"]);
  });

  it("options+slash: lines and slashes both split", () => {
    expect(values("housingFinish", "White/Black\nGrey")).toEqual([
      "White",
      "Black",
      "Grey",
    ]);
    expect(values("reflectorColor", "Gold / Silver/")).toEqual([
      "Gold",
      "Silver",
    ]);
  });

  it("join: lines become one value joined with a space", () => {
    expect(values("lens", "Regular\nLens")).toEqual(["Regular Lens"]);
    expect(values("dimensions", "D100\n*H110mm")).toEqual(["D100 *H110mm"]);
  });

  it("dedupes options and keeps their order", () => {
    expect(values("cct", "4000K\n3000K\n4000K")).toEqual(["4000K", "3000K"]);
    expect(values("housingFinish", "White/Black/White")).toEqual([
      "White",
      "Black",
    ]);
  });

  it("caps the option count with a value_truncated warning", () => {
    const raw = Array.from({ length: MAX_SPEC_OPTIONS + 5 }, (_, i) => `${i}W`);
    const result = cleanSpecCell("wattage", raw.join("\n"), AT);
    expect(result.values).toHaveLength(MAX_SPEC_OPTIONS);
    expect(result.values?.[0]).toBe("0W");
    expect(result.warnings.map((w) => w.code)).toEqual(["value_truncated"]);
    expect(result.warnings[0]?.column).toBe("wattage");
  });

  it("caps a value's length (by code point) with a value_truncated warning", () => {
    const long = "Ø".repeat(MAX_SPEC_VALUE_LENGTH + 10);
    const result = cleanSpecCell("dimensions", long, AT);
    expect(result.values).toEqual(["Ø".repeat(MAX_SPEC_VALUE_LENGTH)]);
    expect(result.warnings.map((w) => w.code)).toEqual(["value_truncated"]);
  });
});

describe("hostile input", () => {
  it("removes direction marks and soft hyphens (they would split a model no.)", () => {
    const marks = [0x200e, 0x200f, 0x202a, 0x202e, 0x00ad, 0x2064].map((c) =>
      String.fromCharCode(c),
    );
    expect(cleanModelNo(`AR-013A1${marks.join("")}`, AT).value).toBe(
      "AR-013A1",
    );
    expect(values("housingFinish", `N/A${marks[0]}`)).toBeNull();
  });

  it("keeps a wave dash range as ~ instead of stripping it as CJK", () => {
    const waveDash = String.fromCharCode(0x301c);
    expect(values("cct", `2700K${waveDash}6500K`)).toEqual(["2700K~6500K"]);
    expect(
      values("dimensions", `-20${String.fromCharCode(0x3030)}45°C`),
    ).toEqual(["-20~45°C"]);
  });

  it("removes control and zero-width characters", () => {
    expect(values("lens", "Regular\u0000 Lens\u200B\uFEFF")).toEqual([
      "Regular Lens",
    ]);
    expect(values("lens", "\u0007")).toBeNull();
  });

  it("handles a huge cell without blowing up", () => {
    const raw = "A".repeat(200_000) + "\n\n" + "汉".repeat(200_000);
    const result = cleanSpecCell("lens", raw, AT);
    expect(result.values?.[0]).toHaveLength(MAX_SPEC_VALUE_LENGTH);
  });
});

describe("cleanProductNo", () => {
  it.each([
    ["76", 76],
    [" 76 ", 76],
    ["７６", 76],
    ["1", 1],
  ])("%j → %d", (raw, expected) => {
    expect(cleanProductNo(raw, AT)).toEqual({ status: "ok", value: expected });
  });

  it.each([undefined, "", "   ", "\n"])(
    "%j → continuation row (belongs to the product above)",
    (raw) => {
      expect(cleanProductNo(raw, AT)).toEqual({ status: "continuation" });
    },
  );

  it.each([
    "0",
    "-1",
    "76.5",
    "abc",
    "-",
    "七十六",
    "No. 76",
    "1e3",
    "99999999999999999999",
  ])("%j → invalid_product_no error", (raw) => {
    const result = cleanProductNo(raw, AT);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.warning).toEqual(
      expect.objectContaining({
        code: "invalid_product_no",
        severity: "error",
        sheet: "Sheet1",
        row: 3,
        column: "productNo",
      }),
    );
  });
});

describe("cleanModelNo", () => {
  it.each([
    ["AR-013A1", "AR-013A1"],
    ["  AR-013A1 ", "AR-013A1"],
    ["ＡＲ－０１３Ａ１", "AR-013A1"],
    ["AR-013A1\n\n型号", "AR-013A1"],
    ["AR-013A1 型号", "AR-013A1"],
  ])("%j → %j", (raw, expected) => {
    expect(cleanModelNo(raw, AT)).toEqual({ value: expected, warnings: [] });
  });

  it("is one line: inner whitespace and line breaks become one space", () => {
    expect(cleanModelNo("AR-013\nA1", AT).value).toBe("AR-013 A1");
  });

  it("flags one longer than MAX_MODEL_NO_LENGTH with invalid_model_no (never cut)", () => {
    const long = "A".repeat(MAX_MODEL_NO_LENGTH + 1);
    const result = cleanModelNo(long, AT);
    expect(result.value).toBe(long);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "invalid_model_no",
        severity: "error",
        column: "modelNo",
      }),
    ]);
    expect(cleanModelNo("A".repeat(MAX_MODEL_NO_LENGTH), AT).warnings).toEqual(
      [],
    );
  });

  it("leaves an empty one as null for grouping to flag", () => {
    expect(cleanModelNo(undefined, AT)).toEqual({ value: null, warnings: [] });
    expect(cleanModelNo("-", AT)).toEqual({ value: null, warnings: [] });
    expect(cleanModelNo("型号", AT).value).toBeNull();
    expect(cleanModelNo("型号", AT).warnings[0]?.code).toBe("cjk_only_cell");
  });
});

describe("cleanFamily and cleanType", () => {
  it("joins Model Type lines into one value", () => {
    expect(
      cleanType(
        "Pull-Down Spot Light\nTrim Round 1 Head\n\n伸缩有边框圆形单头射灯",
        AT,
      ).value,
    ).toBe("Pull-Down Spot Light Trim Round 1 Head");
  });

  it("cleans Model Name", () => {
    expect(cleanFamily("Arc", AT)).toEqual({ value: "Arc", warnings: [] });
    expect(cleanFamily("Arc 弧", AT).value).toBe("Arc");
    expect(cleanFamily(undefined, AT).value).toBeNull();
  });

  it("caps Model Name and Model Type at the product schema lengths", () => {
    const family = cleanFamily("F".repeat(150), AT);
    expect(family.value).toHaveLength(MAX_PRODUCT_FAMILY_LENGTH);
    expect(family.warnings.map((w) => w.code)).toEqual(["value_truncated"]);
    expect(family.warnings[0]?.column).toBe("family");
    expect(cleanType("T".repeat(150), AT).value).toHaveLength(
      MAX_PRODUCT_TYPE_LENGTH,
    );
  });
});

describe("cleanRow", () => {
  it("cleans every column of a sheet row, leaving out not-applicable specs", () => {
    const row = cleanRow({
      sheet: "Sheet1",
      row: 4,
      hidden: false,
      cells: {
        family: "Arc",
        type: "Pull-Down Spot Light\nTrim Round 1 Head\n\n伸缩有边框圆形单头射灯",
        modelNo: "AR-013A2",
        lens: "-",
        reflector: "High Effciency Reflector\n\n高效反射器 ",
        powerFactor: "0.9",
        diffuser: "铝",
        image: "ignored",
        areas: "Retail; Office",
      },
    });
    expect(row).toEqual({
      sheet: "Sheet1",
      row: 4,
      hidden: false,
      productNo: { status: "continuation" },
      family: "Arc",
      type: "Pull-Down Spot Light Trim Round 1 Head",
      modelNo: "AR-013A2",
      specs: {
        reflector: ["High Effciency Reflector"],
        powerFactor: ["0.9"],
      },
      category: null,
      extraCategories: [],
      areas: ["Retail", "Office"],
      areaFlags: [],
      warnings: [
        expect.objectContaining({
          code: "cjk_only_cell",
          sheet: "Sheet1",
          row: 4,
          column: "diffuser",
        }),
      ],
    });
  });

  it("puts an invalid NO. error in the row's warnings too", () => {
    const row = cleanRow({
      sheet: "Sheet1",
      row: 9,
      hidden: false,
      cells: { productNo: "abc", modelNo: "X-1" },
    });
    expect(row.productNo.status).toBe("invalid");
    expect(row.warnings.map((w) => w.code)).toEqual(["invalid_product_no"]);
  });
});

describe("template columns", () => {
  it("Category: one cleaned name or path", () => {
    expect(cleanCategory("Spot Lights > Recessed", AT).value).toBe(
      "Spot Lights > Recessed",
    );
    expect(cleanCategory("Spot Lights 射灯", AT).value).toBe("Spot Lights");
    expect(cleanCategory("-", AT).value).toBeNull();
  });

  it("Extra Categories / Areas: ;-separated, CJK stripped, deduped", () => {
    expect(
      cleanNameList("areas", "Retail; Office ;Retail;; 酒店", AT).values,
    ).toEqual(["Retail", "Office"]);
    expect(
      cleanNameList("extraCategories", "Recessed Lights > Spot\nTrack", AT)
        .values,
    ).toEqual(["Recessed Lights > Spot", "Track"]);
    expect(cleanNameList("areas", undefined, AT).values).toEqual([]);
    expect(cleanNameList("areas", "Retail; retail", AT).values).toEqual([
      "Retail",
    ]);
  });

  it("caps the list length with value_truncated", () => {
    const raw = Array.from({ length: 30 }, (_, i) => `Area ${i}`).join(";");
    const result = cleanNameList("areas", raw, AT);
    expect(result.values).toHaveLength(MAX_PRODUCT_AREAS);
    expect(result.warnings.map((w) => w.code)).toEqual(["value_truncated"]);
  });
});
