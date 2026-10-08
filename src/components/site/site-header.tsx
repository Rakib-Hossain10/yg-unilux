// Site header (CLAUDE.md "Design"): logo left · Product, Services, OEM/ODM,
// R&D, About us centred · search and account icons right. A Server Component;
// only the small-screen menu toggle (mobile-menu.tsx) runs in the browser.

import Link from "next/link";

import { AccountIcon, SearchIcon } from "./icons";
import { MobileMenu } from "./mobile-menu";
import { MAIN_NAV } from "./nav-links";

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

export function SiteHeader() {
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
                <Link
                  href={item.href}
                  prefetch={item.prefetch}
                  className="py-2 text-grey-700 transition-colors duration-(--duration-quick) hover:text-ink"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center justify-end gap-1">
          {/* The search overlay arrives in Phase 4. */}
          {/* prefetch={false}: /search is not built yet, and a prefetch of it
              logs a 404 in the console on every page. Remove once it exists. */}
          <Link
            href="/search"
            prefetch={false}
            aria-label="Search"
            className={iconLink}
          >
            <SearchIcon />
          </Link>
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
            <nav
              aria-label="Main"
              className="absolute inset-x-0 top-16 border-b border-grey-200 bg-paper px-4 pb-6"
            >
              <ul className="flex flex-col divide-y divide-grey-200">
                {MAIN_NAV.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      prefetch={item.prefetch}
                      className="block py-4 text-sm tracking-[0.14em] uppercase"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </MobileMenu>
        </div>
      </div>
    </header>
  );
}
