// 404 for /product/[slug]: an unknown slug or a draft product (drafts 404 for
// everyone in Phase 4a, plan Q5). Rendered inside the (site) layout, so the
// header and footer come from there.

import Link from "next/link";

import { StatusPage, statusAction } from "@/components/site/status-page";

export default function ProductNotFound() {
  return (
    <StatusPage
      code="404"
      title="Product not found"
      message="This product is not in the catalog. It may have been renamed or withdrawn."
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
