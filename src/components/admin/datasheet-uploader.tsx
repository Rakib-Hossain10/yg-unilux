"use client";

// Datasheet upload controls (T13): the "new datasheet" card on the list page,
// the confirmed "Replace file" button of each row, and the shared status and
// error messages. The upload itself is use-datasheet-upload.ts (presign, PUT
// to R2 with progress, finalize). No URL or storage key is ever shown.

import { CircleAlert, FileUp, Upload } from "lucide-react";
import { useRef } from "react";

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

import { DATASHEET_ACCEPT, DATASHEET_RULES_TEXT } from "./datasheet-upload";
import {
  useDatasheetUpload,
  type DatasheetUploadState,
} from "./use-datasheet-upload";

/*
 * The real file input, opened by a button. No name attribute (it never submits
 * with a form) and out of the tab order: the button is the one control
 * keyboard and screen-reader users meet.
 */
function HiddenFileInput({
  inputRef,
  label,
  onFile,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  label: string;
  onFile: (file: File) => void;
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept={DATASHEET_ACCEPT}
      tabIndex={-1}
      aria-label={label}
      className="sr-only"
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        // Picking the same file again must fire change again.
        event.currentTarget.value = "";
        if (file) onFile(file);
      }}
    />
  );
}

/** The failure alert and the polite progress/status line of one uploader. */
export function UploadMessages({
  upload,
  failedTitle,
  live = true,
}: {
  upload: DatasheetUploadState;
  failedTitle: string;
  /** False when the caller keeps its own always-mounted live region. */
  live?: boolean;
}) {
  const { errors, saved, progress, status } = upload;
  return (
    <>
      {errors.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>
            {saved === true
              ? "Saved, with a problem"
              : saved === "unknown"
                ? "The change could not be confirmed"
                : failedTitle}
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
      <p
        {...(live ? { role: "status", "aria-live": "polite" as const } : {})}
        className="min-h-5 tabular-nums"
      >
        {progress !== "" ? progress : status}
      </p>
    </>
  );
}

/** "Upload a datasheet": the card above the list. Creates a new datasheet. */
export function DatasheetUploader() {
  const upload = useDatasheetUpload(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const helpId = "datasheet-upload-help";

  return (
    <section
      aria-labelledby="datasheet-upload-heading"
      aria-busy={upload.pending}
      className="flex max-w-2xl flex-col gap-4 rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10 sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id="datasheet-upload-heading" className="text-lg font-semibold">
          Upload a datasheet
        </h2>
        <p id={helpId} className="text-muted-foreground">
          {DATASHEET_RULES_TEXT} Customers with access can download it from the
          products it is attached to.
        </p>
      </div>

      <UploadMessages upload={upload} failedTitle="The file was not uploaded" />

      <div>
        <Button
          type="button"
          aria-describedby={helpId}
          aria-disabled={upload.pending}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onClick={() => {
            if (!upload.pending) inputRef.current?.click();
          }}
        >
          <FileUp data-icon="inline-start" aria-hidden="true" />
          Choose Excel file
        </Button>
        <HiddenFileInput
          inputRef={inputRef}
          label="Choose Excel file"
          onFile={upload.start}
        />
      </div>
    </section>
  );
}

/**
 * "Replace file" for one datasheet row: confirms first (every product using
 * it gets the new file at once), then opens the file picker. The stored key
 * and the products' links stay the same.
 */
export function ReplaceFileButton({
  name,
  upload,
}: {
  name: string;
  upload: DatasheetUploadState;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={upload.pending}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={(event) => {
              // Busy: don't open a dialog whose confirm would do nothing.
              if (upload.pending) event.preventDefault();
            }}
          >
            <Upload data-icon="inline-start" aria-hidden="true" />
            Replace<span className="sr-only"> file of {name}</span>
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the file of {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every product that uses this datasheet gets the new file as soon
              as it is uploaded. The old file cannot be restored.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => inputRef.current?.click()}>
              Choose new file
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <HiddenFileInput
        inputRef={inputRef}
        label={`Choose the replacement file for ${name}`}
        onFile={upload.start}
      />
    </>
  );
}
