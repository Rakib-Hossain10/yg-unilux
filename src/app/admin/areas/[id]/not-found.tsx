// Shown inside the admin shell when an area id is unknown or malformed
// (deleted meanwhile, or a mistyped URL). Static text only: it renders no
// data, so it needs no guard (the page itself already ran requireAdmin()).

import Link from "next/link";

import { AREAS_PATH } from "@/components/admin/area-paths";
import { Button } from "@/components/ui/button";

export default function AreaNotFound() {
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">Area not found</h1>
      <p className="text-muted-foreground">
        This area does not exist. It may have been deleted.
      </p>
      <Button asChild className="w-fit">
        <Link href={AREAS_PATH}>Back to areas</Link>
      </Button>
    </div>
  );
}
