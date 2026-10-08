"use client";

// The dynamic restricted block of the product page (plan P7, ADR 0002, 0062,
// 0064): after hydration it asks /api/catalog/restricted/[productId] (per
// viewer, `private, no-store`) once, then fills the two reserved slots, the
// datasheet button in the panel and the restricted rows under the table.

/*
 * Rule 9: nothing restricted is in the static HTML or the RSC payload. The
 * server render and the first client render show only the slot's fallback
 * line (visitor text); the answer lives in client memory after the fetch.
 * Any failure (network, non-200, unknown shape) keeps the fallback.
 */

import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { DatasheetButton } from "./datasheet-button";
import { useOptionalVariantSelection } from "./product-detail-client";
import {
  loadRestrictedAnswer,
  restrictedRows,
  restrictedSlotView,
  restrictedSpecsFor,
  type RestrictedAnswer,
} from "./restricted-data";
import { SpecValues } from "./spec-values";

interface RestrictedState {
  productId: string;
  /** null until a valid answer arrived (or forever, after a failure). */
  answer: RestrictedAnswer | null;
}

const RestrictedContext = createContext<RestrictedState | null>(null);

/** Fetches the viewer's answer once per product and shares it with both slots. */
export function RestrictedDataProvider({
  productId,
  children,
}: {
  productId: string;
  children: ReactNode;
}) {
  const [loaded, setLoaded] = useState<{
    productId: string;
    answer: RestrictedAnswer;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    // Any failure resolves null: the fallback line stays.
    void loadRestrictedAnswer(productId, controller.signal).then((answer) => {
      if (answer) setLoaded({ productId, answer });
    });
    return () => controller.abort();
  }, [productId]);

  // An answer for another product (client navigation) is never shown.
  const answer = loaded?.productId === productId ? loaded.answer : null;
  const value = useMemo(() => ({ productId, answer }), [productId, answer]);
  return <RestrictedContext value={value}>{children}</RestrictedContext>;
}

/** The datasheet button for this viewer, or the fallback until it is known. */
export function DatasheetBlock({ fallback }: { fallback: ReactNode }) {
  const restricted = use(RestrictedContext);
  if (!restricted?.answer) return fallback;
  return (
    <DatasheetButton
      state={restricted.answer.state}
      productId={restricted.productId}
    />
  );
}

const textLink =
  "inline-flex min-h-11 items-center text-ink underline decoration-grey-400 underline-offset-4 transition-colors duration-(--duration-quick) hover:decoration-ink";

const notApplicable = (
  <span className="text-grey-600">
    <span aria-hidden="true">–</span>
    <span className="sr-only">Not applicable for this model</span>
  </span>
);

const sameValues = (a?: readonly string[], b?: readonly string[]) =>
  (a ?? []).join("\u0000") === (b ?? []).join("\u0000");

function RestrictedRows({
  answer,
}: {
  answer: Extract<RestrictedAnswer, { allowed: true }>;
}) {
  const selection = useOptionalVariantSelection();
  const index = selection?.index ?? 0;
  const current = selection?.variants[index];
  const specs = restrictedSpecsFor(answer, index, current?.modelNo);
  const previous =
    selection && selection.previous !== null
      ? restrictedSpecsFor(
          answer,
          selection.previous,
          selection.variants[selection.previous]?.modelNo,
        )
      : null;
  const rows = restrictedRows(answer);

  if (rows.length === 0) {
    return (
      <p data-restricted="empty">
        No customer-only specifications are listed for this product.
      </p>
    );
  }

  return (
    <div
      data-restricted="loaded"
      className="grid gap-3 md:grid-cols-[minmax(11rem,1fr)_3fr] md:gap-10"
    >
      <h3 className="font-display text-2xl leading-tight font-light text-ink">
        For approved customers
      </h3>
      <table className="w-full border-collapse text-left text-sm text-ink">
        <caption className="sr-only">
          Specifications for approved customers
          {current?.modelNo ? `: ${current.modelNo}` : ""}
        </caption>
        <tbody>
          {rows.map((row) => {
            const values = specs[row.key] ?? [];
            const changed =
              previous !== null && !sameValues(previous[row.key], values);
            return (
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
                  <div
                    key={changed ? `changed-${index}` : "static"}
                    data-changed={changed ? "" : undefined}
                    className="variant-value"
                  >
                    {values.length > 0 ? (
                      <SpecValues values={values} size="compact" />
                    ) : (
                      notApplicable
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The restricted rows for an allowed viewer (following the selected
 * variant), the "access expired" line for an expired or blocked customer,
 * otherwise the fallback (sign in).
 */
export function RestrictedSpecsBlock({ fallback }: { fallback: ReactNode }) {
  const restricted = use(RestrictedContext);
  const answer = restricted?.answer;
  if (answer?.allowed) return <RestrictedRows answer={answer} />;
  if (restrictedSlotView(answer) === "expired") {
    return (
      <p data-restricted="expired">
        Some specifications are shared with approved customers only, and your
        access has ended.{" "}
        <a href="/contact" className={textLink}>
          Access expired — contact us
        </a>
      </p>
    );
  }
  return fallback;
}
