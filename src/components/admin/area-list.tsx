"use client";

// The areas list on /admin/areas: one row per area with move up/down, edit
// and delete (confirmed in a dialog). Server errors, such as "3 products use
// this area", show above the list.

import { ArrowDown, ArrowUp, CircleAlert, Trash2 } from "lucide-react";
import Link from "next/link";

import { deleteAreaAction, moveAreaAction } from "@/app/admin/areas/actions";
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

import { areaEditPath } from "./area-paths";
import { useSerialAction } from "./use-serial-action";

/** One row as the list needs it (the page strips everything else). */
export interface AreaListRow {
  id: string;
  name: string;
  slug: string;
}

type Direction = "up" | "down";

export function AreaList({ items }: { items: AreaListRow[] }) {
  // One request at a time; `status` is read out after a move, since the row
  // changes place (see use-serial-action.ts).
  const { pending, errors, status, run } = useSerialAction();

  const move = (item: AreaListRow, direction: Direction) =>
    run(
      () => moveAreaAction(item.id, direction),
      `${item.name} moved ${direction}.`,
    );
  const remove = (item: AreaListRow) => run(() => deleteAreaAction(item.id));

  /*
   * Move buttons at an edge, or while a request runs, are aria-disabled
   * instead of disabled: a disabled button drops keyboard focus, and after a
   * move the focused button is often the one at the edge.
   */
  const moveButton = (
    item: AreaListRow,
    direction: Direction,
    atEdge: boolean,
  ) => {
    const Icon = direction === "up" ? ArrowUp : ArrowDown;
    const unavailable = atEdge || pending;
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${item.name} ${direction}`}
        aria-disabled={unavailable}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        onClick={() => {
          if (!unavailable) move(item, direction);
        }}
      >
        <Icon aria-hidden="true" />
      </Button>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {errors.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {errors.map((message, index) => (
                <li key={`${index}-${message}`}>{message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <p role="status" className="sr-only">
        {pending ? "Saving…" : status}
      </p>

      <ol
        aria-label="Areas"
        aria-busy={pending}
        className="flex flex-col divide-y rounded-lg border"
      >
        {items.map((item, index) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 pr-3 pl-4"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{item.name}</p>
              <p className="truncate text-sm text-muted-foreground">
                /{item.slug}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {moveButton(item, "up", index === 0)}
              {moveButton(item, "down", index === items.length - 1)}
              <Button asChild variant="outline" size="sm">
                <Link href={areaEditPath(item.id)}>
                  Edit<span className="sr-only"> {item.name}</span>
                </Link>
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${item.name}`}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {item.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This can&apos;t be undone. An area still used by products
                      can&apos;t be deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={pending}
                      onClick={() => remove(item)}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
