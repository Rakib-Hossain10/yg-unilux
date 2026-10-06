// Tests for the /blocked page: it shows exactly the proxy 403 page's text
// (shared BLOCKED_COPY) and is never indexed.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BLOCKED_COPY, blockedResponse } from "@/lib/geo";

import BlockedPage, { metadata } from "./page";

describe("/blocked page", () => {
  it("shows the same heading and message as the proxy's 403 page", async () => {
    const html = renderToStaticMarkup(BlockedPage());
    const proxyHtml = await blockedResponse().text();
    for (const text of [BLOCKED_COPY.heading, BLOCKED_COPY.message]) {
      expect(html).toContain(text);
      expect(proxyHtml).toContain(text);
    }
    expect(proxyHtml).toContain(
      `<title>${BLOCKED_COPY.title} | YG UniLUX</title>`,
    );
  });

  it("is noindex and titled like the proxy page", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    // The root template ("%s | YG UniLUX") completes it to match.
    expect(metadata.title).toBe(BLOCKED_COPY.title);
  });
});
