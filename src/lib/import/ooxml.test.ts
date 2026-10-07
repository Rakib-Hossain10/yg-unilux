// Tests for the minimal Open XML helpers: the linear XML reader (entities,
// CDATA, quotes, prefixes, refusals and limits) and relationship targets.

import { describe, expect, it } from "vitest";

import {
  descendantsNamed,
  parseXml,
  readRelationships,
  relsPathFor,
  resolveTarget,
} from "./ooxml";

describe("parseXml", () => {
  it("drops namespace prefixes and reads attributes and text", () => {
    const root = parseXml(
      '<?xml version="1.0"?><xdr:wsDr xmlns:xdr="x"><xdr:from><xdr:row> 2 </xdr:row></xdr:from><a:blip r:embed="rId1"/></xdr:wsDr>',
    );
    expect(root?.name).toBe("wsDr");
    expect(descendantsNamed(root!, "row")[0]?.text).toBe(" 2 ");
    expect(descendantsNamed(root!, "blip")[0]?.attrs).toEqual({
      embed: "rId1",
    });
  });

  it("decodes the predefined entities and character references only", () => {
    const root = parseXml(
      `<s name="R&amp;D &lt;1&gt; &quot;a&quot; &apos;b&apos; &#65;&#x42; &foo;">x &amp; y<![CDATA[<raw &amp;>]]></s>`,
    );
    expect(root?.attrs.name).toBe(`R&D <1> "a" 'b' AB &foo;`);
    expect(root?.text).toBe("x & y<raw &amp;>");
  });

  it("allows > inside quoted attribute values and single quotes", () => {
    const root = parseXml(`<a t='x > y' u="1"/>`);
    expect(root?.attrs).toEqual({ t: "x > y", u: "1" });
  });

  it.each([
    ["a DOCTYPE", '<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>'],
    ["mismatched tags", "<a><b></a></b>"],
    ["an unclosed element", "<a><b></b>"],
    ["an unterminated tag", '<a t="x>'],
    ["two root elements", "<a/><b/>"],
    ["an attribute without a value", "<a disabled/>"],
    ["an unterminated comment", "<a><!-- x </a>"],
  ])("refuses %s", (_label, xml) => {
    expect(parseXml(xml)).toBeNull();
  });

  it("refuses documents past the node or depth limit", () => {
    expect(
      parseXml("<a><b/><b/><b/></a>", { maxNodes: 3, maxDepth: 10 }),
    ).toBeNull();
    expect(
      parseXml("<a><b/><b/></a>", { maxNodes: 3, maxDepth: 10 }),
    ).not.toBeNull();
    expect(
      parseXml("<a><b><c/></b></a>", { maxNodes: 10, maxDepth: 2 }),
    ).toBeNull();
  });

  it("counts self-closing and explicitly closed elements alike for depth", () => {
    const limits = { maxNodes: 10, maxDepth: 2 };
    expect(parseXml("<a><b/></a>", limits)).not.toBeNull();
    expect(parseXml("<a><b></b></a>", limits)).not.toBeNull();
    expect(parseXml("<a><b><c/></b></a>", limits)).toBeNull();
  });

  it("keeps an attribute named like an Object.prototype member", () => {
    expect(parseXml('<a constructor="x" toString="y"/>')?.attrs).toEqual({
      constructor: "x",
      toString: "y",
    });
  });

  it("stays linear on a huge attribute-less tag", () => {
    const started = performance.now();
    expect(parseXml(`<a ${"x".repeat(2_000_000)}/>`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("relationships", () => {
  it("names a part's .rels file", () => {
    expect(relsPathFor("xl/worksheets/sheet1.xml")).toBe(
      "xl/worksheets/_rels/sheet1.xml.rels",
    );
    expect(relsPathFor("xl/workbook.xml")).toBe("xl/_rels/workbook.xml.rels");
  });

  it.each([
    ["xl/drawings/drawing1.xml", "../media/image1.png", "xl/media/image1.png"],
    ["xl/workbook.xml", "worksheets/sheet1.xml", "xl/worksheets/sheet1.xml"],
    [
      "xl/workbook.xml",
      "/xl/worksheets/sheet2.xml",
      "xl/worksheets/sheet2.xml",
    ],
    [
      "xl/drawings/drawing1.xml",
      "../media/image%201.png",
      "xl/media/image 1.png",
    ],
    ["xl/drawings/drawing1.xml", "../../../etc/passwd", null],
    ["xl/drawings/drawing1.xml", "", null],
    ["xl/drawings/drawing1.xml", "%E0%A4%A", null],
    ["xl/drawings/drawing1.xml", "%2e%2e/%2e%2e/%2e%2e/x.png", null],
    ["xl/drawings/drawing1.xml", "../media/a.png#frag", "xl/media/a.png"],
    ["xl/drawings/drawing1.xml", "../media/", null],
  ])("resolves %s + %s", (source, target, expected) => {
    expect(resolveTarget(source, target)).toBe(expected);
  });

  it("reads ids, types, external targets; skips escaping and duplicate ids", () => {
    const rels = parseXml(
      `<Relationships>
        <Relationship Id="rId1" Type="t/image" Target="../media/a.png"/>
        <Relationship Id="rId1" Type="t/image" Target="../media/b.png"/>
        <Relationship Id="rId2" Type="t/image" Target="https://x.test/a.png" TargetMode="External"/>
        <Relationship Id="rId3" Type="t/image" Target="../../../../x.png"/>
      </Relationships>`,
    );
    const map = readRelationships(rels!, "xl/drawings/drawing1.xml");
    expect([...map.entries()]).toEqual([
      [
        "rId1",
        {
          type: "t/image",
          target: "xl/media/a.png",
          rawTarget: "../media/a.png",
          external: false,
        },
      ],
      [
        "rId2",
        {
          type: "t/image",
          target: "https://x.test/a.png",
          rawTarget: "https://x.test/a.png",
          external: true,
        },
      ],
    ]);
  });
});
