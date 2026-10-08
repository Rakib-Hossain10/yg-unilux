"use client";

// The listing sort (plan Q5): a small GET form of its own that carries the
// applied filters as hidden fields, so it works without JavaScript (the
// "Sort" button submits it). Once hydrated the button is gone and a change
// applies at once through router.replace.

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

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
      <select
        id={selectId}
        name="sort"
        value={value}
        onChange={(event) => {
          setState({ applied: sort, value: event.currentTarget.value });
          if (event.currentTarget.form) apply(event.currentTarget.form);
        }}
        className="h-11 cursor-pointer border border-grey-300 bg-paper pr-8 pl-3 text-sm text-ink transition-colors duration-(--duration-quick) hover:border-ink"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
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
