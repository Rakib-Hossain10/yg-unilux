"use client";

// The product images section (T11b): upload straight to Cloudinary, then edit
// alt text, kind and order in a card grid, and save the full ordered list
// with its own Save button, independent of the main product form (ADR 0045).

import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  ImageOff,
  Trash2,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  saveProductImagesAction,
  signProductImageUpload,
} from "@/app/admin/products/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { MAX_IMAGE_ALT_LENGTH, MAX_PRODUCT_IMAGES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { ProductImageKind } from "@/models/product-constants";

import { allMessages, callAction } from "../action-result";
import { useClearNotice } from "../clear-notice";
import { ImageDropZone } from "../image-drop-zone";
import {
  checkImageFile,
  IMAGE_RULES_TEXT,
  previewUrl,
  uploadImage,
} from "../image-upload";
import { NATIVE_SELECT_CLASS } from "../native-select";
import {
  buildSavePayload,
  checkImages,
  countText,
  hasUnsavedChanges,
  IMAGE_KIND_LABELS,
  isImageKind,
  KIND_OPTIONS,
  mapSaveErrors,
  moveImage,
  newImage,
  remainingSlots,
  removeImage,
  toEditorImages,
  unsavedIds,
  updateImage,
  type CardErrors,
  type EditorImage,
  type StoredImage,
} from "./images-state";
import { indexAfterRemove, useFocusAfterRender } from "./row-controls";
import { sectionAnchor } from "./status-links";

/** One file on its way to Cloudinary, or one that could not be added. */
interface UploadItem {
  key: string;
  name: string;
  /** Whole percent while uploading; null while waiting or after a failure. */
  percent: number | null;
  error: string | null;
}

const PICKER_ID = "product-images-picker";

/* The errors without one card's message for `field` (same map if none). */
function withoutCardError(
  current: Map<string, CardErrors>,
  publicId: string,
  field: keyof CardErrors,
): Map<string, CardErrors> {
  const errors = current.get(publicId);
  if (!errors?.[field]) return current;
  const next = new Map(current);
  next.set(publicId, { ...errors, [field]: undefined });
  return next;
}

/* Stable, readable DOM ids per card: the public id's uuid part. */
function cardId(publicId: string): string {
  return `product-image-${publicId.slice(publicId.lastIndexOf("/") + 1)}`;
}

export function ImagesEditor({
  productId,
  version,
  stored,
  cloudName,
  published,
}: {
  productId: string;
  /** The product's updatedAt as the page loaded it (optimistic concurrency). */
  version: string;
  stored: StoredImage[];
  /** For previews; from the server, never a public env variable. */
  cloudName: string | null;
  /** A published product must keep at least one image. */
  published: boolean;
}) {
  const saved = useMemo(() => toEditorImages(stored), [stored]);
  const [list, setList] = useState<readonly EditorImage[]>(saved);
  /*
   * When a save (or another write) re-renders the page, the editor adopts the
   * stored list, unless the admin has unsaved edits here, which are kept.
   * Done during render (React's "adjust state on prop change" pattern), so
   * there is no flash of the old list.
   */
  const [lastSaved, setLastSaved] = useState(saved);
  if (lastSaved !== saved) {
    setLastSaved(saved);
    if (!hasUnsavedChanges(lastSaved, list)) setList(saved);
  }

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploadCloud, setUploadCloud] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Map<string, CardErrors>>(
    () => new Map(),
  );
  const [messages, setMessages] = useState<string[]>([]);
  const [savedFlag, setSavedFlag] = useState<boolean | "unknown">(false);
  const [status, setStatus] = useState("");
  const [saving, startSave] = useTransition();
  const [, startUpload] = useTransition();
  const focusLater = useFocusAfterRender();
  const clearNotice = useClearNotice();
  const alertRef = useRef<HTMLDivElement>(null);
  const [alertFocus, setAlertFocus] = useState(0);
  const headingId = useId();

  // The current list for async code (a save's result arrives later).
  const listRef = useRef(list);
  useEffect(() => {
    listRef.current = list;
  }, [list]);
  // One save at a time; set synchronously so a double click sends one.
  const inFlight = useRef(false);
  // Files waiting to upload, worked through one at a time.
  const queue = useRef<{ key: string; file: File }[]>([]);
  const draining = useRef(false);
  const aborter = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    aborter.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (alertFocus > 0) alertRef.current?.focus();
  }, [alertFocus]);

  const dirty = hasUnsavedChanges(saved, list);
  const fresh = unsavedIds(saved, list);
  const activeUploads = uploads.filter((item) => item.error === null).length;
  const slots = remainingSlots(list.length, activeUploads);
  const cloud = cloudName ?? uploadCloud;
  // Save waits for uploads to finish and needs something to save.
  const saveBlocked = activeUploads > 0 || saving || !dirty;

  // Leaving with unsaved images would orphan them: ask the browser to warn.
  useEffect(() => {
    if (!dirty && activeUploads === 0) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, activeUploads]);

  const patchUpload = (key: string, change: Partial<UploadItem>) =>
    setUploads((items) =>
      items.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );

  /*
   * Works through the queue: sign one file (the server picks its id), POST
   * it to Cloudinary with progress, then add its card. Runs inside a
   * transition so a redirect from the sign action (session expired) reaches
   * Next's router.
   */
  const drain = () => {
    if (draining.current) return;
    draining.current = true;
    startUpload(async () => {
      try {
        let next = queue.current.shift();
        while (next !== undefined) {
          const { key, file } = next;
          const signal = aborter.current?.signal;
          const signed = await callAction(() =>
            signProductImageUpload(productId),
          );
          if (signal?.aborted) return;
          if (!signed) return;
          if (!signed.ok) {
            patchUpload(key, {
              error: allMessages(signed.errors).join(" "),
              percent: null,
            });
          } else {
            patchUpload(key, { percent: 0 });
            setUploadCloud(signed.data.cloudName);
            const outcome = await uploadImage(
              signed.data,
              file,
              (percent) => patchUpload(key, { percent }),
              signal,
            );
            if (signal?.aborted) return;
            if (outcome.ok) {
              setUploads((items) => items.filter((item) => item.key !== key));
              setList((current) => [
                ...current,
                newImage(signed.data.publicId),
              ]);
              setStatus(
                `${file.name} uploaded. Add its alt text, then save the images.`,
              );
            } else {
              patchUpload(key, { error: outcome.message, percent: null });
            }
          }
          next = queue.current.shift();
        }
      } finally {
        draining.current = false;
      }
    });
  };

  const addFiles = (files: File[]) => {
    let room = slots;
    const items: UploadItem[] = [];
    for (const file of files) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const problem =
        checkImageFile(file) ??
        (room <= 0
          ? `${file.name} was not added: a product can have at most ${MAX_PRODUCT_IMAGES} images.`
          : null);
      items.push({ key, name: file.name, percent: null, error: problem });
      if (problem === null) {
        room -= 1;
        queue.current.push({ key, file });
      }
    }
    setUploads((current) => [...current, ...items]);
    const accepted = items.filter((item) => item.error === null).length;
    setStatus(
      accepted === 0
        ? "No files were added."
        : `Uploading ${accepted} ${accepted === 1 ? "file" : "files"}.`,
    );
    if (accepted > 0) drain();
  };

  // Editing a field clears its error and any stale announcement.
  const onAlt = useCallback((publicId: string, alt: string) => {
    setList((current) => updateImage(current, publicId, { alt }));
    setCardErrors((current) => withoutCardError(current, publicId, "alt"));
    setStatus("");
  }, []);

  const onKind = useCallback((publicId: string, kind: ProductImageKind) => {
    setList((current) => updateImage(current, publicId, { kind }));
    setCardErrors((current) => withoutCardError(current, publicId, "kind"));
    setStatus("");
  }, []);

  const onMove = useCallback(
    (index: number, direction: "up" | "down") => {
      const current = listRef.current;
      const moved = moveImage(current, index, direction);
      if (moved === current) return;
      const image = current[index]!;
      setList(moved);
      const position = direction === "up" ? index : index + 2;
      setStatus(`Image moved to position ${position} of ${current.length}.`);
      // The card's DOM node may be re-inserted: give focus back to the button.
      focusLater(
        `${cardId(image.publicId)}-${direction === "up" ? "earlier" : "later"}`,
      );
    },
    [focusLater],
  );

  const onRemove = useCallback(
    (index: number) => {
      const current = listRef.current;
      const image = current[index];
      if (!image) return;
      setList(removeImage(current, image.publicId));
      setStatus(
        `Image ${index + 1} removed. It stays on the product until you save.`,
      );
      const after = indexAfterRemove(index, current.length);
      const target =
        after === null
          ? null
          : current.filter((item) => item.publicId !== image.publicId)[after];
      focusLater(target ? `${cardId(target.publicId)}-alt` : PICKER_ID);
    },
    [focusLater],
  );

  const discard = () => {
    if (saving) return;
    setList(saved);
    setCardErrors(new Map());
    setMessages([]);
    setSavedFlag(false);
    setStatus("Changes discarded.");
  };

  const save = () => {
    if (inFlight.current || saveBlocked) return;
    setMessages([]);
    setStatus("");
    const local = checkImages(list);
    if (local.size > 0) {
      setCardErrors(local);
      setSavedFlag(false);
      const first = list.find((image) => local.has(image.publicId));
      setStatus(
        `Add alt text to ${local.size === 1 ? "1 image" : `${local.size} images`} before saving.`,
      );
      if (first) focusLater(`${cardId(first.publicId)}-alt`);
      return;
    }
    inFlight.current = true;
    const sent = list;
    startSave(async () => {
      try {
        const result = await callAction(() =>
          saveProductImagesAction(buildSavePayload(productId, sent), version),
        );
        if (!result) return;
        clearNotice();
        if (result.ok) {
          setCardErrors(new Map());
          setSavedFlag(false);
          setStatus("Images saved.");
          return;
        }
        setSavedFlag(result.saved);
        const mapped = mapSaveErrors(result.errors, sent, listRef.current);
        setCardErrors(mapped.cards);
        setMessages(mapped.messages);
        const first = sent.find((image) => mapped.cards.get(image.publicId));
        if (mapped.messages.length > 0 || !first) {
          setAlertFocus((count) => count + 1);
        } else {
          focusLater(`${cardId(first.publicId)}-alt`);
        }
      } finally {
        inFlight.current = false;
      }
    });
  };

  const blocked =
    slots > 0
      ? null
      : `This product has the maximum of ${MAX_PRODUCT_IMAGES} images. Remove one to add another.`;

  return (
    <section
      id={sectionAnchor("images")}
      tabIndex={-1}
      aria-labelledby={headingId}
      aria-busy={saving}
      className="flex flex-col rounded-xl bg-card text-sm text-card-foreground ring-1 ring-foreground/10 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 pt-4 sm:px-6 sm:pt-6">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-lg font-semibold">
            Images
          </h2>
          <p className="max-w-prose text-muted-foreground">
            The first image leads the product page. Every image needs alt text
            that says what it shows. Changes here are saved with &ldquo;Save
            images&rdquo;, separately from the product details.
          </p>
        </div>
        <p className="shrink-0 pt-1 text-muted-foreground tabular-nums">
          {countText(list.length)}
        </p>
      </header>

      <div className="flex flex-col gap-6 px-4 py-6 sm:px-6">
        {messages.length > 0 ? (
          <Alert
            ref={alertRef}
            tabIndex={-1}
            variant="destructive"
            role="alert"
          >
            <CircleAlert aria-hidden="true" />
            <AlertTitle>
              {savedFlag === true
                ? "Saved, with a problem"
                : savedFlag === "unknown"
                  ? "The change could not be confirmed"
                  : "The images were not saved"}
            </AlertTitle>
            <AlertDescription>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {messages.map((message, index) => (
                  <li key={`${index}-${message}`}>{message}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <ImageDropZone
          id={PICKER_ID}
          title="Add product photos"
          buttonLabel="Choose images"
          help={`${IMAGE_RULES_TEXT} Drop files here or choose them.`}
          multiple
          blocked={blocked}
          onFiles={addFiles}
        />

        {uploads.length > 0 ? (
          <UploadList
            items={uploads}
            onDismiss={(key) =>
              setUploads((items) => items.filter((item) => item.key !== key))
            }
          />
        ) : null}

        {list.length === 0 ? (
          <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed px-4 py-10 text-center">
            <p className="font-medium">No images yet</p>
            <p className="max-w-prose text-muted-foreground">
              {published
                ? "A published product needs at least one image."
                : "Add at least one image before publishing."}
            </p>
          </div>
        ) : (
          <ol
            aria-label="Images in display order"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          >
            {list.map((image, index) => (
              <ImageCard
                key={image.publicId}
                image={image}
                index={index}
                count={list.length}
                src={previewUrl(cloud, image.publicId)}
                unsaved={fresh.has(image.publicId)}
                errors={cardErrors.get(image.publicId)}
                onAlt={onAlt}
                onKind={onKind}
                onMove={onMove}
                onRemove={onRemove}
              />
            ))}
          </ol>
        )}
      </div>

      {/*
       * The section's own save bar. Sticky, so Save stays in reach while the
       * admin works down a long grid; not inside a <form>, so a click before
       * hydration does nothing instead of submitting.
       */}
      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t bg-background px-4 py-3 sm:px-6">
        <p role="status" aria-live="polite" className="min-w-0 text-sm">
          {status !== ""
            ? status
            : dirty
              ? fresh.size > 0
                ? `${fresh.size} new ${fresh.size === 1 ? "image is" : "images are"} not saved yet.`
                : "You have unsaved changes."
              : activeUploads > 0
                ? "Uploading…"
                : "All images are saved."}
        </p>
        <div className="flex flex-wrap gap-2">
          {dirty ? (
            <Button
              type="button"
              variant="outline"
              onClick={discard}
              aria-disabled={saving}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
              Discard changes
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={save}
            aria-disabled={saveBlocked}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save images"}
          </Button>
        </div>
      </div>
    </section>
  );
}

/* Files being uploaded or refused, with progress text and a static bar. */
function UploadList({
  items,
  onDismiss,
}: {
  items: UploadItem[];
  onDismiss: (key: string) => void;
}) {
  return (
    <ul aria-label="Uploads" className="flex flex-col gap-2">
      {items.map((item) => (
        <li
          key={item.key}
          className={cn(
            "flex flex-col gap-2 rounded-lg border px-3 py-2",
            item.error !== null && "border-destructive",
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate font-medium">{item.name}</p>
            {item.error === null ? (
              <p className="shrink-0 text-muted-foreground tabular-nums">
                {item.percent === null
                  ? "Waiting…"
                  : item.percent < 100
                    ? `Uploading ${item.percent}%`
                    : "Finishing…"}
              </p>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onDismiss(item.key)}
                aria-label={`Dismiss the message about ${item.name}`}
              >
                Dismiss
              </Button>
            )}
          </div>
          {item.error === null ? (
            <div
              aria-hidden="true"
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              {/* No transition: the bar jumps to each new value. */}
              <div
                className="h-full bg-primary"
                style={{ width: `${item.percent ?? 0}%` }}
              />
            </div>
          ) : (
            <p className="text-destructive">{item.error}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/*
 * One image card: preview with its position and kind, the alt text and kind
 * fields, and move/remove buttons. Memoised with stable callbacks, so typing
 * in one card doesn't re-render the others.
 */
const ImageCard = memo(function ImageCard({
  image,
  index,
  count,
  src,
  unsaved,
  errors,
  onAlt,
  onKind,
  onMove,
  onRemove,
}: {
  image: EditorImage;
  index: number;
  count: number;
  src: string | null;
  unsaved: boolean;
  errors: CardErrors | undefined;
  onAlt: (publicId: string, alt: string) => void;
  onKind: (publicId: string, kind: ProductImageKind) => void;
  onMove: (index: number, direction: "up" | "down") => void;
  onRemove: (index: number) => void;
}) {
  const id = cardId(image.publicId);
  const name = `image ${index + 1}`;
  const isFirst = index === 0;
  const isLast = index === count - 1;
  const altInvalid = Boolean(errors?.alt);
  const kindInvalid = Boolean(errors?.kind);
  const problem = errors?.publicId;

  return (
    <li
      aria-labelledby={`${id}-title`}
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-background",
        (problem || altInvalid || kindInvalid) && "border-destructive",
      )}
    >
      <div className="relative aspect-[4/3] bg-muted">
        {src !== null ? (
          // Plain <img>: the preview comes straight from res.cloudinary.com
          // (img-src allows it); next/image is only configured when
          // CLOUDINARY_URL is set at build time.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-contain p-3"
          />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <ImageOff aria-hidden="true" className="size-6" />
            <span>Preview unavailable</span>
          </div>
        )}
        <div className="absolute top-2 left-2 flex flex-wrap gap-1.5">
          <Badge id={`${id}-title`} className="tabular-nums">
            <span className="sr-only">Image </span>
            {index + 1}
          </Badge>
          <Badge variant="outline" className="bg-background">
            {IMAGE_KIND_LABELS[image.kind]}
          </Badge>
        </div>
        {unsaved ? (
          <Badge
            variant="outline"
            className="absolute top-2 right-2 bg-background"
          >
            Not saved yet
          </Badge>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-4 p-4">
        {problem ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}

        <Field data-invalid={altInvalid}>
          <div className="flex items-baseline justify-between gap-2">
            <FieldLabel htmlFor={`${id}-alt`}>Alt text</FieldLabel>
            <span
              aria-hidden="true"
              className="text-xs text-muted-foreground tabular-nums"
            >
              {image.alt.length}/{MAX_IMAGE_ALT_LENGTH}
            </span>
          </div>
          <Textarea
            id={`${id}-alt`}
            value={image.alt}
            rows={2}
            required
            maxLength={MAX_IMAGE_ALT_LENGTH}
            autoComplete="off"
            placeholder="e.g. Arc spotlight in black, front view"
            className="min-h-16"
            aria-invalid={altInvalid}
            aria-describedby={altInvalid ? `${id}-alt-error` : undefined}
            onChange={(event) => onAlt(image.publicId, event.target.value)}
          />
          <FieldError
            id={`${id}-alt-error`}
            errors={[errors?.alt ? { message: errors.alt } : undefined]}
          />
        </Field>

        <Field data-invalid={kindInvalid}>
          <FieldLabel htmlFor={`${id}-kind`}>Shows</FieldLabel>
          <select
            id={`${id}-kind`}
            value={image.kind}
            className={NATIVE_SELECT_CLASS}
            aria-invalid={kindInvalid}
            aria-describedby={kindInvalid ? `${id}-kind-error` : undefined}
            onChange={(event) => {
              const value = event.target.value;
              if (isImageKind(value)) onKind(image.publicId, value);
            }}
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <FieldError
            id={`${id}-kind-error`}
            errors={[errors?.kind ? { message: errors.kind } : undefined]}
          />
        </Field>

        <div className="mt-auto flex items-center justify-between gap-2 border-t pt-3">
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon"
              id={`${id}-earlier`}
              aria-label={`Move ${name} earlier`}
              aria-disabled={isFirst}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onClick={() => {
                if (!isFirst) onMove(index, "up");
              }}
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              id={`${id}-later`}
              aria-label={`Move ${name} later`}
              aria-disabled={isLast}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onClick={() => {
                if (!isLast) onMove(index, "down");
              }}
            >
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            id={`${id}-remove`}
            aria-label={`Remove ${name}`}
            onClick={() => onRemove(index)}
          >
            <Trash2 data-icon="inline-start" aria-hidden="true" />
            Remove
          </Button>
        </div>
      </div>
    </li>
  );
});
