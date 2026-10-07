"use client";

// The datasheets table on /admin/datasheets: one row per file with name, size,
// uploader, last update and how many products use it, plus row actions
// (rename, replace, delete). Row errors and progress show in a line under the
// row. The storage key and any URL never reach this component.

import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert, Pencil, Trash2 } from "lucide-react";
import { Fragment, useRef, useState, useTransition } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import {
  deleteDatasheetAction,
  renameDatasheetAction,
} from "@/app/admin/datasheets/actions";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  datasheetFileNameSchema,
  MAX_DATASHEET_FILE_NAME_LENGTH,
} from "@/lib/schemas/datasheet";

import { allMessages, callAction } from "./action-result";
import { ReplaceFileButton, UploadMessages } from "./datasheet-uploader";
import { formatBytes } from "./image-upload";
import { useDatasheetUpload } from "./use-datasheet-upload";

/** One row as the table needs it. Dates are ISO strings (plain JSON). */
export interface DatasheetRowData {
  id: string;
  fileName: string;
  size: number;
  uploader: string;
  updatedAt: string;
  inUse: number;
}

/* "6 Oct 2026" in UTC: the same text on the server and in any browser. */
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const renameFormSchema = z.object({ fileName: datasheetFileNameSchema });
type RenameValues = z.input<typeof renameFormSchema>;

/** Rename dialog: one field, the same Zod rule the server applies. */
function RenameDialog({
  row,
  onDone,
}: {
  row: DatasheetRowData;
  onDone: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const inFlight = useRef(false);
  const form = useForm<RenameValues>({
    resolver: zodResolver(renameFormSchema),
    defaultValues: { fileName: row.fileName },
  });
  const inputId = `datasheet-name-${row.id}`;

  const submit = ({ fileName }: RenameValues) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFormErrors([]);
    startTransition(async () => {
      try {
        const result = await callAction(() =>
          renameDatasheetAction({ id: row.id, fileName }),
        );
        if (!result) return;
        if (result.ok) {
          setOpen(false);
          onDone(`Renamed to ${fileName.trim()}.`);
          return;
        }
        const message = result.errors.fieldErrors.fileName?.[0];
        if (message !== undefined) {
          form.setError("fileName", { type: "server", message });
        }
        setFormErrors(
          message === undefined
            ? allMessages(result.errors)
            : result.errors.formErrors,
        );
      } finally {
        inFlight.current = false;
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          form.reset({ fileName: row.fileName });
          setFormErrors([]);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm">
          <Pencil aria-hidden="true" />
          <span className="sr-only">Rename {row.fileName}</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          noValidate
          aria-busy={pending}
          onSubmit={(event) => form.handleSubmit(submit)(event)}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Rename datasheet</DialogTitle>
            <DialogDescription>
              Changes the name shown here and used for downloads. The file
              itself is not touched.
            </DialogDescription>
          </DialogHeader>
          {formErrors.length > 0 ? (
            <Alert variant="destructive" role="alert">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>The name was not changed</AlertTitle>
              <AlertDescription>{formErrors.join(" ")}</AlertDescription>
            </Alert>
          ) : null}
          <Controller
            name="fileName"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor={inputId}>File name</FieldLabel>
                <Input
                  {...field}
                  name={undefined}
                  id={inputId}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={MAX_DATASHEET_FILE_NAME_LENGTH}
                  aria-invalid={fieldState.invalid}
                  aria-describedby={
                    fieldState.invalid ? `${inputId}-error` : undefined
                  }
                />
                <FieldError
                  id={`${inputId}-error`}
                  errors={[fieldState.error]}
                />
              </Field>
            )}
          />
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save name"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DatasheetRow({ row }: { row: DatasheetRowData }) {
  const upload = useDatasheetUpload(row.id);
  const [pending, startTransition] = useTransition();
  const [deleteErrors, setDeleteErrors] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const inFlight = useRef(false);

  const remove = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setDeleteErrors([]);
    setStatus("");
    startTransition(async () => {
      try {
        const result = await callAction(() => deleteDatasheetAction(row.id));
        if (!result || result.ok) return;
        // formErrors[0] says how many products still use it.
        setDeleteErrors(allMessages(result.errors));
      } finally {
        inFlight.current = false;
      }
    });
  };

  const busy = pending || upload.pending;
  const hasMessage =
    upload.errors.length > 0 ||
    upload.progress !== "" ||
    upload.status !== "" ||
    deleteErrors.length > 0 ||
    status !== "";

  return (
    <Fragment>
      <TableRow aria-busy={busy}>
        <TableCell className="max-w-72 pl-4">
          <span title={row.fileName} className="block truncate font-medium">
            {row.fileName}
          </span>
          {/* Always mounted, so changes are announced. */}
          <span role="status" aria-live="polite" className="sr-only">
            {upload.progress !== ""
              ? upload.progress
              : upload.status !== ""
                ? upload.status
                : status}
          </span>
        </TableCell>
        <TableCell className="tabular-nums">{formatBytes(row.size)}</TableCell>
        <TableCell className="max-w-48">
          <span title={row.uploader} className="block truncate">
            {row.uploader}
          </span>
        </TableCell>
        <TableCell className="text-muted-foreground">
          <time dateTime={row.updatedAt}>
            {DATE_FORMAT.format(new Date(row.updatedAt))}
          </time>
        </TableCell>
        <TableCell>
          {row.inUse === 0 ? (
            <Badge variant="outline">Not used</Badge>
          ) : (
            <Badge variant="secondary">
              {row.inUse === 1 ? "1 product" : `${row.inUse} products`}
            </Badge>
          )}
        </TableCell>
        <TableCell className="pr-4">
          <div className="flex items-center justify-end gap-1">
            <RenameDialog row={row} onDone={setStatus} />
            <ReplaceFileButton name={row.fileName} upload={upload} />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-disabled={busy}
                  onClick={(event) => {
                    if (busy) event.preventDefault();
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  <span className="sr-only">Delete {row.fileName}</span>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {row.fileName}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The file is removed for good. A datasheet that products
                    still use can&apos;t be deleted: detach it from them first.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={remove}>
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </TableCell>
      </TableRow>
      {hasMessage ? (
        <TableRow>
          <TableCell colSpan={6} className="px-4 py-0 whitespace-normal">
            <div className="flex flex-col gap-2 py-3 text-sm">
              <UploadMessages
                upload={upload}
                live={false}
                failedTitle="The file was not replaced"
              />
              {deleteErrors.length > 0 ? (
                <Alert variant="destructive" role="alert">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>The datasheet was not deleted</AlertTitle>
                  <AlertDescription>{deleteErrors[0]}</AlertDescription>
                </Alert>
              ) : null}
              {status !== "" ? <p>{status}</p> : null}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  );
}

export function DatasheetList({ rows }: { rows: DatasheetRowData[] }) {
  return (
    <div className="rounded-lg border">
      <Table aria-label="Datasheets">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">File name</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Uploaded by</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>Used by</TableHead>
            <TableHead className="pr-4 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <DatasheetRow key={row.id} row={row} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
