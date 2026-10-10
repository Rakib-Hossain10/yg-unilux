// Shown inside the admin shell when a customer id is unknown or malformed
// (or names the admin account). Static text only: it renders no data, so it
// needs no guard (the page itself already ran requireAdmin()).

import Link from "next/link";

import { CUSTOMERS_PATH } from "@/components/admin/customers/paths";
import { Button } from "@/components/ui/button";

export default function CustomerNotFound() {
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">Customer not found</h1>
      <p className="text-muted-foreground">
        This customer does not exist. Check the address, or find them in the
        customers list.
      </p>
      <Button asChild className="w-fit">
        <Link href={CUSTOMERS_PATH}>Back to customers</Link>
      </Button>
    </div>
  );
}
