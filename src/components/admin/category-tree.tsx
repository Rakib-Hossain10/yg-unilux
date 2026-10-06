"use client";

// The category tree on /admin/categories: main categories with their
// subcategories nested below, each row with move up/down, edit and delete
// (confirmed in a dialog). Errors from the server show above the tree.

import { ArrowDown, ArrowUp, CircleAlert, Trash2 } from "lucide-react";
import Link from "next/link";

import {
  deleteCategoryAction,
  moveCategoryAction,
} from "@/app/admin/categories/actions";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { categoryEditPath, newSubcategoryPath } from "./category-paths";
import { useSerialAction } from "./use-serial-action";

/** One row as the tree needs it (the page strips everything else). */
export interface CategoryTreeItem {
  id: string;
  name: string;
  slug: string;
  children: CategoryTreeItem[];
}

type Direction = "up" | "down";

/* What a row asks the tree to do; the tree runs one request at a time. */
interface RowCommands {
  pending: boolean;
  move: (item: CategoryTreeItem, direction: Direction) => void;
  remove: (item: CategoryTreeItem) => void;
}

export function CategoryTree({ items }: { items: CategoryTreeItem[] }) {
  // One request at a time; `status` is read out after a move, since the row
  // changes place (see use-serial-action.ts).
  const { pending, errors, status, run } = useSerialAction();

  const commands: RowCommands = {
    pending,
    move: (item, direction) =>
      run(
        () => moveCategoryAction(item.id, direction),
        `${item.name} moved ${direction}.`,
      ),
    remove: (item) => run(() => deleteCategoryAction(item.id)),
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
        aria-label="Categories"
        aria-busy={pending}
        className="flex flex-col divide-y rounded-lg border"
      >
        {items.map((item, index) => (
          <li key={item.id}>
            <CategoryRow
              item={item}
              level={1}
              first={index === 0}
              last={index === items.length - 1}
              commands={commands}
            />
            {item.children.length > 0 ? (
              <ol
                aria-label={`Subcategories of ${item.name}`}
                className="flex flex-col divide-y border-t bg-muted/40"
              >
                {item.children.map((child, childIndex) => (
                  <li key={child.id}>
                    <CategoryRow
                      item={child}
                      level={2}
                      first={childIndex === 0}
                      last={childIndex === item.children.length - 1}
                      commands={commands}
                    />
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/*
 * One category row. Move buttons at an edge, or while a request runs, are
 * marked aria-disabled instead of disabled: a disabled button drops keyboard
 * focus, and after a move the focused button is often the one at the edge.
 */
function CategoryRow({
  item,
  level,
  first,
  last,
  commands,
}: {
  item: CategoryTreeItem;
  level: 1 | 2;
  first: boolean;
  last: boolean;
  commands: RowCommands;
}) {
  const { pending, move, remove } = commands;
  const subcategories = item.children.length;

  const moveButton = (direction: Direction, atEdge: boolean) => {
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
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 py-3 pr-3",
        level === 1 ? "pl-4" : "pl-10",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className={cn("truncate", level === 1 && "font-medium")}>
          {item.name}
        </p>
        <p className="truncate text-sm text-muted-foreground">/{item.slug}</p>
      </div>

      {level === 1 ? (
        <Badge variant="secondary">
          {subcategories === 1
            ? "1 subcategory"
            : `${subcategories} subcategories`}
        </Badge>
      ) : null}

      <div className="flex flex-wrap items-center gap-1">
        {moveButton("up", first)}
        {moveButton("down", last)}
        <Button asChild variant="outline" size="sm">
          <Link href={categoryEditPath(item.id)}>
            Edit<span className="sr-only"> {item.name}</span>
          </Link>
        </Button>
        {level === 1 ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={newSubcategoryPath(item.id)}>
              Add subcategory<span className="sr-only"> to {item.name}</span>
            </Link>
          </Button>
        ) : null}
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
                {subcategories > 0
                  ? `It has ${subcategories === 1 ? "1 subcategory" : `${subcategories} subcategories`}, so it can't be deleted until they are moved or deleted.`
                  : "This can't be undone. A category still used by products can't be deleted."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {/* With subcategories the server would refuse, so only Close is
                offered; product blockers are only known to the server. */}
            <AlertDialogFooter>
              <AlertDialogCancel>
                {subcategories > 0 ? "Close" : "Cancel"}
              </AlertDialogCancel>
              {subcategories > 0 ? null : (
                <AlertDialogAction
                  variant="destructive"
                  disabled={pending}
                  onClick={() => remove(item)}
                >
                  Delete
                </AlertDialogAction>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
