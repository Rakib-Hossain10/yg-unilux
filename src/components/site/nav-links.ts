// The site's navigation targets, in one place for the header and the footer
// (CLAUDE.md "Design": Product, Services, OEM/ODM, R&D, About us). Some
// pages behind these links arrive in later phases; until then they show the
// 404 and carry `prefetch: false` (nav-links.test.ts checks the flag against
// the routes that exist under src/app).

export interface NavLink {
  label: string;
  href: string;
  /**
   * false while the page behind the link is not built yet: a prefetch of a
   * missing route logs a 404 in the console on every page (ui-reviewer L-6).
   * Remove the flag (back to the default) once the route exists.
   */
  prefetch?: false;
}

/** Header, centred, in this order. */
export const MAIN_NAV: readonly NavLink[] = [
  { label: "Product", href: "/products" },
  { label: "Services", href: "/services", prefetch: false },
  { label: "OEM/ODM", href: "/oem-odm", prefetch: false },
  { label: "R&D", href: "/rnd", prefetch: false },
  { label: "About us", href: "/about", prefetch: false },
];

/** Footer columns. */
export const FOOTER_NAV: readonly {
  title: string;
  links: readonly NavLink[];
}[] = [
  {
    title: "Explore",
    links: [
      { label: "Products", href: "/products" },
      { label: "Applications", href: "/areas" },
      { label: "Services", href: "/services", prefetch: false },
      { label: "OEM/ODM", href: "/oem-odm", prefetch: false },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About us", href: "/about", prefetch: false },
      { label: "R&D", href: "/rnd", prefetch: false },
      { label: "Contact", href: "/contact", prefetch: false },
      { label: "Whistleblower", href: "/whistleblower", prefetch: false },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms", href: "/legal/terms", prefetch: false },
      { label: "Privacy", href: "/legal/privacy", prefetch: false },
      { label: "Cookies", href: "/legal/cookies", prefetch: false },
      { label: "Legal notice", href: "/legal", prefetch: false },
    ],
  },
];
