"use client";

// The optic switch (plan "Variant switcher spec"): a native radio group, so
// arrows move and select, Tab leaves the group and screen readers know it. A
// polite live region names the new model and its output after a switch.

import { useVariantSelection, variantOptionId } from "./product-detail-client";
import { variantName } from "./product-display";

/*
 * Rendered only for 2+ variants (the panel decides). The radios are visually
 * hidden but stay the real control; the label rows carry the look and the
 * focus ring (has-[:focus-visible]). Focus never moves on change.
 */
export function VariantSwitcher({
  legend,
  name,
}: {
  /** "Lens", "Lens / Reflector" or "Option" (switcherLegend). */
  legend: string;
  /** The radio group's name; unique per product. */
  name: string;
}) {
  const { variants, index, select, announcement } = useVariantSelection();

  return (
    <>
      <fieldset className="min-w-0">
        <legend className="mb-3 text-sm text-grey-600">{legend}</legend>
        <div className="border-t border-grey-200">
          {variants.map((variant, i) => {
            const title = variantName(variant);
            const hasLabel = title !== variant.modelNo;
            const id = variantOptionId(i);
            return (
              <label
                key={variant.modelNo}
                htmlFor={id}
                className="group relative flex min-h-12 cursor-pointer items-center gap-4 border-b border-grey-200 py-3 pr-1 pl-1 transition-colors duration-(--duration-quick) hover:bg-grey-50 has-[:checked]:bg-grey-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink"
              >
                <input
                  id={id}
                  type="radio"
                  name={name}
                  value={variant.modelNo}
                  checked={i === index}
                  onChange={() => select(i)}
                  className="peer sr-only"
                />
                {/* The drawn radio: a ring, filled when checked. */}
                <span
                  aria-hidden="true"
                  className="grid size-4 shrink-0 place-items-center rounded-full border border-grey-500 peer-checked:border-ink after:size-2 after:scale-0 after:rounded-full after:bg-ink after:transition-transform after:duration-(--duration-quick) peer-checked:after:scale-100"
                />
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                  <span className="text-[0.9375rem] text-ink">{title}</span>
                  {hasLabel ? (
                    <span className="text-xs tracking-[0.04em] text-grey-600 tabular-nums">
                      {variant.modelNo}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
    </>
  );
}
