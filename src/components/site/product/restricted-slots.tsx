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
 * below lg the label sits above the action (min-h-31 fits every state at
 * 360–1023 px); from lg the slot is one 56 px row, label left and action
 * right, so it stays in the first screen at 1280×800 (ui-reviewer H-1).
 * Every state's row content fits one line in the narrowest lg panel (~360 px),
 * see datasheet-button.tsx. "Coming soon" is final on the server (no
 * datasheetId), so the row drops the repeated "Datasheet" label there.
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
      className="flex min-h-31 flex-col justify-center gap-1 border border-grey-300 px-5 py-4 lg:min-h-14 lg:flex-row lg:items-center lg:justify-between lg:gap-4 lg:py-1 lg:pr-1"
    >
      <p
        className={
          hasDatasheet ? "text-sm font-medium" : "text-sm font-medium lg:hidden"
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
