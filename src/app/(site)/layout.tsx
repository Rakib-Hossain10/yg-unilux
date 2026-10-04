// Layout for the public catalog pages (home, products, areas, content
// pages): wraps them in the site header and footer.

import { SiteShell } from "@/components/site/site-shell";

export default function SiteLayout({ children }: LayoutProps<"/">) {
  return <SiteShell>{children}</SiteShell>;
}
