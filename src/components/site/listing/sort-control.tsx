"use client";

// The listing sort (plan Q5): a small GET form of its own that carries the
// applied filters as hidden fields, so it works without JavaScript (the
// "Sort" button submits it). Once hydrated the button is gone and a change
// applies at once through router.replace.

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { beginListingRefine } from "@/components/motion/listing/filter-transition";

import { formHref } from "./form-query";
import { useHydrated } from "./use-hydrated";

export interface SortOption {
  value: string;
  label: string;
}

export function SortControl({
  idPrefix,
  action,
  options,
  sort,
  hiddenFields,
}: {
  idPrefix: string;
  /** The listing path the form submits to (GET). */
  action: string;
  options: readonly SortOption[];
  sort: string;
  /** The applied filters as name/value pairs (page left out). */
  hiddenFields: readonly (readonly [string, string])[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [, startTransition] = useTransition();
  const selectId = `${idPrefix}-sort`;
  // Controlled, reset when the applied sort changes (a chip or the back
  // button); never remounted, so keyboard focus stays on the select.
  const [state, setState] = useState({ applied: sort, value: sort });
  let value = state.value;
  if (state.applied !== sort) {
    value = sort;
    setState({ applied: sort, value });
  }

  const apply = (form: HTMLFormElement) => {
    const href = formHref(action, new FormData(form));
    beginListingRefine(form);
    startTransition(() => {
      router.replace(href, { scroll: false });
    });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    apply(event.currentTarget);
  };

  return (
    <form
      method="get"
      action={action}
      onSubmit={onSubmit}
      data-slot="sort-control"
      className="flex items-center gap-3"
    >
      {hiddenFields.map(([field, fieldValue]) => (
        <input
          key={`${field}=${fieldValue}`}
          type="hidden"
          name={field}
          value={fieldValue}
        />
      ))}
      <label
        htmlFor={selectId}
        className="sr-only text-sm text-grey-600 sm:not-sr-only"
      >
        Sort by
      </label>
      {/* The browser's arrow replaced by the site's chevron (ui-reviewer
          gate C, L-8); the chevron ignores the pointer. */}
      <span className="relative inline-flex">
        <select
          id={selectId}
          name="sort"
          value={value}
          onChange={(event) => {
            setState({ applied: sort, value: event.currentTarget.value });
            if (event.currentTarget.form) apply(event.currentTarget.form);
          }}
          className="h-11 cursor-pointer appearance-none border border-grey-300 bg-paper pr-10 pl-3 text-sm text-ink transition-colors duration-(--duration-quick) hover:border-ink"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <svg
          viewBox="0 0 12 12"
          width={10}
          height={10}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          aria-hidden="true"
          focusable="false"
          className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-grey-700"
        >
          <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
        </svg>
      </span>
      {hydrated ? null : (
        <button
          type="submit"
          className="inline-flex h-11 items-center border border-ink px-4 text-sm transition-colors duration-(--duration-quick) hover:bg-ink hover:text-paper"
        >
          Sort
        </button>
      )}
    </form>
  );
}
