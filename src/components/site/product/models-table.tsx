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
 * Below md the table is stacked (4a polish M-4): each model is a block with
 * its model no. and "Select" on the first line and one "label  value" line
 * per column under it, so nothing scrolls sideways at 360 px. It stays one
 * <table> (one copy of every model no. in the HTML); the table roles are
 * restated because changing a table element's CSS display drops its implicit
 * role in some browsers. The visible labels in stacked cells are aria-hidden:
 * screen readers already get the column header from the table.
 *
 * Rows are plain server data; only the row wrapper (selected state) and the
 * last cell's "Select" button are client leaves (P5). From md the scroll box
 * is focusable so a wide table scrolls by keyboard; it is `relative` so
 * sr-only text inside cannot widen the page (P5 check at 360 px).
 */
const headCell = "py-3 pr-6 font-normal text-grey-600";
const stackedCell =
  "max-md:col-span-2 max-md:flex max-md:items-baseline max-md:justify-between max-md:gap-4 max-md:py-1.5 max-md:text-right md:py-3 md:pr-6";

function StackedLabel({ children }: { children: string }) {
  return (
    <span
      aria-hidden="true"
      className="shrink-0 text-left text-grey-600 md:hidden"
    >
      {children}
    </span>
  );
}

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
        data-slot="models-scroll"
        className="relative md:overflow-x-auto"
      >
        <table
          role="table"
          className="w-full border-collapse text-left text-sm max-md:block md:min-w-[32rem]"
        >
          <caption className="sr-only">
            All models of {productTitle} ({variants.length})
          </caption>
          {/* Below md the header row is kept for screen readers only; the
              stacked cells show their own labels. */}
          <thead role="rowgroup" className="max-md:sr-only">
            <tr role="row" className="border-b border-ink">
              <th scope="col" role="columnheader" className={headCell}>
                Model No.
              </th>
              {hasLabels ? (
                <th scope="col" role="columnheader" className={headCell}>
                  Option
                </th>
              ) : null}
              {columns.map((key) => (
                <th
                  key={key}
                  scope="col"
                  role="columnheader"
                  className={`${headCell} ${cellAlign(key)}`}
                >
                  {specLabel(key)}
                </th>
              ))}
              <th scope="col" role="columnheader" className="py-3 font-normal">
                <span className="sr-only">Select this model</span>
              </th>
            </tr>
          </thead>
          <tbody
            role="rowgroup"
            className="max-md:block max-md:border-t max-md:border-ink"
          >
            {variants.map((variant, index) => (
              <VariantTableRow
                key={variant.modelNo}
                index={index}
                className="border-b border-grey-200 transition-colors duration-(--duration-quick) max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:items-center max-md:gap-x-4 max-md:px-3 max-md:pt-2 max-md:pb-3 data-selected:bg-grey-50"
              >
                <th
                  scope="row"
                  role="rowheader"
                  className="py-3 pr-6 font-medium whitespace-nowrap tabular-nums max-md:block max-md:min-w-0 max-md:text-base max-md:break-words max-md:whitespace-normal"
                >
                  {variant.modelNo}
                </th>
                {hasLabels ? (
                  <td role="cell" className={stackedCell}>
                    <StackedLabel>Option</StackedLabel>
                    {variantName(variant)}
                  </td>
                ) : null}
                {columns.map((key) => (
                  <td
                    key={key}
                    role="cell"
                    className={`${stackedCell} ${cellAlign(key)}`}
                  >
                    <StackedLabel>{specLabel(key)}</StackedLabel>
                    {variant.specs[key]?.join(", ") || (
                      <span className="text-grey-600">
                        <span aria-hidden="true">–</span>
                        <span className="sr-only">Not applicable</span>
                      </span>
                    )}
                  </td>
                ))}
                <td
                  role="cell"
                  className="py-1 pr-2 text-right max-md:col-start-2 max-md:row-start-1 max-md:block max-md:p-0"
                >
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
