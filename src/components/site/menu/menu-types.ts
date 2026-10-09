// What the header's product menu shows (mega-menu on wide screens, nested
// disclosures in the small-screen menu). Plain data built on the server by
// site-menu.ts from the cached category tree and area list: names, listing
// URLs and icon URLs only, never a product field or spec value (rule 9).
// Client-safe (types only).

/** A link in the menu. */
export interface MenuLink {
  id: string;
  name: string;
  href: string;
}

/** A main category: its icon, short description and sub-categories. */
export interface MenuCategory extends MenuLink {
  /** A 96 x 96 raster delivery URL (f_png), or null: the name stands alone. */
  iconSrc: string | null;
  /** The admin's plain-text description, or null. */
  description: string | null;
  /** Sub-categories that list at least one published product. */
  children: MenuLink[];
}

/** The whole product menu. */
export interface SiteMenu {
  /** Main categories with at least one published product, display order. */
  categories: MenuCategory[];
  /** Application areas, display order. */
  areas: MenuLink[];
}
