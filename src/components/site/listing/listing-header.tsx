// The header of a listing page: breadcrumb, the category name as the page's
// one <h1>, its description (plain text, line breaks kept) and, when the
// admin uploaded one, the cover photo at hero scale (Arelux). Without a
// cover the name and description sit side by side on wide screens, so the
// header never looks like it is missing something. Below it, the links to
// the category's sub-categories (or the main categories on /products, the
// other areas on an area page). Area pages show their cover in black and
// white (Viabizzuno).
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
  /** `monochrome` renders the photo in greyscale (area pages). */
  cover: { src: string; alt: string; monochrome?: boolean } | null;
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
              className={
                cover.monochrome ? "object-cover grayscale" : "object-cover"
              }
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
      {subLinks.length >= 2 ? (
        <nav aria-label={subLinksLabel} className="mt-10 md:mt-14">
          <ul className="-mx-4 flex snap-x gap-x-7 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
            {subLinks.map((link) => (
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
      ) : null}
    </header>
  );
}
