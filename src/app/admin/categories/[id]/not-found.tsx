// Shown inside the admin shell when a category id is unknown or malformed
// (deleted meanwhile, or a mistyped URL). Static text only: it renders no
// data, so it needs no guard (the page itself already ran requireAdmin()).

import Link from "next/link";

import { CATEGORIES_PATH } from "@/components/admin/category-paths";
import { Button } from "@/components/ui/button";

export default function CategoryNotFound() {
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">Category not found</h1>
      <p className="text-muted-foreground">
        This category does not exist. It may have been deleted.
      </p>
      <Button asChild className="w-fit">
        <Link href={CATEGORIES_PATH}>Back to categories</Link>
      </Button>
    </div>
  );
}
