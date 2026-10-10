// Reserved places for the dynamic restricted block (task P7, ADR 0062/0064):
// the datasheet button in the panel and the restricted spec rows under the
// table. Server Components: they render only the visitor fallback, never a
// restricted value; the client block swaps it once the viewer's answer is in.

/*
 * The wrappers keep their data-slot hooks and minimum height, so the swap
 * causes no layout shift in the panel. Without JavaScript (or when the
 * request fails) the fallback line stays. Sign-in is a plain <a>: /login
 * must be a full page load (ADR 0027 note).
 */

import { DatasheetButton } from "./datasheet-button";
import { DatasheetBlock, RestrictedSpecsBlock } from "./restricted-block";
import { requestAccessUrl, signInUrl } from "./restricted-data";

const signInLink =
  "inline-flex min-h-11 items-center underline underline-offset-4 decoration-grey-400 transition-colors duration-(--duration-quick) hover:decoration-ink";

/*
 * Reserved height per breakpoint (no layout shift when the answer arrives):
 * below 2xl the label sits above the action (min-h-31 fits every state from
 * 360 px up to the ~470 px lg–xl panel, where a one-row download button and
 * its file note were cramped, gate C ui-review); the slot still ends inside
 * the first screen at 1280×800 (ui-reviewer H-1). From 2xl the ~536 px panel
 * takes one 56 px row, label left and action right; every state's row
 * content fits one line there, see datasheet-button.tsx. "Coming soon" is
 * final on the server (no datasheetId), so the 2xl row drops the repeated
 * "Datasheet" label there.
 */
export function DatasheetSlot({
  productId,
  productSlug,
  hasDatasheet,
}: {
  productId: string;
  productSlug: string;
  hasDatasheet: boolean;
}) {
  return (
    <div
      data-slot="datasheet"
      className="flex min-h-31 flex-col justify-center gap-1 border border-grey-300 px-5 py-4 2xl:min-h-14 2xl:flex-row 2xl:items-center 2xl:justify-between 2xl:gap-4 2xl:py-1 2xl:pr-1"
    >
      <p
        className={
          hasDatasheet
            ? "text-sm font-medium"
            : "text-sm font-medium 2xl:hidden"
        }
      >
        Datasheet
      </p>
      <DatasheetBlock
        productSlug={productSlug}
        fallback={
          <DatasheetButton
            state={hasDatasheet ? "signin" : "coming-soon"}
            productId={productId}
            productSlug={productSlug}
          />
        }
      />
    </div>
  );
}

export function RestrictedSpecsSlot({
  productId,
  productSlug,
}: {
  productId: string;
  productSlug: string;
}) {
  return (
    <div
      data-slot="restricted-specs"
      className="flex min-h-24 flex-col justify-center border-t border-grey-300 py-6 text-sm text-grey-600"
    >
      <RestrictedSpecsBlock
        fallback={
          <p>
            Some specifications are shared with approved customers only.{" "}
            <a
              href={signInUrl(productSlug)}
              className={`${signInLink} text-ink`}
            >
              Sign in to see them
            </a>{" "}
            or{" "}
            <a
              href={requestAccessUrl(productId)}
              className={`${signInLink} text-ink`}
            >
              request access
            </a>
            .
          </p>
        }
      />
    </div>
  );
}
