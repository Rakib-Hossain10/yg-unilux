// Tests for header matching: the English first line of a header cell, case-
// and space-insensitive, trailing "." optional, maps to one column key; every
// spec column and the template columns are covered; anything else is unknown.

import { describe, expect, it } from "vitest";

import { SPEC_COLUMNS } from "@/models/spec-columns";

import { FIXTURE_HEADERS } from "../../../test/fixtures/import/build";
import { REQUIRED_COLUMNS, columnForHeader, normalizeHeader } from "./columns";

describe("normalizeHeader", () => {
  it.each([
    ["NO.", "no"],
    ["Model No.\n型号", "model no"],
    ["HOLDER\n支架", "holder"],
    ["Voltage INPUT\n输入电压 ", "voltage input"],
    ["  Chip   Efficiency \n 芯片光效", "chip efficiency"],
    ["Lens 透镜", "lens"],
    ["Housing Color/Finish\n外壳颜色/表面处理", "housing color/finish"],
    ["Ｍｏｄｅｌ Ｎｏ．", "model no"],
    ["\n型号", ""],
  ])("%j → %j", (raw, expected) => {
    expect(normalizeHeader(raw)).toBe(expected);
  });
});

describe("columnForHeader", () => {
  it("maps the five identity columns", () => {
    expect(columnForHeader("NO.")).toBe("productNo");
    expect(columnForHeader("No")).toBe("productNo");
    expect(columnForHeader("Model Name\n型号名称")).toBe("family");
    expect(columnForHeader("Model Type\n型号类型")).toBe("type");
    expect(columnForHeader("model no\n型号")).toBe("modelNo");
    expect(columnForHeader("Image\n图片")).toBe("image");
  });

  it("maps every one of the 28 spec columns by its English header", () => {
    for (const column of SPEC_COLUMNS) {
      expect(columnForHeader(`${column.header}\n中文`)).toBe(column.key);
      expect(columnForHeader(column.header.toUpperCase())).toBe(column.key);
    }
  });

  it("maps the optional template columns", () => {
    expect(columnForHeader("Category")).toBe("category");
    expect(columnForHeader("Extra Categories")).toBe("extraCategories");
    expect(columnForHeader("AREAS\n应用领域")).toBe("areas");
  });

  it("maps all 33 headers of the client sheet (with their quirks)", () => {
    const keys = FIXTURE_HEADERS.map((h) => columnForHeader(h));
    expect(keys).not.toContain(null);
    expect(new Set(keys).size).toBe(33);
  });

  it("returns null for anything else (no guessing)", () => {
    expect(columnForHeader("Remarks\n备注")).toBeNull();
    expect(columnForHeader("Cutout Size")).toBeNull();
    expect(columnForHeader("")).toBeNull();
  });

  it("requires NO. and Model No.", () => {
    expect(REQUIRED_COLUMNS).toEqual(["productNo", "modelNo"]);
  });
});
