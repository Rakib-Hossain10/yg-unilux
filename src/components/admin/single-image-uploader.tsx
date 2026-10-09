"use client";

// One stored image on an edit page (an area's b/w image, a category's icon or
// cover): preview, upload a new one straight to Cloudinary (sign, POST, then
// the server verifies and saves it), or remove it after a confirm. Saved at
// once, apart from any form (ADR 0046 point 8). The caller supplies the two
// server actions and the wording; this component owns the flow.

import { CircleAlert, ImageOff, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";

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
import { cn } from "@/lib/utils";

import {
  allMessages,
  callAction,
  type ActionData,
  type ActionResult,
} from "./action-result";
import { ImageDropZone } from "./image-drop-zone";
import {
  checkImageFile,
  DEFAULT_IMAGE_RULES,
  previewUrl,
  singleImageRulesText,
  uploadImage,
  type ImageFileRules,
  type PreviewFormat,
  type SignedImageUpload,
} from "./image-upload";

/** The preview frame: a 4:3 photo, a wide cover or a small square icon. */
export type PreviewShape = "photo" | "wide" | "square";

const FRAME: Record<PreviewShape, string> = {
  photo: "aspect-[4/3]",
  wide: "aspect-video",
  square: "aspect-square w-full max-w-40",
};

/* Preview widths per shape (px, fitted with c_limit). */
const PREVIEW_WIDTH: Record<PreviewShape, number> = {
  photo: 640,
  wide: 800,
  square: 320,
};

export interface SingleImageText {
  /** Section heading, e.g. "Black-and-white image". */
  heading: string;
  /** One line under the heading: where it is shown, what replacing does. */
  intro: string;
  /** The thing in every label: "image", "icon", "cover image". */
  noun: string;
  /** "a" or "an" before `noun`. */
  article: "a" | "an";
  /** Alt text of the preview, e.g. "Current black-and-white image". */
  previewAlt: string;
  /** Remove dialog body: what the site shows without it. */
  removeDescription: string;
}

export function SingleImageUploader({
  idBase,
  storedId,
  cloudName,
  text,
  sign,
  save,
  rules = DEFAULT_IMAGE_RULES,
  shape = "photo",
  previewFormat = "auto",
}: {
  /** Prefix for the DOM ids (heading, picker); unique on the page. */
  idBase: string;
  /** The stored public id, or null. Updates after each save (refresh). */
  storedId: string | null;
  /** For the preview; from the server, never a public env variable. */
  cloudName: string | null;
  text: SingleImageText;
  /** Server action: sign one upload for this image. */
  sign: () => Promise<ActionData<SignedImageUpload>>;
  /** Server action: set (verified upload) or clear (null) this image. */
  save: (publicId: string | null) => Promise<ActionResult>;
  rules?: ImageFileRules;
  shape?: PreviewShape;
  previewFormat?: PreviewFormat;
}) {
  const headingId = `${idBase}-heading`;
  const pickerId = `${idBase}-picker`;
  const { noun } = text;
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  const [pending, startTransition] = useTransition();
  const [progress, setProgress] = useState<string>("");
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<boolean | "unknown">(false);
  const [status, setStatus] = useState("");
  const [uploadCloud, setUploadCloud] = useState<string | null>(null);
  // One upload or remove at a time; set synchronously.
  const inFlight = useRef(false);
  const aborter = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    aborter.current = controller;
    return () => controller.abort();
  }, []);

  const src =
    storedId === null
      ? null
      : previewUrl(
          cloudName ?? uploadCloud,
          storedId,
          PREVIEW_WIDTH[shape],
          previewFormat,
        );

  /* Runs one step sequence with the shared guard and error handling. */
  const run = (work: () => Promise<string[] | null>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setErrors([]);
    setStatus("");
    setSaved(false);
    startTransition(async () => {
      try {
        const problems = await work();
        if (problems !== null && problems.length > 0) setErrors(problems);
      } finally {
        setProgress("");
        inFlight.current = false;
      }
    });
  };

  const upload = (files: File[]) => {
    const file = files[0];
    if (!file) return;
    const problem = checkImageFile(file, rules);
    if (problem !== null) {
      setErrors([problem]);
      setSaved(false);
      setStatus("");
      return;
    }
    run(async () => {
      setProgress("Preparing upload…");
      const signal = aborter.current?.signal;
      const signed = await callAction(sign);
      if (!signed) return null;
      if (!signed.ok) return allMessages(signed.errors);
      setUploadCloud(signed.data.cloudName);
      setProgress("Uploading 0%");
      const outcome = await uploadImage(
        signed.data,
        file,
        (percent) =>
          setProgress(percent < 100 ? `Uploading ${percent}%` : "Checking…"),
        signal,
      );
      if (signal?.aborted) return null;
      if (!outcome.ok) return [outcome.message];
      setProgress("Saving…");
      const result = await callAction(() => save(signed.data.publicId));
      if (!result) return null;
      if (!result.ok) {
        setSaved(result.saved);
        return allMessages(result.errors);
      }
      setSaved(false);
      setStatus(`${Noun} saved.`);
      return null;
    });
  };

  const remove = () =>
    run(async () => {
      const result = await callAction(() => save(null));
      if (!result) return null;
      if (!result.ok) {
        setSaved(result.saved);
        return allMessages(result.errors);
      }
      setSaved(false);
      setStatus(`${Noun} removed.`);
      // The Remove button is gone now: continue from the picker.
      document.getElementById(pickerId)?.focus();
      return null;
    });

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={pending}
      className="flex max-w-2xl flex-col gap-5 rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10 sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          {text.heading}
        </h2>
        <p className="text-muted-foreground">{text.intro}</p>
      </div>

      {errors.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>
            {saved === true
              ? "Saved, with a problem"
              : saved === "unknown"
                ? "The change could not be confirmed"
                : `The ${noun} was not changed`}
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

      <div className="grid gap-5 sm:grid-cols-2">
        <figure className="flex flex-col gap-2">
          <div
            className={cn(
              "flex items-center justify-center overflow-hidden rounded-lg bg-muted",
              FRAME[shape],
            )}
          >
            {storedId === null ? (
              <div className="flex flex-col items-center gap-2 p-2 text-center text-muted-foreground">
                <ImageOff aria-hidden="true" className="size-6" />
                <span>No {noun} yet</span>
              </div>
            ) : src !== null ? (
              // Plain <img>: the preview loads straight from
              // res.cloudinary.com (img-src allows it).
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={text.previewAlt}
                decoding="async"
                className="size-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 p-2 text-center text-muted-foreground">
                <ImageOff aria-hidden="true" className="size-6" />
                <span>Preview unavailable</span>
              </div>
            )}
          </div>
          <figcaption className="text-muted-foreground">
            {storedId === null ? `No ${noun} saved.` : `Current ${noun}.`}
          </figcaption>
        </figure>

        <div className="flex flex-col gap-3">
          <ImageDropZone
            id={pickerId}
            title={
              storedId === null
                ? `Add ${text.article} ${noun}`
                : `Replace the ${noun}`
            }
            buttonLabel={
              storedId === null ? `Choose ${noun}` : `Choose new ${noun}`
            }
            help={singleImageRulesText(rules)}
            multiple={false}
            accept={rules.accept}
            blocked={pending ? "Wait for the current change to finish." : null}
            onFiles={upload}
          />
          {storedId !== null ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  aria-disabled={pending}
                  // Busy: don't open a dialog whose confirm would do nothing.
                  onClick={(event) => {
                    if (pending) event.preventDefault();
                  }}
                  className="self-start aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                >
                  <Trash2 data-icon="inline-start" aria-hidden="true" />
                  Remove {noun}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove the {noun}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {text.removeDescription}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={remove}>
                    Remove {noun}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </div>

      <p role="status" aria-live="polite" className="min-h-5 tabular-nums">
        {progress !== "" ? progress : status}
      </p>
    </section>
  );
}
