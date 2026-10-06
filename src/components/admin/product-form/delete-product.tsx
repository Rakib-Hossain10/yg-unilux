// "Delete product" at the bottom of the edit page: a confirm dialog, then the
// delete action, which opens the list with a "deleted" notice. A failure is
// shown here; after one that may have deleted, only "Back to products" is left.

import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";

import { deleteProductAction } from "@/app/admin/products/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { allMessages, callAction } from "../action-result";
import { PRODUCTS_PATH } from "../product-paths";

export function DeleteProduct({
  productId,
  name,
}: {
  productId: string;
  name: string;
}) {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<boolean | "unknown">(false);
  const inFlight = useRef(false);

  function remove() {
    if (inFlight.current) return;
    inFlight.current = true;
    setErrors([]);
    startTransition(async () => {
      // Locked until proven safe: a redirect (success) rethrows out of here.
      let unlock = true;
      try {
        const result = await callAction(() => deleteProductAction(productId));
        // Success redirects to the list; only failures come back.
        if (!result || result.ok) return;
        // After a failure that may have deleted, don't offer it again.
        unlock = result.saved === false;
        setSaved(result.saved);
        setErrors(allMessages(result.errors));
      } finally {
        if (unlock) inFlight.current = false;
      }
    });
  }

  return (
    <section aria-labelledby="product-delete-heading">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id="product-delete-heading" className="text-lg font-semibold">
              Delete product
            </h2>
          </CardTitle>
          <CardDescription>
            Removes the product, its variants and specs for good. Attached
            datasheets stay in the datasheet list.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {errors.length > 0 ? (
            <Alert variant="destructive" role="alert">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>
                {saved === true
                  ? "Deleted, with a problem"
                  : saved === "unknown"
                    ? "The delete could not be confirmed"
                    : "The product was not deleted"}
              </AlertTitle>
              <AlertDescription>
                <ul className="flex list-disc flex-col gap-1 pl-4">
                  {errors.map((message, index) => (
                    <li key={`${index}-${message}`}>{message}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          {saved !== false ? (
            <Button asChild className="w-fit">
              <Link href={PRODUCTS_PATH}>Back to products</Link>
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  className="w-fit"
                  disabled={pending}
                >
                  {pending ? "Deleting…" : "Delete product"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This can&apos;t be undone. The product disappears from the
                    site and from the admin list.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={pending}
                    onClick={remove}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
