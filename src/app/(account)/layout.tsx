// Layout for account pages (login now; change-password and my-downloads in
// Phase 5): the same header and footer as the public site (ADR 0028).

import { SiteShell } from "@/components/site/site-shell";

export default function AccountLayout({ children }: LayoutProps<"/">) {
  return <SiteShell>{children}</SiteShell>;
}
