// The small-screen menu panel (Phase 4b L6): the main sections, with
// "Product" opening nested disclosures (native <details>, so it works
// without JavaScript): All products, each main category (its sub-categories
// inside, or a plain link when it has none) and Applications (the areas).
// Without menu data (no database at build, an outage) "Product" is a link.
// Server Component, rendered inside MobileMenu.

import Link from "next/link";

import { AREAS_PATH, PRODUCTS_PATH } from "../listing/listing-urls";
import { MAIN_NAV } from "../nav-links";
import type { MenuLink, SiteMenu } from "./menu-types";

const topItem =
  "flex min-h-14 w-full items-center justify-between py-4 text-sm tracking-[0.14em] uppercase";
const nestedSummary =
  "flex min-h-12 cursor-pointer list-none items-center justify-between py-3 text-[0.9375rem] text-ink [&::-webkit-details-marker]:hidden";
const nestedLink =
  "flex min-h-11 items-center py-2 text-[0.9375rem] text-grey-700 hover:text-ink";

/* A plus that turns into a minus while its <details> is open. */
function ToggleMark() {
  return (
    <svg
      viewBox="0 0 12 12"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-grey-600"
    >
      <path d="M1.5 6h9" />
      <path d="M6 1.5v9" className="group-open/item:hidden" />
    </svg>
  );
}

function Group({
  title,
  allLink,
  links,
}: {
  title: string;
  allLink: MenuLink;
  links: readonly MenuLink[];
}) {
  return (
    <details className="group/item">
      <summary className={nestedSummary}>
        {title}
        <ToggleMark />
      </summary>
      <ul className="mb-2 border-l border-grey-200 pl-4">
        <li>
          <Link href={allLink.href} className={nestedLink}>
            {allLink.name}
          </Link>
        </li>
        {links.map((link) => (
          <li key={link.id}>
            <Link href={link.href} className={nestedLink}>
              {link.name}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ProductItem({ menu, href }: { menu: SiteMenu; href: string }) {
  return (
    <details className="group/products" data-slot="mobile-products">
      <summary
        className={`${topItem} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
      >
        Product
        <svg
          viewBox="0 0 12 12"
          width={12}
          height={12}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          aria-hidden="true"
          focusable="false"
          className="shrink-0 transition-transform duration-(--duration-quick) group-open/products:rotate-180 motion-reduce:transition-none"
        >
          <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
        </svg>
      </summary>
      <ul className="divide-y divide-grey-100 pb-4">
        <li>
          <Link
            href={href}
            className="flex min-h-12 items-center py-3 text-[0.9375rem] text-ink"
          >
            All products
          </Link>
        </li>
        {menu.categories.map((category) => (
          <li key={category.id}>
            {category.children.length > 0 ? (
              <Group
                title={category.name}
                allLink={{
                  id: `${category.id}-all`,
                  name: `All ${category.name}`,
                  href: category.href,
                }}
                links={category.children}
              />
            ) : (
              <Link
                href={category.href}
                className="flex min-h-12 items-center py-3 text-[0.9375rem] text-ink"
              >
                {category.name}
              </Link>
            )}
          </li>
        ))}
        {menu.areas.length > 0 ? (
          <li>
            <Group
              title="Applications"
              allLink={{
                id: "areas-all",
                name: "All applications",
                href: AREAS_PATH,
              }}
              links={menu.areas}
            />
          </li>
        ) : null}
      </ul>
    </details>
  );
}

export function MobileNav({ menu }: { menu: SiteMenu | null }) {
  return (
    <nav
      aria-label="Main"
      data-slot="mobile-nav"
      className="absolute inset-x-0 top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain border-b border-grey-200 bg-paper px-4 pb-6 md:px-8"
    >
      <ul className="flex flex-col divide-y divide-grey-200">
        {MAIN_NAV.map((item) => (
          <li key={item.href}>
            {item.href === PRODUCTS_PATH &&
            menu &&
            menu.categories.length > 0 ? (
              <ProductItem menu={menu} href={item.href} />
            ) : (
              <Link
                href={item.href}
                prefetch={item.prefetch}
                className={topItem}
              >
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
