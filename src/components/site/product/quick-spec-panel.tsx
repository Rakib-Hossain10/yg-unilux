// The quick-spec panel beside the gallery (ADR 0054, the sheet's pink
// columns): family, title, type, the shown variant's Model No., the "quick"
// columns read from SPEC_COLUMNS, the output readout and the datasheet slot.

import type { PublicProductView } from "@/lib/catalog/view";

import {
  displaySpecs,
  displayVariant,
  quickSpecRows,
  READOUT_KEYS,
  specLabel,
} from "./product-display";
import { DatasheetSlot } from "./restricted-slots";
import { SpecValues } from "./spec-values";

/*
 * Static HTML always shows variant 1 (plan Q3). The P5 switcher updates the
 * elements marked data-field="model-no" / data-readout on the client.
 */
export function QuickSpecPanel({ product }: { product: PublicProductView }) {
  const variant = displayVariant(product);
  const specs = displaySpecs(product);
  const rows = quickSpecRows(specs);
  const modelNo = variant?.modelNo ?? product.modelCode;
  const readout = READOUT_KEYS.flatMap((key) => {
    const values = specs[key];
    return values && values.length > 0
      ? [{ key, label: specLabel(key), value: values.join(", ") }]
      : [];
  });
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
        {modelNo ? (
          <div className="flex items-baseline justify-between gap-6 border-y border-ink py-4">
            <dt className="text-grey-600">Model No.</dt>
            <dd
              data-field="model-no"
              className="text-lg font-medium tracking-[0.04em] tabular-nums"
            >
              {modelNo}
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
              <SpecValues values={row.values} />
            </dd>
          </div>
        ))}
      </dl>

      {product.variants.length > 1 ? (
        // P5 mounts the optic switcher here (plan "Variant switcher spec").
        <div data-slot="variant-switcher" className="mt-6 text-sm">
          <p className="text-grey-600">
            Available in {product.variants.length} models.{" "}
            <a
              href="#models"
              className="inline-flex min-h-11 items-center text-ink underline decoration-grey-400 underline-offset-4 hover:decoration-ink"
            >
              Compare models
            </a>
          </p>
        </div>
      ) : null}

      {readout.length > 0 ? (
        <dl data-readout className="mt-6 grid grid-cols-2 gap-px bg-grey-200">
          {readout.map((item) => (
            <div key={item.key} className="bg-paper py-3 pr-4">
              <dt className="text-xs text-grey-600">{item.label}</dt>
              <dd
                data-field={item.key}
                className="mt-1 font-display text-2xl tabular-nums"
              >
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="mt-8">
        <DatasheetSlot hasDatasheet={product.hasDatasheet} />
      </div>
    </div>
  );
}
