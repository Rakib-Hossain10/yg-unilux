// Shared parts of the row editors (variants, extra specs, public files): the
// move up / move down / remove buttons with names that say which row, and a
// hook that moves focus once React has rendered the change (after add/remove/move).

import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

export type Direction = "up" | "down";

/**
 * Returns `focusLater(id)`: focuses the element with that DOM id after the
 * next render. Needed because the target row may only exist (or an input may
 * only carry its new index-based id) once the field-array change has rendered,
 * and because React may re-insert a moved row's DOM node, which drops focus
 * from its button (row buttons use ids built from the stable field-array id).
 */
export function useFocusAfterRender(): (id: string) => void {
  const [request, setRequest] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (request === null) return;
    document.getElementById(request.id)?.focus();
  }, [request]);
  // A fresh object each time, so asking for the same id twice still runs.
  return useCallback((id: string) => setRequest({ id }), []);
}

/**
 * The buttons of one row. `rowName` is the row as people read it, e.g.
 * "variant 2"; every button's accessible name includes it. Edge buttons are
 * aria-disabled, not disabled, so a button keeps focus after a move to the
 * edge (ADR 0038).
 */
export function RowControls({
  rowName,
  idPrefix,
  isFirst,
  isLast,
  onMove,
  onRemove,
}: {
  rowName: string;
  /** Stable per row (from the field-array id), e.g. "variant-abc". */
  idPrefix: string;
  isFirst: boolean;
  isLast: boolean;
  onMove: (direction: Direction) => void;
  onRemove: () => void;
}) {
  const move = (direction: Direction, atEdge: boolean) => {
    const Icon = direction === "up" ? ArrowUp : ArrowDown;
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        id={`${idPrefix}-${direction}`}
        aria-label={`Move ${rowName} ${direction}`}
        aria-disabled={atEdge}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        onClick={() => {
          if (!atEdge) onMove(direction);
        }}
      >
        <Icon aria-hidden="true" />
      </Button>
    );
  };
  return (
    <div className="flex items-center gap-1">
      {move("up", isFirst)}
      {move("down", isLast)}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        id={`${idPrefix}-remove`}
        aria-label={`Remove ${rowName}`}
        onClick={onRemove}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}

/**
 * Where focus goes after removing row `index` from a list that had `count`
 * rows: the row that took its place, else the one above, else null (the
 * caller then focuses its Add button).
 */
export function indexAfterRemove(index: number, count: number): number | null {
  if (count <= 1) return null;
  return index < count - 1 ? index : index - 1;
}
