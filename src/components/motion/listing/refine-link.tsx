"use client";

// A link that refines the current listing (a filter chip, "Clear all", the
// empty state's "Clear all filters"), Phase 4b L7. A plain next/link (same
// markup, no scroll jump) that raises the refine flag just before its client
// navigation, so the results crossfade (ListingResultsTransition). Modifier
// clicks (new tab) do not run onNavigate; without JavaScript it is a plain
// link.

import Link from "next/link";
import { type ComponentProps, useRef } from "react";

import { beginListingRefine } from "./filter-transition";

type RefineLinkProps = Omit<
  ComponentProps<typeof Link>,
  "href" | "onNavigate" | "scroll"
> & { href: string };

export function RefineLink({ href, ...props }: RefineLinkProps) {
  const ref = useRef<HTMLAnchorElement>(null);
  return (
    <Link
      {...props}
      ref={ref}
      href={href}
      scroll={false}
      onNavigate={() => beginListingRefine(ref.current)}
    />
  );
}
