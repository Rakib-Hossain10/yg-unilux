// Layout for account pages (login now; change-password and my-downloads in
// Phase 5): the same header and footer as the public site (ADR 0028),
// including the product menu (menu/site-menu.ts, plain links as fallback).

import { loadSiteMenu } from "@/components/site/menu/site-menu";
import { SiteShell } from "@/components/site/site-shell";

export default async function AccountLayout({ children }: LayoutProps<"/">) {
  return <SiteShell menu={await loadSiteMenu()}>{children}</SiteShell>;
}
