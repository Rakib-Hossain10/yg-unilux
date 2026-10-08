// The quick-spec panel beside the gallery (ADR 0054, the sheet's pink
// columns): family, title, type, the selected variant's Model No., the
// "quick" columns from SPEC_COLUMNS, the optic switch, readout and datasheet.

import type { PublicProductView } from "@/lib/catalog/view";

import { VariantSpecValues, VariantText } from "./product-detail-client";
import { quickSpecRows, READOUT_KEYS, specLabel } from "./product-display";
import { DatasheetSlot } from "./restricted-slots";
import {
  switcherLegend,
  unionVariantSpecs,
  type SwitchVariant,
} from "./variant-selection";
import { VariantSwitcher } from "./variant-switcher";

/*
 * A Server Component inside <ProductDetailClient>. Rows are every quick column
 * any variant fills (so a switch never adds or removes a row); the values
 * themselves are small client leaves that follow the selected variant.
 * Static HTML shows variant 1 (plan Q3).
 */
export function QuickSpecPanel({
  product,
  variants,
}: {
  product: PublicProductView;
  /** The variants the switcher works on (public values only). */
  variants: readonly SwitchVariant[];
}) {
  const shown = unionVariantSpecs(variants, product.specs);
  const rows = quickSpecRows(shown);
  const hasModelNo = Boolean(variants[0]?.modelNo);
  const readout = READOUT_KEYS.filter(
    (key) => (shown[key]?.length ?? 0) > 0,
  ).map((key) => ({ key, label: specLabel(key) }));
  const family = product.family?.trim();
  const showFamily =
    family && family.toLowerCase() !== product.name.trim().toLowerCase();

  return (
    <div data-slot="quick-spec-panel" className="lg:sticky lg:top-24">
      {showFamily ? (
        <p className="text-sm text-grey-600">
          <span className="sr-only">Family: </span>
          {family}
        </p>
      ) : null}
      <h1 className="mt-2 font-display text-4xl leading-[1.05] font-light text-balance md:text-5xl xl:text-6xl">
        {product.name}
      </h1>
      {product.type ? (
        <p className="mt-3 text-base text-grey-600">{product.type}</p>
      ) : null}
      {product.description ? (
        <p className="mt-6 max-w-prose text-[0.9375rem] leading-relaxed text-grey-700">
          {product.description}
        </p>
      ) : null}

      <dl className="mt-8 text-sm">
        {hasModelNo ? (
          <div className="flex items-baseline justify-between gap-6 border-y border-ink py-4">
            <dt className="text-grey-600">Model No.</dt>
            <dd className="text-lg font-medium tracking-[0.04em] tabular-nums">
              <VariantText field="model-no" />
            </dd>
          </div>
        ) : null}
        {rows.map((row) => (
          <div
            key={row.key}
            data-spec={row.key}
            className="grid grid-cols-[minmax(7.5rem,2fr)_3fr] gap-4 border-b border-grey-200 py-3"
          >
            <dt className="text-grey-600">{row.label}</dt>
            <dd>
              <VariantSpecValues specKey={row.key} />
            </dd>
          </div>
        ))}
      </dl>

      {variants.length > 1 ? (
        <div data-slot="variant-switcher" className="mt-8">
          <VariantSwitcher
            legend={switcherLegend(variants)}
            name={`variant-${product.id}`}
          />
          <p className="mt-2 text-sm text-grey-600">
            <a
              href="#models"
              className="inline-flex min-h-11 items-center text-ink underline decoration-grey-400 underline-offset-4 hover:decoration-ink"
            >
              Compare all {variants.length} models
            </a>
          </p>
        </div>
      ) : null}

      {readout.length > 0 ? (
        <dl data-readout className="mt-6 grid grid-cols-2 gap-px bg-grey-200">
          {readout.map((item) => (
            <div key={item.key} className="bg-paper py-3 pr-4">
              <dt className="text-xs text-grey-600">{item.label}</dt>
              <dd className="mt-1 font-display text-2xl tabular-nums">
                <VariantText field={item.key} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="mt-8">
        <DatasheetSlot
          productId={product.id}
          hasDatasheet={product.hasDatasheet}
        />
      </div>
    </div>
  );
}
