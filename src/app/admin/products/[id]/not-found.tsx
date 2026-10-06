// Shown inside the admin shell when a product id is unknown or malformed
// (deleted meanwhile, or a mistyped URL). Static text only: it renders no
// data, so it needs no guard (the page itself already ran requireAdmin()).

import Link from "next/link";

import { PRODUCTS_PATH } from "@/components/admin/product-paths";
import { Button } from "@/components/ui/button";

export default function ProductNotFound() {
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">Product not found</h1>
      <p className="text-muted-foreground">
        This product does not exist. It may have been deleted.
      </p>
      <Button asChild className="w-fit">
        <Link href={PRODUCTS_PATH}>Back to products</Link>
      </Button>
    </div>
  );
}
