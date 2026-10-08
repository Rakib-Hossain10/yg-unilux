"use client";

// The file picker area shared by the product images editor and the area image
// uploader: a dashed drop target with one real button that opens the system
// picker. Dropping files works too; the button is the keyboard path.

import { ImagePlus } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { IMAGE_ACCEPT } from "./image-upload";

export function ImageDropZone({
  id,
  buttonLabel,
  title,
  help,
  multiple,
  blocked,
  onFiles,
  accept = IMAGE_ACCEPT,
}: {
  /** DOM id of the button (focus target after a list change). */
  id: string;
  buttonLabel: string;
  title: string;
  /** The rules line, e.g. "JPG, PNG, WebP or AVIF, up to 10 MB each." */
  help: string;
  multiple: boolean;
  /**
   * Why nothing can be added right now (limit reached, busy), or null. The
   * button stays focusable (aria-disabled) and says why in its description.
   */
  blocked: string | null;
  onFiles: (files: File[]) => void;
  /** The file input's `accept` (default: JPG, PNG, WebP, AVIF). */
  accept?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const helpId = `${id}-help`;

  const take = (list: FileList | null) => {
    const all = list ? Array.from(list) : [];
    // A drop can carry several files; a one-file picker takes the first.
    const files = multiple ? all : all.slice(0, 1);
    if (files.length > 0 && blocked === null) onFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files);
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (blocked === null) setOver(true);
      }}
      onDragLeave={(event) => {
        // Moving onto the zone's own children is not leaving it.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOver(false);
        }
      }}
      onDrop={onDrop}
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-input bg-muted px-4 py-8 text-center",
        over && "border-ring bg-background",
      )}
    >
      <span className="flex size-11 items-center justify-center rounded-full bg-background ring-1 ring-border">
        <ImagePlus aria-hidden="true" className="size-5" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        <p id={helpId} className="text-sm text-muted-foreground">
          {blocked ?? help}
        </p>
      </div>
      <Button
        type="button"
        id={id}
        variant="outline"
        aria-describedby={helpId}
        aria-disabled={blocked !== null}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        onClick={() => {
          if (blocked === null) inputRef.current?.click();
        }}
      >
        {buttonLabel}
      </Button>
      {/*
       * The real input, opened by the button above. No name attribute (it
       * never submits with a form) and out of the tab order: the button is
       * the one control keyboard and screen-reader users meet.
       */}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        tabIndex={-1}
        aria-label={buttonLabel}
        className="sr-only"
        onChange={(event) => {
          take(event.currentTarget.files);
          // Picking the same file again must fire change again.
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
