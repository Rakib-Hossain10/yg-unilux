// A section of the product edit form that edits a list of rows with
// useFieldArray: add, remove (optionally after a confirm dialog), move up/down,
// a list-level error, a polite live region and sensible focus after each change.

import { Plus } from "lucide-react";
import {
  memo,
  useCallback,
  useId,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  useFieldArray,
  useFormContext,
  useFormState,
  type FieldError,
} from "react-hook-form";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

import { FormSection } from "./form-section";
import {
  EMPTY_EXTRA_SPEC,
  EMPTY_PUBLIC_FILE,
  EMPTY_VARIANT,
  type ProductEditValues,
} from "./form-values";
import {
  indexAfterRemove,
  RowControls,
  useFocusAfterRender,
  type Direction,
} from "./row-controls";
import { fieldId } from "./text-field";

/** The row lists of the form. */
export type RowListName = "variants" | "extraSpecs" | "publicFiles";

const EMPTY_ROW = {
  variants: EMPTY_VARIANT,
  extraSpecs: EMPTY_EXTRA_SPEC,
  publicFiles: EMPTY_PUBLIC_FILE,
} as const;

/** What a row's inputs get: its index and its name, e.g. "variant 2". */
export interface RowInputsProps {
  index: number;
  rowName: string;
}

/** The text of the confirm dialog before removing a row. */
export interface RemoveConfirm {
  title: string;
  description: string;
}

/** The DOM id of the list's Add button, e.g. `product-variants-add`. */
export function addButtonId(name: RowListName): string {
  return `${fieldId(name)}-add`;
}

/* The list-level message (e.g. "At most 200 variants"), from `<name>.root`. */
function ListError({ name, id }: { name: RowListName; id: string }) {
  const { errors } = useFormState<ProductEditValues>({ name });
  const node = errors[name] as (FieldError & { root?: FieldError }) | undefined;
  const message = node?.root?.message ?? node?.message;
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {typeof message === "string" ? message : null}
    </p>
  );
}

/*
 * One row. Memoised and given only primitives and stable callbacks, so adding
 * a row or typing in one row does not re-render the other rows: only the
 * edge rows change (isFirst / isLast) when the list grows or shrinks.
 */
const Row = memo(function Row({
  index,
  rowId,
  noun,
  isFirst,
  isLast,
  Inputs,
  onMove,
  onRemove,
}: {
  index: number;
  rowId: string;
  noun: string;
  isFirst: boolean;
  isLast: boolean;
  Inputs: ComponentType<RowInputsProps>;
  onMove: (index: number, rowId: string, direction: Direction) => void;
  onRemove: (index: number, rowId: string) => void;
}) {
  const headingId = useId();
  const rowName = `${noun} ${index + 1}`;
  const title = rowName.charAt(0).toUpperCase() + rowName.slice(1);
  return (
    <li>
      <div
        role="group"
        aria-labelledby={headingId}
        className="flex flex-col gap-4 rounded-lg border p-4"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 id={headingId} className="text-sm font-medium">
            {title}
          </h3>
          <RowControls
            rowName={rowName}
            idPrefix={`row-${rowId}`}
            isFirst={isFirst}
            isLast={isLast}
            onMove={(direction) => onMove(index, rowId, direction)}
            onRemove={() => onRemove(index, rowId)}
          />
        </div>
        <Inputs index={index} rowName={rowName} />
      </div>
    </li>
  );
});

export function RowListSection({
  name,
  title,
  description,
  noun,
  addLabel,
  emptyText,
  max,
  firstInput,
  Inputs,
  confirmRemove,
}: {
  name: RowListName;
  title: string;
  description: string;
  /** One row in lower case, e.g. "variant". */
  noun: string;
  addLabel: string;
  emptyText: string;
  max: number;
  /** The input that gets focus in a new row, e.g. "modelNo". */
  firstInput: string;
  Inputs: ComponentType<RowInputsProps>;
  /** When given, removing a row asks first with this text. */
  confirmRemove?: (index: number) => RemoveConfirm;
}) {
  const { control, getValues } = useFormContext<ProductEditValues>();
  const { fields, append, remove, move } = useFieldArray({ control, name });
  const focusLater = useFocusAfterRender();
  const [announcement, setAnnouncementState] = useState({
    text: "",
    count: 0,
  });
  const setAnnouncement = useCallback(
    (text: string) =>
      setAnnouncementState((last) => ({ text, count: last.count + 1 })),
    [],
  );
  // The row the confirm dialog is about.
  const [removing, setRemoving] = useState<{ index: number } | null>(null);
  /*
   * The DOM id that gets focus when the dialog closes: the Remove button that
   * opened it (Cancel), or the next row (Remove). Needed because one dialog
   * serves every row, so it has no Radix Trigger to return focus to.
   */
  const focusAfterDialog = useRef<string | null>(null);
  const errorId = `${fieldId(name)}-error`;
  const count = fields.length;
  const full = count >= max;
  // Read at call time, so the callbacks below stay stable (memoised rows).
  const rowCount = useCallback(() => getValues(name).length, [getValues, name]);

  const removeAt = useCallback(
    (index: number) => {
      const before = rowCount();
      remove(index);
      setAnnouncement(`${capital(noun)} ${index + 1} removed.`);
      const next = indexAfterRemove(index, before);
      return next === null
        ? addButtonId(name)
        : fieldId(`${name}.${next}.${firstInput}`);
    },
    [remove, noun, name, firstInput, rowCount, setAnnouncement],
  );

  const onRemove = useCallback(
    (index: number, rowId: string) => {
      if (confirmRemove) {
        focusAfterDialog.current = `row-${rowId}-remove`;
        setRemoving({ index });
      } else {
        focusLater(removeAt(index));
      }
    },
    [confirmRemove, focusLater, removeAt],
  );

  const onMove = useCallback(
    (index: number, rowId: string, direction: Direction) => {
      const to = direction === "up" ? index - 1 : index + 1;
      if (to < 0 || to >= rowCount()) return;
      move(index, to);
      setAnnouncement(
        `${capital(noun)} ${index + 1} moved ${direction}, now ${noun} ${to + 1}.`,
      );
      // React may re-insert the moved row's node, which drops focus.
      focusLater(`row-${rowId}-${direction}`);
    },
    [move, noun, focusLater, rowCount, setAnnouncement],
  );

  const add = () => {
    if (full) return;
    append(EMPTY_ROW[name] as never, { shouldFocus: false });
    setAnnouncement(`${capital(noun)} ${count + 1} added.`);
    focusLater(fieldId(`${name}.${count}.${firstInput}`));
  };

  const confirm = removing === null ? null : confirmRemove?.(removing.index);

  return (
    <FormSection title={`${title} (${count})`} description={description}>
      <div className="flex flex-col gap-4">
        <ListError name={name} id={errorId} />
        {count === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <ol aria-label={title} className="flex flex-col gap-4">
            {fields.map((field, index) => (
              <Row
                key={field.id}
                index={index}
                rowId={field.id}
                noun={noun}
                isFirst={index === 0}
                isLast={index === count - 1}
                Inputs={Inputs}
                onMove={onMove}
                onRemove={onRemove}
              />
            ))}
          </ol>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            id={addButtonId(name)}
            aria-disabled={full}
            aria-describedby={full ? `${addButtonId(name)}-full` : undefined}
            className="w-fit aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={add}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            {addLabel}
          </Button>
          {full ? (
            <p
              id={`${addButtonId(name)}-full`}
              className="text-sm text-muted-foreground"
            >
              At most {max} {noun}s.
            </p>
          ) : null}
        </div>
        <p role="status" className="sr-only">
          {/* Keyed by a counter, so the same text twice is announced twice. */}
          <span key={announcement.count}>{announcement.text}</span>
        </p>
      </div>

      {confirmRemove ? (
        <AlertDialog
          open={confirm !== null && confirm !== undefined}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
        >
          <AlertDialogContent
            onCloseAutoFocus={(event) => {
              // Cancel: the Remove button that opened it; Remove: the next row.
              const target = focusAfterDialog.current;
              focusAfterDialog.current = null;
              if (target === null) return;
              event.preventDefault();
              focusLater(target);
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
              <AlertDialogDescription>
                {confirm?.description}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (removing !== null) {
                    focusAfterDialog.current = removeAt(removing.index);
                  }
                }}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </FormSection>
  );
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
