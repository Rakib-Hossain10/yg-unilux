"use client";

// The listing filter form (plan Q3, a11y rules): a GET form of fieldsets
// with one checkbox per facet value. Without JavaScript the visible "Apply
// filters" button submits it as a plain GET (shareable, back-button safe).
// Once hydrated the button is gone and every change applies at once through
// router.replace (no scroll jump), and a polite live region announces the
// new result count. Rendered twice per page (desktop rail, mobile sheet), so
// every id carries `idPrefix`.

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { formHref } from "./form-query";
import { useHydrated } from "./use-hydrated";

export interface FilterFormOption {
  /** The URL token (listing-params). */
  value: string;
  label: string;
  /** Products in the whole listing scope with this value. */
  count: number;
}

export interface FilterFormGroup {
  /** The query key (cct, cri, beam, ugr, w, ip, track, cat). */
  param: string;
  label: string;
  options: FilterFormOption[];
}

const tokenOf = (param: string, value: string) => `${param}=${value}`;

const productsLabel = (n: number) => `${n} ${n === 1 ? "product" : "products"}`;

export function FilterForm({
  idPrefix,
  action,
  groups,
  selected,
  sort,
  appliedKey,
  total,
}: {
  idPrefix: string;
  /** The listing path the form submits to (GET). */
  action: string;
  groups: readonly FilterFormGroup[];
  /** The applied values, as "param=value" tokens. */
  selected: readonly string[];
  /** The applied sort; carried as a hidden field so filtering keeps it. */
  sort: string;
  /** The applied canonical query: a change resets the boxes to it. */
  appliedKey: string;
  /** Products matching the applied filters (announced after a change). */
  total: number;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, startTransition] = useTransition();
  const [changed, setChanged] = useState(false);
  // Controlled boxes: a chip, "Clear all" or the back button changes the
  // applied query, and the boxes follow it without remounting the form
  // (focus stays on the box the visitor just used).
  const [state, setState] = useState(() => ({
    key: appliedKey,
    checked: new Set(selected),
  }));
  let checked = state.checked;
  if (state.key !== appliedKey) {
    checked = new Set(selected);
    setState({ key: appliedKey, checked });
  }

  const apply = (form: HTMLFormElement) => {
    const href = formHref(action, new FormData(form));
    setChanged(true);
    startTransition(() => {
      router.replace(href, { scroll: false });
    });
  };

  const onToggle = (
    token: string,
    on: boolean,
    form: HTMLFormElement | null,
  ) => {
    const next = new Set(checked);
    if (on) next.add(token);
    else next.delete(token);
    setState({ key: appliedKey, checked: next });
    if (form) apply(form);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    apply(event.currentTarget);
  };

  return (
    <form
      id={`${idPrefix}-form`}
      method="get"
      action={action}
      onSubmit={onSubmit}
      data-slot="filter-form"
      data-pending={pending ? "" : undefined}
    >
      {sort !== "catalog" ? (
        <input type="hidden" name="sort" value={sort} />
      ) : null}
      {groups.map((group) => {
        return (
          <fieldset
            key={group.param}
            className="min-w-0 border-t border-grey-200 py-5 first-of-type:border-t-0 first-of-type:pt-0"
          >
            <legend className="float-left w-full text-sm font-medium text-ink">
              {group.label}
            </legend>
            <ul className="clear-both pt-2">
              {group.options.map((option) => {
                const token = tokenOf(group.param, option.value);
                const inputId = `${idPrefix}-${group.param}-${option.value}`;
                return (
                  <li key={option.value}>
                    <label
                      htmlFor={inputId}
                      className="group flex min-h-11 cursor-pointer items-center gap-3 text-[0.9375rem] text-grey-800 hover:text-ink"
                    >
                      <input
                        id={inputId}
                        type="checkbox"
                        name={group.param}
                        value={option.value}
                        checked={checked.has(token)}
                        onChange={(event) =>
                          onToggle(
                            token,
                            event.currentTarget.checked,
                            event.currentTarget.form,
                          )
                        }
                        className="size-4 shrink-0 cursor-pointer accent-ink"
                      />
                      <span className="min-w-0 flex-1 break-words">
                        {option.label}
                      </span>
                      <span className="text-sm text-grey-600 tabular-nums">
                        {option.count}
                        <span className="sr-only">
                          {option.count === 1 ? " product" : " products"}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
      {hydrated ? null : (
        <button
          type="submit"
          className="mt-6 inline-flex h-11 w-full items-center justify-center bg-ink px-6 text-sm text-paper transition-colors duration-(--duration-quick) hover:bg-grey-800"
        >
          Apply filters
        </button>
      )}
      {/* Empty until the visitor changes something; cleared while the new
          page loads so the same count is announced again. */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {changed && !pending ? `${productsLabel(total)} found` : ""}
      </p>
    </form>
  );
}
