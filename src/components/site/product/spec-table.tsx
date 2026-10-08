// The full specification (ADR 0054, the sheet's green columns), set like an
// architect's spec document: group titles in the display face on the left,
// hairline rows on the right. One table per group, empty values hidden.

import type { ReactNode } from "react";

import { SpecValues } from "./spec-values";

export interface SpecTableGroup {
  title: string;
  rows: {
    key: string;
    label: string;
    /** Static values (extra specs) ... */
    values?: readonly string[];
    /** ... or a client leaf that follows the selected variant (P5). */
    content?: ReactNode;
  }[];
}

function GroupTable({
  group,
  captionPrefix,
}: {
  group: SpecTableGroup;
  captionPrefix: ReactNode;
}) {
  return (
    <div className="grid gap-3 border-t border-grey-300 pt-5 pb-8 md:grid-cols-[minmax(11rem,1fr)_3fr] md:gap-10">
      <h3 className="font-display text-2xl leading-tight font-light">
        {group.title}
      </h3>
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">
          {captionPrefix}: {group.title}
        </caption>
        <tbody>
          {group.rows.map((row) => (
            <tr
              key={row.key}
              data-spec={row.key}
              className="border-b border-grey-200 last:border-b-0"
            >
              <th
                scope="row"
                className="w-2/5 py-3 pr-4 align-top font-normal text-grey-600"
              >
                {row.label}
              </th>
              <td className="py-3 align-top">
                {row.content ?? (
                  <SpecValues values={row.values ?? []} size="compact" />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SpecTable({
  groups,
  captionPrefix,
  children,
}: {
  groups: readonly SpecTableGroup[];
  /** E.g. "Specifications of Arc AR-013A1"; each caption adds its group. */
  captionPrefix: ReactNode;
  /** Rendered after the groups: the reserved restricted-specs slot. */
  children?: ReactNode;
}) {
  return (
    <section
      id="specifications"
      aria-labelledby="specifications-heading"
      data-section="specifications"
      className="product-specs"
    >
      <h2
        id="specifications-heading"
        className="mb-8 font-display text-3xl font-light md:text-4xl"
      >
        Specifications
      </h2>
      {groups.length > 0 ? (
        groups.map((group, index) => (
          <GroupTable
            key={`${index}-${group.title}`}
            group={group}
            captionPrefix={captionPrefix}
          />
        ))
      ) : (
        <p className="text-sm text-grey-600">
          No further specifications are listed for this product.
        </p>
      )}
      {children}
    </section>
  );
}
