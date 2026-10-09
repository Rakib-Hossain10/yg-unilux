"use client";

// The search overlay (Phase 4b L6, plan Q9, ADR 0066), a lazy chunk opened
// by the header's search button. A native modal <dialog> sheet from the top:
// one large input (role="combobox") and a listbox of answers from
// GET /api/catalog/search, type-ahead from 2 characters, debounced 200 ms,
// earlier requests aborted, answers kept per query while the page lives.
//
// Keys: ArrowDown/ArrowUp move through the options (aria-activedescendant,
// focus stays in the input), Enter opens the active option or, with none,
// the full /search page; Escape closes and focus returns to the button.
// Options are links (role="option", tabindex -1), so a pointer can also open
// one in a new tab. The count is announced in a polite live region.
//
// Answers hold public card fields only (no spec value, rule 9); this file
// copies just the fields it shows (parseSearchAnswer).
// Hooks for the motion pass (L7): data-slot search-overlay /
// search-sheet / search-results, data-state.

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, useEffect, useId, useRef, useState } from "react";

import { cloudinaryDeliveryUrl } from "../cloudinary-delivery";
import { CloseIcon, SearchIcon } from "../icons";
import {
  isSearchable,
  parseSearchAnswer,
  resultSummary,
  SEARCH_INPUT_MAX_LENGTH,
  SEARCH_PATH,
  searchCategoryHref,
  searchPageHref,
  searchProductHref,
  tidyQuery,
  type SearchAnswer,
} from "./search-links";

const DEBOUNCE_MS = 200;
const SEARCH_ROUTE = "/api/catalog/search";

type SearchState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "done"; query: string; answer: SearchAnswer }
  | { status: "error"; query: string };

interface Option {
  key: string;
  href: string;
}

function optionsOf(state: SearchState): Option[] {
  if (state.status !== "done") return [];
  const { answer, query } = state;
  return [
    ...answer.products.map((hit) => ({
      key: `p-${hit.id}`,
      href: searchProductHref(hit),
    })),
    ...answer.categories.map((hit) => ({
      key: `c-${hit.id}`,
      href: searchCategoryHref(hit),
    })),
    { key: "all", href: searchPageHref(query) },
  ];
}

export function SearchOverlay({
  open,
  onClose,
  cloudName,
}: {
  open: boolean;
  /** Called once the dialog closed; `returnFocus` false after navigation. */
  onClose: (returnFocus: boolean) => void;
  cloudName: string | null;
}) {
  const router = useRouter();
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listId = `${baseId}-list`;
  const optionId = (key: string) => `${baseId}-opt-${key}`;

  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const request = useRef<AbortController | null>(null);
  const answers = useRef(new Map<string, SearchAnswer>());
  const navigating = useRef(false);
  const pressStart = useRef<EventTarget | null>(null);

  const [value, setValue] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const [active, setActive] = useState(-1);

  const options = optionsOf(state);

  // Open/close the native dialog with the prop; focus the input on open.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      navigating.current = false;
      dialog.showModal();
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      request.current?.abort();
    },
    [],
  );

  const close = () => dialogRef.current?.close();

  const go = (href: string) => {
    navigating.current = true;
    close();
    router.push(href);
  };

  const search = (raw: string) => {
    window.clearTimeout(timer.current);
    request.current?.abort();
    setActive(-1);
    const query = tidyQuery(raw);
    if (!isSearchable(query)) {
      setState({ status: "idle" });
      return;
    }
    const key = query.toLowerCase();
    const known = answers.current.get(key);
    if (known) {
      setState({ status: "done", query, answer: known });
      return;
    }
    setState({ status: "loading", query });
    timer.current = window.setTimeout(async () => {
      const controller = new AbortController();
      request.current = controller;
      try {
        const response = await fetch(
          `${SEARCH_ROUTE}?q=${encodeURIComponent(query)}`,
          {
            signal: controller.signal,
            headers: { accept: "application/json" },
          },
        );
        const answer = response.ok
          ? parseSearchAnswer(await response.json())
          : null;
        if (controller.signal.aborted) return;
        if (!answer) {
          setState({ status: "error", query });
          return;
        }
        answers.current.set(key, answer);
        setState({ status: "done", query, answer });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error", query });
      }
    }, DEBOUNCE_MS);
  };

  const moveTo = (index: number) => {
    setActive(index);
    const option = options[index];
    if (option) {
      document
        .getElementById(optionId(option.key))
        ?.scrollIntoView({ block: "nearest" });
    }
  };

  const expanded = options.length > 0;
  const activeOption = active >= 0 ? options[active] : undefined;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={`${baseId}-title`}
      data-slot="search-overlay"
      data-state={open ? "open" : "closed"}
      onClose={() => onClose(!navigating.current)}
      onKeyDown={(event) => {
        // Escape always closes the whole overlay (never just clears the input).
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
      onPointerDown={(event) => {
        pressStart.current = event.target;
      }}
      onClick={(event) => {
        // A press on the dimmed area (the dialog box itself) closes it; a
        // text selection dragged out of the input onto it does not.
        const dialog = dialogRef.current;
        if (event.target === dialog && pressStart.current === dialog) close();
      }}
      className="m-0 h-dvh max-h-none w-full max-w-none bg-transparent p-0 text-ink backdrop:bg-ink/40"
    >
      <div
        data-slot="search-sheet"
        className="flex max-h-dvh flex-col border-b border-grey-200 bg-paper md:max-h-[85dvh]"
      >
        <div className="mx-auto w-full max-w-(--container-site) px-4 md:px-8">
          <h2 id={`${baseId}-title`} className="sr-only">
            Search the catalog
          </h2>
          <form
            role="search"
            action={SEARCH_PATH}
            method="get"
            onSubmit={(event) => {
              event.preventDefault();
              if (activeOption) go(activeOption.href);
              else if (tidyQuery(value) !== "") go(searchPageHref(value));
            }}
            className="flex items-center gap-3 border-b border-grey-300 py-3 focus-within:border-ink md:gap-5 md:py-6"
          >
            <SearchIcon className="size-5 shrink-0 text-grey-600 md:size-6" />
            <label htmlFor={inputId} className="sr-only">
              Search products
            </label>
            <input
              ref={inputRef}
              id={inputId}
              name="q"
              type="text"
              role="combobox"
              aria-expanded={expanded}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                activeOption ? optionId(activeOption.key) : undefined
              }
              maxLength={SEARCH_INPUT_MAX_LENGTH}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="search"
              placeholder="Name, family or model no."
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                search(event.target.value);
              }}
              onKeyDown={(event) => {
                if (options.length === 0) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveTo(active + 1 >= options.length ? 0 : active + 1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveTo(active <= 0 ? options.length - 1 : active - 1);
                }
              }}
              className="min-w-0 flex-1 bg-transparent py-1 font-display text-3xl leading-tight font-light outline-none placeholder:text-grey-400 md:text-5xl"
            />
            <button
              type="button"
              aria-label="Close search"
              onClick={close}
              className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors duration-(--duration-quick) hover:bg-grey-100"
            >
              <CloseIcon />
            </button>
          </form>

          <p
            aria-live="polite"
            data-slot="search-status"
            className="min-h-11 pt-4 text-sm text-grey-600"
          >
            <StatusText state={state} />
          </p>
        </div>

        <div
          data-slot="search-results"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div
            id={listId}
            role="listbox"
            aria-label="Search results"
            className="mx-auto w-full max-w-(--container-site) px-4 pb-8 md:px-8"
          >
            {state.status === "done" ? (
              <Results
                state={state}
                cloudName={cloudName}
                activeKey={activeOption?.key ?? null}
                optionId={optionId}
                onPick={(event) => {
                  // A modified click opens a new tab: the overlay stays.
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey ||
                    event.button !== 0
                  ) {
                    return;
                  }
                  navigating.current = true;
                  close();
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
    </dialog>
  );
}

function StatusText({ state }: { state: SearchState }) {
  switch (state.status) {
    case "idle":
      return <>Type at least 2 characters.</>;
    case "loading":
      return <>Searching…</>;
    case "error":
      return <>Search could not load. Press Enter to open the results page.</>;
    case "done": {
      const { products, categories } = state.answer;
      const summary = resultSummary(products.length, categories.length);
      return (
        <>
          {summary} for “{state.query}”.
        </>
      );
    }
  }
}

const optionClass =
  "flex min-h-11 items-center gap-4 rounded-sm px-2 py-2 -mx-2 outline-none transition-colors duration-(--duration-quick) hover:bg-grey-50 aria-selected:bg-grey-100";

function Results({
  state,
  cloudName,
  activeKey,
  optionId,
  onPick,
}: {
  state: Extract<SearchState, { status: "done" }>;
  cloudName: string | null;
  activeKey: string | null;
  optionId: (key: string) => string;
  onPick: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { answer, query } = state;
  return (
    <>
      {answer.products.length > 0 ? (
        <div role="group" aria-label="Products" className="pt-2">
          <p aria-hidden="true" className="pb-2 text-sm text-grey-600">
            Products
          </p>
          <div className="grid gap-x-10 lg:grid-cols-2 xl:grid-cols-3">
            {answer.products.map((hit) => {
              const key = `p-${hit.id}`;
              const src = hit.image
                ? cloudinaryDeliveryUrl(cloudName, hit.image.publicId)
                : null;
              const code = hit.matchedModelNo ?? hit.modelCode;
              return (
                <Link
                  key={key}
                  id={optionId(key)}
                  href={searchProductHref(hit)}
                  role="option"
                  aria-selected={activeKey === key}
                  tabIndex={-1}
                  onClick={onPick}
                  data-search-product={hit.slug}
                  className={optionClass}
                >
                  <span className="relative block aspect-[4/5] w-11 shrink-0 overflow-hidden bg-grey-100">
                    {src ? (
                      <Image
                        src={src}
                        alt=""
                        fill
                        sizes="44px"
                        className="object-cover"
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-display text-xl leading-tight">
                      {hit.name}
                    </span>
                    <span className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-grey-600">
                      {hit.family &&
                      hit.family.toLowerCase() !== hit.name.toLowerCase() ? (
                        <span>{hit.family}</span>
                      ) : null}
                      {code ? (
                        <span className="tabular-nums">{code}</span>
                      ) : null}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      ) : null}

      {answer.categories.length > 0 ? (
        <div role="group" aria-label="Categories" className="pt-6">
          <p aria-hidden="true" className="pb-2 text-sm text-grey-600">
            Categories
          </p>
          {answer.categories.map((hit) => {
            const key = `c-${hit.id}`;
            return (
              <Link
                key={key}
                id={optionId(key)}
                href={searchCategoryHref(hit)}
                role="option"
                aria-selected={activeKey === key}
                tabIndex={-1}
                onClick={onPick}
                className={`${optionClass} text-[0.9375rem]`}
              >
                {hit.path.join(" › ")}
              </Link>
            );
          })}
        </div>
      ) : null}

      <div
        role="group"
        aria-label="More"
        className="mt-6 border-t border-grey-200 pt-2"
      >
        <Link
          id={optionId("all")}
          href={searchPageHref(query)}
          role="option"
          aria-selected={activeKey === "all"}
          tabIndex={-1}
          onClick={onPick}
          className={`${optionClass} text-[0.9375rem] text-ink underline decoration-grey-300 underline-offset-4`}
        >
          See all results for “{query}”
        </Link>
      </div>
    </>
  );
}
