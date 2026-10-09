// The header of a listing page: breadcrumb, the category name as the page's
// one <h1>, its description (plain text, line breaks kept) and, when the
// admin uploaded one, the cover photo at hero scale (Arelux). Without a
// cover the name and description sit side by side on wide screens, so the
// header never looks like it is missing something; a title alone sits close
// to the links below it. Below it, the links to the category's
// sub-categories (or the main categories on /products). Area pages use
// their own full-bleed band (areas/area-band.tsx) and reuse ListingSubNav.
// Server Component.

import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

export interface ListingSubLink {
  id: string;
  name: string;
  href: string;
  current: boolean;
}

export function ListingHeader({
  title,
  description,
  cover,
  breadcrumb,
  subLinks,
  subLinksLabel,
}: {
  title: string;
  description: string | null;
  cover: { src: string; alt: string } | null;
  breadcrumb?: ReactNode;
  /** Sub-category links; the row is left out with fewer than 2. */
  subLinks: readonly ListingSubLink[];
  /** The sub-category nav's accessible name. */
  subLinksLabel: string;
}) {
  const text = description?.trim() ? description.trim() : null;
  return (
    <header data-slot="listing-header">
      {breadcrumb}
      {cover ? (
        <div className="mt-4 grid gap-8 md:mt-6 lg:grid-cols-12 lg:items-end lg:gap-16">
          <div className="lg:col-span-5 lg:pb-1">
            <h1 className="font-display text-5xl leading-[1.02] font-light text-balance md:text-6xl xl:text-7xl">
              {title}
            </h1>
            {text ? (
              <p className="mt-6 max-w-prose text-[0.9375rem] leading-relaxed whitespace-pre-line text-grey-700 md:text-base">
                {text}
              </p>
            ) : null}
          </div>
          <div className="relative -mx-4 aspect-[3/2] overflow-hidden bg-grey-100 md:mx-0 lg:col-span-7">
            <Image
              src={cover.src}
              alt={cover.alt}
              fill
              sizes="(min-width: 1440px) 52rem, (min-width: 1024px) 56vw, 100vw"
              preload
              className="object-cover"
            />
          </div>
        </div>
      ) : (
        <div className="mt-4 grid gap-6 md:mt-6 lg:grid-cols-12 lg:items-end lg:gap-16">
          <h1 className="font-display text-5xl leading-[1.02] font-light text-balance md:text-6xl lg:col-span-7 xl:text-7xl">
            {title}
          </h1>
          {text ? (
            <p className="max-w-prose text-[0.9375rem] leading-relaxed whitespace-pre-line text-grey-700 md:text-base lg:col-span-5 lg:pb-2">
              {text}
            </p>
          ) : null}
        </div>
      )}
      <ListingSubNav
        links={subLinks}
        label={subLinksLabel}
        // A bare title needs less air above the links (ui-reviewer L-9).
        className={cover || text ? "mt-10 md:mt-14" : "mt-6 md:mt-8"}
      />
    </header>
  );
}

/**
 * The row of sibling links under a listing header (sub-categories, areas).
 * A swipe row on phones (snap keeps the 16 px gutter, ui-reviewer M-2),
 * wrapped from md. Left out with fewer than 2 links.
 */
export function ListingSubNav({
  links,
  label,
  className,
}: {
  links: readonly ListingSubLink[];
  /** The nav's accessible name. */
  label: string;
  className: string;
}) {
  if (links.length < 2) return null;
  return (
    <nav aria-label={label} className={className}>
      <ul className="-mx-4 flex snap-x scroll-px-4 gap-x-7 overflow-x-auto px-4 md:mx-0 md:scroll-px-0 md:flex-wrap md:overflow-visible md:px-0">
        {links.map((link) => (
          <li key={link.id} className="shrink-0 snap-start">
            <Link
              href={link.href}
              aria-current={link.current ? "page" : undefined}
              className={`inline-flex min-h-11 items-center border-b whitespace-nowrap transition-colors duration-(--duration-quick) ${
                link.current
                  ? "border-ink text-ink"
                  : "border-transparent text-grey-600 hover:border-grey-400 hover:text-ink"
              }`}
            >
              {link.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
