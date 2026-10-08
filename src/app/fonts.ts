// The site's two typefaces (user decision 2026-10-04, ADR 0028): Cormorant
// Garamond for headings, Inter for body text, navigation and spec tables.
// next/font downloads them at build time and serves them from our own origin.

import { Cormorant_Garamond, Inter } from "next/font/google";

/* Variable font (wght 300–700), upright: headings on every page, preloaded. */
export const displayFont = Cormorant_Garamond({
  subsets: ["latin"],
  style: ["normal"],
  display: "swap",
  variable: "--font-cormorant",
});

/*
 * The italic for quotes and pull text, NOT preloaded: no page above the fold
 * uses it, and a preloaded font that is never used costs every visitor ~40 KB
 * on the critical path (Lighthouse, Phase 4 P9). next/font names both calls'
 * faces "Cormorant Garamond", so `font-display italic` picks this face from
 * the same family; the browser fetches it only where italic text renders.
 * Its class goes on <html> so its @font-face rules are always included.
 */
export const displayItalicFont = Cormorant_Garamond({
  subsets: ["latin"],
  style: ["italic"],
  display: "swap",
  preload: false,
  variable: "--font-cormorant-italic",
});

/* Variable font (wght 100–900); the workhorse, including dense tables. */
export const bodyFont = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});
