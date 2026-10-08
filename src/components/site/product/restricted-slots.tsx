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

const signInLink =
  "inline-flex min-h-11 items-center underline underline-offset-4 decoration-grey-400 transition-colors duration-(--duration-quick) hover:decoration-ink";

export function DatasheetSlot({
  productId,
  hasDatasheet,
}: {
  productId: string;
  hasDatasheet: boolean;
}) {
  return (
    <div
      data-slot="datasheet"
      className="flex min-h-31 flex-col justify-center gap-1 border border-grey-300 px-5 py-4"
    >
      <p className="text-sm font-medium">Datasheet</p>
      <DatasheetBlock
        fallback={
          <DatasheetButton
            state={hasDatasheet ? "signin" : "coming-soon"}
            productId={productId}
          />
        }
      />
    </div>
  );
}

export function RestrictedSpecsSlot() {
  return (
    <div
      data-slot="restricted-specs"
      className="flex min-h-24 flex-col justify-center border-t border-grey-300 py-6 text-sm text-grey-600"
    >
      <RestrictedSpecsBlock
        fallback={
          <p>
            Some specifications are shared with approved customers only.{" "}
            <a href="/login" className={`${signInLink} text-ink`}>
              Sign in to see them
            </a>
          </p>
        }
      />
    </div>
  );
}
