// The Models table (plan Q3): every variant of the product in the cached
// HTML, with its option name, light output and any other public value that
// differs. Crawlers see every model no.; buyers get a quick comparison.

import type { PublicVariantView } from "@/lib/catalog/view";
import type { SpecKey } from "@/models/spec-columns";

import { SelectVariantButton, VariantTableRow } from "./product-detail-client";
import { modelsTableColumns, specLabel, variantName } from "./product-display";

/*
 * Figures compared down a column (ui-reviewer M-5): right-aligned with lining,
 * tabular numerals so the digits line up row to row.
 */
const NUMERIC_COLUMNS: ReadonlySet<SpecKey> = new Set<SpecKey>([
  "wattage",
  "lumenOutput",
  "lumenEfficiency",
]);
const cellAlign = (key: SpecKey) =>
  NUMERIC_COLUMNS.has(key) ? "text-right lining-nums tabular-nums" : "";

/*
 * Rows are plain server data; only the row wrapper (selected state) and the
 * last cell's "Select" button are client leaves (P5). The scroll box is
 * focusable so a wide table scrolls by keyboard at 360 px; it is `relative`
 * so sr-only text inside cannot widen the page (P5 check at 360 px).
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
        className="relative overflow-x-auto"
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
                  className={`py-3 pr-6 font-normal text-grey-600 ${cellAlign(key)}`}
                >
                  {specLabel(key)}
                </th>
              ))}
              <th scope="col" className="py-3 font-normal">
                <span className="sr-only">Select this model</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {variants.map((variant, index) => (
              <VariantTableRow
                key={variant.modelNo}
                index={index}
                className="border-b border-grey-200 transition-colors duration-(--duration-quick) data-selected:bg-grey-50"
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
                  <td key={key} className={`py-3 pr-6 ${cellAlign(key)}`}>
                    {variant.specs[key]?.join(", ") || (
                      <span className="text-grey-600">
                        <span aria-hidden="true">–</span>
                        <span className="sr-only">Not applicable</span>
                      </span>
                    )}
                  </td>
                ))}
                <td className="py-1 pr-2 text-right">
                  <SelectVariantButton
                    index={index}
                    modelNo={variant.modelNo}
                  />
                </td>
              </VariantTableRow>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
