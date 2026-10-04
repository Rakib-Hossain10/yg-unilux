// /blocked: the "not available in your region" page for direct visits and
// previews. Visitors from mainland China never reach it: the proxy answers
// them with its own 403 page, which shares this text (ADR 0026).

import type { Metadata } from "next";

import { BLOCKED_COPY } from "@/lib/geo";

export const metadata: Metadata = {
  // The root layout's template adds " | YG UniLUX".
  title: BLOCKED_COPY.title,
  robots: { index: false, follow: false },
};

/* Static and outside the (site) group, so no header, footer or scripts of
   its own; the same calm, centred look as the proxy's page. */
export default function BlockedPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="max-w-lg text-center">
        <h1 className="mb-3 font-display text-3xl font-medium tracking-wide">
          {BLOCKED_COPY.heading}
        </h1>
        <p className="text-grey-600">{BLOCKED_COPY.message}</p>
      </div>
    </main>
  );
}
