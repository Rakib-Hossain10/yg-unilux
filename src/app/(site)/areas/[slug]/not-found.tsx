// 404 for an area page: an unknown area, or a page number past the last
// page. Rendered inside the (site) layout.

import Link from "next/link";

import { StatusPage, statusAction } from "@/components/site/status-page";

export default function AreaNotFound() {
  return (
    <StatusPage
      code="404"
      title="Page not found"
      message="This application or page is not in the catalog. It may have been renamed or moved."
    >
      <Link href="/areas" className={statusAction}>
        All applications
      </Link>
      <Link href="/products" className={statusAction}>
        All products
      </Link>
    </StatusPage>
  );
}
