// Site footer: wordmark, link columns and the copyright line. A Server
// Component; the link lists come from nav-links.ts, shared with the header.

import Link from "next/link";

import { FOOTER_NAV } from "./nav-links";

/*
 * Contrast on ink: grey-300 links 11.97:1, grey-400 text 7.32:1. grey-500
 * (4.17:1) is too faint for text here (QA H2, task 11).
 */
export function SiteFooter() {
  // Rendered at build time for static pages, so the year updates with the
  // next deploy; good enough for a copyright line.
  const year = new Date().getFullYear();

  return (
    <footer className="mt-auto bg-ink text-grey-300">
      <div className="mx-auto grid max-w-(--container-site) grid-cols-2 gap-x-6 gap-y-10 px-4 py-16 md:grid-cols-[2fr_repeat(3,1fr)] md:gap-12 md:px-8">
        <div className="col-span-2 md:col-span-1">
          <p className="font-display text-2xl tracking-[0.12em] text-paper">
            YG UniLUX
          </p>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-grey-400">
            Commercial lighting, designed and made for residential, retail,
            hospitality, office, healthcare, education and exhibition spaces.
          </p>
        </div>

        {FOOTER_NAV.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h2 className="mb-2 text-xs tracking-[0.16em] text-grey-400 uppercase">
              {column.title}
            </h2>
            {/* Each link is a 44 px row (touch target), so the rows carry the
                rhythm and the list needs no extra spacing. */}
            <ul className="text-sm">
              {column.links.map((link) => (
                <li key={link.href}>
                  {/* Built pages keep the default prefetch; pages not built
                      yet opt out (nav-links.ts), or each prefetch would log
                      a 404 on every page. */}
                  <Link
                    href={link.href}
                    prefetch={link.prefetch}
                    className="inline-flex min-h-11 items-center transition-colors duration-(--duration-quick) hover:text-paper"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="border-t border-grey-800">
        <p className="mx-auto max-w-(--container-site) px-4 py-6 text-xs text-grey-400 md:px-8">
          © {year} YG UniLUX. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
