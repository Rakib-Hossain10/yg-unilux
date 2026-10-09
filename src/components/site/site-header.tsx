// Site header (CLAUDE.md "Design"): logo left · Product, Services, OEM/ODM,
// R&D, About us centred · search and account icons right. A Server Component;
// the browser runs only the product mega-menu (menu/mega-menu.tsx), the
// search launcher (search/search-launcher.tsx, overlay loaded on first use)
// and the small-screen menu toggle (mobile-menu.tsx).
//
// `menu` comes from the layout (menu/site-menu.ts, cached catalog reads).
// Without it (no database at build, an outage, the root 404/403 pages)
// "Product" is a plain link and the small-screen menu has no categories.

import Link from "next/link";

import { siteCloudName } from "./cloudinary-image";
import { AccountIcon } from "./icons";
import { PRODUCTS_PATH } from "./listing/listing-urls";
import { MegaMenu } from "./menu/mega-menu";
import type { SiteMenu } from "./menu/menu-types";
import { MobileNav } from "./menu/mobile-nav";
import { MobileMenu } from "./mobile-menu";
import { MAIN_NAV } from "./nav-links";
import { SearchLauncher } from "./search/search-launcher";

/* Until the logo SVG arrives (Phase 1 decision), the name set in the display face. */
function Wordmark() {
  return (
    <Link
      href="/"
      className="justify-self-start font-display text-2xl font-medium tracking-[0.12em] whitespace-nowrap"
    >
      YG UniLUX
    </Link>
  );
}

const iconLink =
  "inline-flex size-11 items-center justify-center rounded-full transition-colors duration-(--duration-quick) hover:bg-grey-100";

const navItem =
  "py-2 text-grey-700 transition-colors duration-(--duration-quick) hover:text-ink";

export function SiteHeader({
  menu = null,
}: {
  /** The product menu, or null for plain links. */
  menu?: SiteMenu | null;
} = {}) {
  // Solid at 95% (ui-reviewer L-6): the 80% glass let busy photos read
  // through the nav text while scrolling.
  return (
    <header className="sticky top-0 z-40 border-b border-grey-200 bg-paper/95 backdrop-blur">
      <div className="mx-auto grid h-16 max-w-(--container-site) grid-cols-[1fr_auto] items-center gap-4 px-4 md:px-8 lg:grid-cols-[1fr_auto_1fr]">
        <Wordmark />

        {/* Desktop navigation, centred. From lg only: at md the five
            tracked-out items crowd the wordmark and "About us" wraps
            (ui-reviewer M-2), so tablets get the menu button instead. */}
        <nav aria-label="Main" className="hidden lg:block">
          <ul className="flex items-center gap-8 text-[0.8125rem] tracking-[0.14em] uppercase">
            {MAIN_NAV.map((item) => (
              <li key={item.href}>
                {item.href === PRODUCTS_PATH && menu ? (
                  <MegaMenu
                    menu={menu}
                    label={item.label}
                    href={item.href}
                    itemClassName={navItem}
                  />
                ) : (
                  <Link
                    href={item.href}
                    prefetch={item.prefetch}
                    className={navItem}
                  >
                    {item.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center justify-end gap-1">
          <SearchLauncher className={iconLink} cloudName={siteCloudName()} />
          {/* Not prefetched: the sign-in page's form code (with its schema
              library, ~100 KB) would otherwise load on every public page
              that shows the header. It loads on click instead. */}
          <Link
            href="/login"
            prefetch={false}
            aria-label="Account"
            className={iconLink}
          >
            <AccountIcon />
          </Link>

          {/* Mobile menu: native disclosure that also closes on navigation,
              Escape and outside clicks; the panel is rendered here. */}
          <MobileMenu summaryClassName={iconLink}>
            <MobileNav menu={menu} />
          </MobileMenu>
        </div>
      </div>
    </header>
  );
}
