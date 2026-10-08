// The Models table (plan Q3): every variant of the product in the cached
// HTML, with its option name, light output and any other public value that
// differs. Crawlers see every model no.; buyers get a quick comparison.

import type { PublicVariantView } from "@/lib/catalog/view";
import type { SpecKey } from "@/models/spec-columns";

import { modelsTableColumns, specLabel, variantName } from "./product-display";

/*
 * P5 makes each row select its variant (data-variant-index is the hook); in
 * the static page the rows are plain data. The scroll box is focusable so a
 * wide table can be scrolled by keyboard at 360 px without page scroll.
 */
export function ModelsTable({
  variants,
  productTitle,
}: {
  variants: readonly PublicVariantView[];
  productTitle: string;
}) {
  if (variants.length < 2) return null;
  const columns: SpecKey[] = modelsTableColumns(variants);
  const hasLabels = variants.some((variant) => variant.label);

  return (
    <section
      id="models"
      aria-labelledby="models-heading"
      data-section="models"
      className="scroll-mt-24"
    >
      <h2
        id="models-heading"
        className="mb-8 font-display text-3xl font-light md:text-4xl"
      >
        Models
      </h2>
      <div
        role="region"
        aria-labelledby="models-heading"
        tabIndex={0}
        className="overflow-x-auto"
      >
        <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
          <caption className="sr-only">
            All models of {productTitle} ({variants.length})
          </caption>
          <thead>
            <tr className="border-b border-ink">
              <th scope="col" className="py-3 pr-6 font-normal text-grey-600">
                Model No.
              </th>
              {hasLabels ? (
                <th scope="col" className="py-3 pr-6 font-normal text-grey-600">
                  Option
                </th>
              ) : null}
              {columns.map((key) => (
                <th
                  key={key}
                  scope="col"
                  className="py-3 pr-6 font-normal text-grey-600"
                >
                  {specLabel(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {variants.map((variant, index) => (
              <tr
                key={variant.modelNo}
                data-variant-index={index}
                className="border-b border-grey-200"
              >
                <th
                  scope="row"
                  className="py-3 pr-6 font-medium whitespace-nowrap tabular-nums"
                >
                  {variant.modelNo}
                </th>
                {hasLabels ? (
                  <td className="py-3 pr-6">{variantName(variant)}</td>
                ) : null}
                {columns.map((key) => (
                  <td key={key} className="py-3 pr-6 tabular-nums">
                    {variant.specs[key]?.join(", ") || (
                      <span className="text-grey-600">
                        <span aria-hidden="true">–</span>
                        <span className="sr-only">Not applicable</span>
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
