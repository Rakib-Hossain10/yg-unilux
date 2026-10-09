// 404 for the listing: an unknown or too-deep category path, or a page
// number past the last page. Rendered inside the (site) layout.

import Link from "next/link";

import { StatusPage, statusAction } from "@/components/site/status-page";

export default function ListingNotFound() {
  return (
    <StatusPage
      code="404"
      title="Page not found"
      message="This category or page is not in the catalog. It may have been renamed or moved."
    >
      <Link href="/products" className={statusAction}>
        All products
      </Link>
      <Link href="/" className={statusAction}>
        Home
      </Link>
    </StatusPage>
  );
}
