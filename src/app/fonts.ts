// The site's two typefaces (user decision 2026-10-04, ADR 0028): Cormorant
// Garamond for headings, Inter for body text, navigation and spec tables.
// next/font downloads them at build time and serves them from our own origin.

import { Cormorant_Garamond, Inter } from "next/font/google";

/* Variable font (wght 300–700) with italics for quotes and pull text. */
export const displayFont = Cormorant_Garamond({
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-cormorant",
});

/* Variable font (wght 100–900); the workhorse, including dense tables. */
export const bodyFont = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});
