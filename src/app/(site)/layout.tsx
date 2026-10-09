// Layout for the public catalog pages (home, products, areas, search,
// content pages): wraps them in the site header and footer. The header's
// product menu comes from cached catalog reads (menu/site-menu.ts); without
// a database (CI build) or during an outage it falls back to plain links.

import { loadSiteMenu } from "@/components/site/menu/site-menu";
import { SiteShell } from "@/components/site/site-shell";

export default async function SiteLayout({ children }: LayoutProps<"/">) {
  return <SiteShell menu={await loadSiteMenu()}>{children}</SiteShell>;
}
