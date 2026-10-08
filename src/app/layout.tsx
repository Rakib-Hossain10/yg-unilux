// Root layout for every route: the document, the two self-hosted fonts and
// the global styles. Site chrome (header, footer) lives in the (site) and
// (account) groups, so /blocked, /admin and error pages can opt out.

import type { Metadata } from "next";

import { bodyFont, displayFont, displayItalicFont } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "YG UniLUX", template: "%s | YG UniLUX" },
  description: "YG UniLUX commercial lighting catalog.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${displayFont.variable} ${displayItalicFont.variable} ${bodyFont.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
