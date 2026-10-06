// The product's status card: Draft or Published, the Publish / Move to draft
// button, what still blocks publishing, and the refusal from publishCheck
// listed item by item. Publishing works on the SAVED product, so it waits
// until unsaved edits are saved.

import { CircleAlert } from "lucide-react";
import { useRef, useState, useTransition } from "react";

import {
  publishProductAction,
  unpublishProductAction,
} from "@/app/admin/products/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ProductStatus } from "@/models/product-constants";

import { callAction, type ServiceErrors } from "../action-result";
import { useClearNotice } from "../clear-notice";

/** The publish-check fields; their messages are the reasons to list. */
const PROBLEM_FIELDS = ["variants", "mainCategory", "images"] as const;

/**
 * A failed publish/unpublish as a title and a list. The title follows
 * `saved`, like the edit form: written but not audited, or not confirmed,
 * must not read "Not published". A publishCheck refusal lists each missing
 * item; anything else (not found, audit failure) lists the plain messages.
 * Exported for tests.
 */
export function statusFailure(
  errors: ServiceErrors,
  publishing: boolean,
  saved: boolean | "unknown",
): { title: string; items: string[] } {
  const reasons = PROBLEM_FIELDS.flatMap(
    (field) => errors.fieldErrors[field] ?? [],
  );
  if (publishing && reasons.length > 0) {
    return {
      title: "This product can't be published yet",
      items: [...errors.formErrors, ...reasons],
    };
  }
  const title =
    saved === true
      ? publishing
        ? "Published, with a problem"
        : "Moved to draft, with a problem"
      : saved === "unknown"
        ? "The change could not be confirmed"
        : publishing
          ? "Not published"
          : "Not moved to draft";
  return {
    title,
    items: [
      ...new Set([
        ...errors.formErrors,
        ...Object.values(errors.fieldErrors).flat(),
      ]),
    ],
  };
}

export function StatusPanel({
  productId,
  version,
  status,
  problems,
  dirty,
}: {
  productId: string;
  /** The saved product's updatedAt; a newer write refuses the change. */
  version: string;
  status: ProductStatus;
  /** publishCheck() on the saved product, from the server. */
  problems: string[];
  /** The form has unsaved edits. */
  dirty: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<{
    title: string;
    items: string[];
  } | null>(null);
  const [done, setDone] = useState("");
  // Set synchronously: two fast clicks send one request.
  const inFlight = useRef(false);
  const clearNotice = useClearNotice();
  const published = status === "published";
  const blocked = dirty && !published;

  function run() {
    if (inFlight.current || blocked) return;
    inFlight.current = true;
    setFailure(null);
    setDone("");
    const publishing = !published;
    startTransition(async () => {
      try {
        const result = await callAction(() =>
          publishing
            ? publishProductAction(productId, version)
            : unpublishProductAction(productId, version),
        );
        if (!result) return;
        // An earlier "Product saved." no longer describes the page (L-4).
        clearNotice();
        if (result.ok) {
          setDone(
            publishing
              ? "Published. The product is now on the site."
              : "Moved to draft. The product is hidden from the site.",
          );
          return;
        }
        setFailure(statusFailure(result.errors, publishing, result.saved));
      } finally {
        inFlight.current = false;
      }
    });
  }

  const hintId = "product-status-hint";
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            Status
            {published ? (
              <Badge>Published</Badge>
            ) : (
              <Badge variant="outline">Draft</Badge>
            )}
          </h2>
        </CardTitle>
        <CardDescription>
          {published
            ? "Visible on the site. Saved changes show there straight away."
            : "Hidden from the site until you publish it."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {failure ? (
          <Alert variant="destructive" role="alert">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{failure.title}</AlertTitle>
            <AlertDescription>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {failure.items.map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : !published && problems.length > 0 ? (
          <div className="flex flex-col gap-1 text-sm">
            <p>Before it can be published, this product needs:</p>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-muted-foreground">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p role="status" className="text-sm">
          {done}
        </p>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant={published ? "outline" : "default"}
          disabled={pending}
          aria-disabled={blocked || undefined}
          aria-describedby={blocked ? hintId : undefined}
          onClick={run}
        >
          {pending
            ? published
              ? "Moving to draft…"
              : "Publishing…"
            : published
              ? "Move to draft"
              : "Publish"}
        </Button>
        {blocked ? (
          <p id={hintId} className="text-sm text-muted-foreground">
            Save your changes first. Publishing uses the saved product.
          </p>
        ) : null}
      </CardFooter>
    </Card>
  );
}
