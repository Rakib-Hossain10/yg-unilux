"use client";

// The one piece of client state on the product page: which variant is shown.
// A context provider around the server-rendered product block, plus tiny leaf
// components that print the selected variant's values (plan P5, ADR 0064).

/*
 * The server (and the first client render) always shows variant 1, so the
 * ISR HTML hydrates without a mismatch; `?model=` is read from location after
 * hydration (useSyncExternalStore with a null server snapshot). A switch
 * updates the URL with history.replaceState: no navigation, no scroll, no
 * server request. Only public values are ever passed in (rule 9).
 */

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { ValueCrossfade } from "@/components/motion/product/value-crossfade";
import type { SpecKey } from "@/models/spec-columns";

import { SpecValues } from "./spec-values";
import {
  modelFromSearch,
  urlWithModel,
  valueChanged,
  variantAnnouncement,
  variantIndexForModel,
  type SwitchVariant,
} from "./variant-selection";

interface VariantSelection {
  variants: readonly SwitchVariant[];
  index: number;
  /** The variant shown before the last switch; null until the user switches. */
  previous: number | null;
  /** The live-region text; empty until the user switches. */
  announcement: string;
  select: (index: number) => void;
}

/** The id of a switcher radio (one product per page). */
export const variantOptionId = (index: number): string =>
  `variant-option-${index}`;

const VariantContext = createContext<VariantSelection | null>(null);

/** The selected variant and the switch action (for the switcher, P6 gallery). */
export function useVariantSelection(): VariantSelection {
  const value = use(VariantContext);
  if (!value)
    throw new Error("useVariantSelection outside ProductDetailClient");
  return value;
}

/**
 * The selection when inside ProductDetailClient, else null: the gallery uses
 * it to follow the switch but also works on its own (no variants).
 */
export function useOptionalVariantSelection(): VariantSelection | null {
  return use(VariantContext);
}

/* Back/forward between hash anchors fires popstate; nothing else changes it. */
function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}
const readModelParam = () => modelFromSearch(window.location.search);
const serverModelParam = () => null;

export function ProductDetailClient({
  variants,
  children,
}: {
  variants: readonly SwitchVariant[];
  children: ReactNode;
}) {
  const urlModel = useSyncExternalStore(
    subscribe,
    readModelParam,
    serverModelParam,
  );
  const fromUrl = variantIndexForModel(variants, urlModel);
  const [choice, setChoice] = useState<{
    index: number;
    previous: number;
  } | null>(null);
  const index = choice?.index ?? fromUrl ?? 0;

  // An unknown ?model= falls back to variant 1; drop it so a copied link
  // does not carry a model no. the page is not showing.
  useEffect(() => {
    if (urlModel !== null && fromUrl === null) {
      window.history.replaceState(
        null,
        "",
        urlWithModel(window.location.href, null),
      );
    }
  }, [urlModel, fromUrl]);

  const select = useCallback(
    (next: number) => {
      const variant = variants[next];
      if (!variant || next === index) return;
      setChoice({ index: next, previous: index });
      window.history.replaceState(
        null,
        "",
        urlWithModel(window.location.href, variant.modelNo),
      );
    },
    [variants, index],
  );

  const value = useMemo<VariantSelection>(() => {
    const current = variants[index];
    return {
      variants,
      index,
      previous: choice?.previous ?? null,
      announcement: choice && current ? variantAnnouncement(current) : "",
      select,
    };
  }, [variants, index, choice, select]);

  return <VariantContext value={value}>{children}</VariantContext>;
}

type Field = "model-no" | SpecKey;

/* Changed since the last switch: drives the short highlight (CSS). */
function useField(field: Field) {
  const { variants, index, previous } = useVariantSelection();
  const current = variants[index];
  const before = previous !== null ? variants[previous] : undefined;
  const changed = previous !== null && valueChanged(field, before, current);
  return { current, before, changed, index };
}

/* The single-line text of one field of a variant ("" = not applicable). */
const fieldText = (field: Field, variant: SwitchVariant | undefined) =>
  field === "model-no"
    ? (variant?.modelNo ?? "")
    : (variant?.specs[field] ?? []).join(", ");

const notApplicable = (
  <span className="text-grey-600">
    <span aria-hidden="true">–</span>
    <span className="sr-only">Not applicable for this model</span>
  </span>
);

/**
 * A single line value of the selected variant (Model No., lumen readout).
 * Carries data-field for tests and the motion pass; re-keyed when the value
 * changes so the highlight and the readout crossfade (P8) restart.
 */
export function VariantText({
  field,
  className,
}: {
  field: Field;
  className?: string;
}) {
  const { current, before, changed, index } = useField(field);
  const value = (
    <span
      key={changed ? `changed-${index}` : "static"}
      data-field={field}
      data-changed={changed ? "" : undefined}
      className={`variant-value ${className ?? ""}`.trim()}
    >
      {fieldText(field, current) || notApplicable}
    </span>
  );
  // The server HTML (and every unchanged value) is the bare span; only a
  // value changed by a switch gets the crossfade wrapper (same in every
  // motion setting, so the final DOM does not depend on it).
  if (!changed) return value;
  return (
    <ValueCrossfade
      key={`changed-${index}`}
      previous={fieldText(field, before) || "–"}
    >
      {value}
    </ValueCrossfade>
  );
}

/** One spec cell of the selected variant: a value or a list of options. */
export function VariantSpecValues({
  specKey,
  size,
}: {
  specKey: SpecKey;
  size?: "default" | "compact";
}) {
  const { current, changed, index } = useField(specKey);
  const values = current?.specs[specKey] ?? [];
  return (
    <div
      key={changed ? `changed-${index}` : "static"}
      data-changed={changed ? "" : undefined}
      className="variant-value"
    >
      {values.length > 0 ? (
        <SpecValues values={values} size={size} />
      ) : (
        notApplicable
      )}
    </div>
  );
}

/** The selected model no. as plain text (captions; no hooks for motion). */
export function SelectedModelNo() {
  const { variants, index } = useVariantSelection();
  return <>{variants[index]?.modelNo ?? ""}</>;
}

/** A Models table row that knows whether it is the shown variant. */
export function VariantTableRow({
  index,
  className,
  children,
}: {
  index: number;
  className?: string;
  children: ReactNode;
}) {
  const selection = useVariantSelection();
  const selected = selection.index === index;
  return (
    <tr
      data-variant-index={index}
      data-selected={selected ? "" : undefined}
      className={className}
    >
      {children}
    </tr>
  );
}

/* Respect the visitor's motion setting for the scroll back to the panel. */
const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";

/**
 * "Select" in a Models table row: selects that variant and takes the visitor
 * to the switcher, focusing its radio (the panel shows the result there).
 * The selected row says "Selected" as plain text: there is nothing to do
 * there (ui-reviewer M-5). Focus never sits on it when it turns to text: the
 * click moves focus to the radio first.
 */
export function SelectVariantButton({
  index,
  modelNo,
}: {
  index: number;
  modelNo: string;
}) {
  const selection = useVariantSelection();
  const selected = selection.index === index;
  const onClick = () => {
    selection.select(index);
    const radio = document.getElementById(variantOptionId(index));
    if (radio instanceof HTMLInputElement) {
      radio.focus({ preventScroll: true });
      radio
        .closest("fieldset")
        ?.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
    }
  };
  if (selected) {
    return (
      <span className="inline-flex min-h-11 items-center text-sm text-grey-600">
        Selected
        <span className="sr-only"> {modelNo}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 min-w-11 items-center text-sm text-ink underline decoration-grey-400 underline-offset-4 transition-colors duration-(--duration-quick) hover:decoration-ink"
    >
      Select
      <span className="sr-only"> {modelNo}</span>
    </button>
  );
}
