// The datasheet block's four states (CLAUDE.md, plan P7). Hook-free: rendered
// by the client restricted block once the per-viewer answer is in, and by the
// server slot for the visitor fallback. Never carries a file URL or key.

/*
 * Every link is a plain <a>: /login and the download route must be full page
 * loads (ADR 0027 note), and the download is served by
 * /api/datasheet/[productId], which re-checks the session (rule 2).
 */

import {
  datasheetUrl,
  requestAccessUrl,
  signInUrl,
  type DatasheetButtonState,
} from "./restricted-data";

/* lg:pr-4: in the one-row slot (restricted-slots.tsx, lg:pr-1) a text link
   keeps the same 20 px from the border as the label on the left. */
const textLink =
  "inline-flex min-h-11 items-center text-ink underline decoration-grey-400 underline-offset-4 transition-colors duration-(--duration-quick) hover:decoration-ink lg:pr-4";

/* A line-drawn arrow into a tray, at text size. */
function DownloadIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <path d="M8 2v8m-3.5-3.5L8 10l3.5-3.5M2.5 11.5v2h11v-2" />
    </svg>
  );
}

export function DatasheetButton({
  state,
  productId,
  productSlug,
}: {
  state: DatasheetButtonState;
  productId: string;
  /** For the sign-in link's `next` (back to this page). Public. */
  productSlug: string;
}) {
  switch (state) {
    case "download":
      return (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <a
            href={datasheetUrl(productId)}
            data-datasheet-state="download"
            className="inline-flex min-h-11 items-center justify-center gap-2.5 bg-ink px-5 text-sm text-paper transition-colors duration-(--duration-quick) hover:bg-grey-800"
          >
            <DownloadIcon />
            Download datasheet
          </a>
          {/* Visually hidden in the one-row slot while the lg panel is too
              narrow for it (lg–xl); screen readers always get it. */}
          <span className="text-xs text-grey-600 lg:max-xl:sr-only">
            Excel workbook (.xlsx)
          </span>
        </p>
      );
    case "expired":
      return (
        <p data-datasheet-state="expired" className="text-sm text-grey-600">
          {/* The renewal form (plan Q6), the same target the datasheet
              route sends an expired customer to (ADR 0071). */}
          <a
            href={requestAccessUrl(productId, { renew: true })}
            className={textLink}
          >
            Access expired — contact us
          </a>
        </p>
      );
    case "signin":
      return (
        <div data-datasheet-state="signin" className="text-sm text-grey-600">
          {/* In the one-row slot (lg+) the row holds only the two links;
              screen readers always get the sentence. */}
          <p className="lg:sr-only">Available to approved customers.</p>
          <p className="flex flex-wrap items-center gap-x-5 lg:gap-x-1">
            {/* One inline span inside the flex link keeps the space and
                the underline continuous. */}
            <a href={signInUrl(productSlug)} className={textLink}>
              <span>
                Sign in{" "}
                {/* Shortened where the lg panel is narrowest (lg–xl); the
                    link's name stays "Sign in to download". */}
                <span className="lg:max-xl:sr-only">to download</span>
              </span>
            </a>
            <a href={requestAccessUrl(productId)} className={textLink}>
              Request access
            </a>
          </p>
        </div>
      );
    case "coming-soon":
      return (
        <p data-datasheet-state="coming-soon" className="text-sm text-grey-600">
          Datasheet coming soon
        </p>
      );
  }
}
