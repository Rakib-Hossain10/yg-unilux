// Unit tests for the clamped description (gate C, M-1): short text is a plain
// paragraph; long text is clamped with a "Read more" toggle, full text in DOM.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExpandableText } from "./expandable-text";

const render = (text: string, clamp: boolean) =>
  renderToStaticMarkup(createElement(ExpandableText, { text, clamp }));

describe("ExpandableText", () => {
  it("short text: a plain paragraph, no toggle", () => {
    const html = render("Short.", false);
    expect(html).toBe('<p class="">Short.</p>');
  });

  it("long text: clamped, the whole text kept, a collapsed toggle", () => {
    const text = "Long description. ".repeat(20);
    const html = render(text, true);
    expect(html).toContain("line-clamp-3");
    expect(html).toContain(text.trim());
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/aria-controls="[^"]+"/);
    expect(html).toContain("Read more");
    expect(html).toContain("min-h-11");
  });
});
