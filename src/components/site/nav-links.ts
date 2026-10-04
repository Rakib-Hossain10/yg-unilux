// The site's navigation targets, in one place for the header and the footer
// (CLAUDE.md "Design": Product, Services, OEM/ODM, R&D, About us). Pages
// behind these links arrive in later phases; until then they show the 404.

export interface NavLink {
  label: string;
  href: string;
}

/** Header, centred, in this order. */
export const MAIN_NAV: readonly NavLink[] = [
  { label: "Product", href: "/products" },
  { label: "Services", href: "/services" },
  { label: "OEM/ODM", href: "/oem-odm" },
  { label: "R&D", href: "/rnd" },
  { label: "About us", href: "/about" },
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
      { label: "Services", href: "/services" },
      { label: "OEM/ODM", href: "/oem-odm" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About us", href: "/about" },
      { label: "R&D", href: "/rnd" },
      { label: "Contact", href: "/contact" },
      { label: "Whistleblower", href: "/whistleblower" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms", href: "/legal/terms" },
      { label: "Privacy", href: "/legal/privacy" },
      { label: "Cookies", href: "/legal/cookies" },
      { label: "Legal notice", href: "/legal" },
    ],
  },
];
