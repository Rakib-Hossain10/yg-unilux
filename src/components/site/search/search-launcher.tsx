"use client";

// The header's search icon (Phase 4b L6, plan Q9). Server HTML and no-JS: a
// link to the /search page. Once React runs it becomes a button that opens
// the search overlay, a separate chunk loaded on first use (warmed on hover
// or focus of the icon). Modifier clicks never apply to a button, so the
// /search page stays reachable from its own form.

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRef, useState } from "react";

import { SearchIcon } from "../icons";
import { useHydrated } from "../listing/use-hydrated";
import { SEARCH_PATH } from "./search-links";

const loadOverlay = () => import("./search-overlay");

const SearchOverlay = dynamic(
  () => loadOverlay().then((module) => module.SearchOverlay),
  { ssr: false },
);

export function SearchLauncher({
  className,
  cloudName,
}: {
  className: string;
  /** For result thumbnails (public, read on the server). */
  cloudName: string | null;
}) {
  const hydrated = useHydrated();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  if (!hydrated) {
    return (
      <Link href={SEARCH_PATH} aria-label="Search" className={className}>
        <SearchIcon />
      </Link>
    );
  }

  const warm = () => {
    void loadOverlay();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Search"
        aria-haspopup="dialog"
        data-slot="search-trigger"
        onPointerEnter={warm}
        onFocus={warm}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
        className={`${className} cursor-pointer`}
      >
        <SearchIcon />
      </button>
      {mounted ? (
        <SearchOverlay
          open={open}
          cloudName={cloudName}
          onClose={(returnFocus) => {
            setOpen(false);
            if (returnFocus) buttonRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
