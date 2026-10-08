"use client";

// Small screens: a "Filters (n)" button opening the filter form in a native
// modal <dialog> sheet (focus trap, Esc and inert background from the
// browser). Changes apply as they are made; "Show n products" closes the
// sheet. Without JavaScript the button is hidden and the page shows the
// desktop rail inline instead (`noscript:` = @media (scripting: none)).

import Link from "next/link";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { CloseIcon } from "../icons";

const LG_QUERY = "(min-width: 64rem)";

export function FilterSheet({
  activeCount,
  total,
  clearHref,
  children,
}: {
  /** Selected filter values (the button's badge). */
  activeCount: number;
  /** Products matching the applied filters. */
  total: number;
  /** "Clear all" target, or null when nothing is selected. */
  clearHref: string | null;
  /** The filter form (a FilterForm). */
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  // The rail takes over from lg: a sheet left open by a resize closes.
  useEffect(() => {
    const query = window.matchMedia(LG_QUERY);
    const onChange = () => {
      if (query.matches) dialogRef.current?.close();
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const open = () => dialogRef.current?.showModal();
  const close = () => dialogRef.current?.close();

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        className="inline-flex h-11 items-center gap-2 border border-grey-300 px-4 text-sm text-ink transition-colors duration-(--duration-quick) hover:border-ink lg:hidden noscript:hidden"
      >
        Filters
        {activeCount > 0 ? (
          <span className="tabular-nums">({activeCount})</span>
        ) : null}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={headingId}
        data-slot="filter-sheet"
        // A press on the backdrop (the dialog box itself, outside the panel) closes.
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        onClose={() => buttonRef.current?.focus()}
        className="filter-sheet fixed inset-0 m-0 mt-auto h-[min(100dvh-2.5rem,52rem)] max-h-none w-full max-w-none flex-col bg-paper p-0 text-ink backdrop:bg-ink/45 open:flex"
      >
        <div className="flex items-center justify-between border-b border-grey-200 px-4 py-2">
          <h2 id={headingId} className="font-display text-2xl font-light">
            Filters
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close filters"
            className="inline-flex size-11 items-center justify-center rounded-full transition-colors duration-(--duration-quick) hover:bg-grey-100"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5">
          {children}
        </div>
        <div className="flex items-center gap-4 border-t border-grey-200 px-4 py-3">
          {clearHref ? (
            <Link
              href={clearHref}
              scroll={false}
              className="inline-flex min-h-11 items-center text-sm text-ink underline decoration-grey-400 underline-offset-4 hover:decoration-ink"
            >
              Clear all
            </Link>
          ) : null}
          <button
            type="button"
            onClick={close}
            className="ml-auto inline-flex h-11 items-center justify-center bg-ink px-6 text-sm text-paper transition-colors duration-(--duration-quick) hover:bg-grey-800"
          >
            Show {total} {total === 1 ? "product" : "products"}
          </button>
        </div>
      </dialog>
    </>
  );
}
