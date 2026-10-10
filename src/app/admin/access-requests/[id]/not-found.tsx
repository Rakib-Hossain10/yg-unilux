// Shown inside the admin shell when a request id is unknown or malformed
// (deleted meanwhile, or a mistyped URL). Static text only: it renders no
// data, so it needs no guard (the page itself already ran requireAdmin()).

import Link from "next/link";

import { ACCESS_REQUESTS_PATH } from "@/components/admin/access-requests/paths";
import { Button } from "@/components/ui/button";

export default function AccessRequestNotFound() {
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">Request not found</h1>
      <p className="text-muted-foreground">
        This access request does not exist. It may have been deleted.
      </p>
      <Button asChild className="w-fit">
        <Link href={ACCESS_REQUESTS_PATH}>Back to access requests</Link>
      </Button>
    </div>
  );
}
