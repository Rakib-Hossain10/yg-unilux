"use client";

// The area's black-and-white image on its edit page (T11b): preview, upload a
// new one straight to Cloudinary (sign, POST, then the server verifies and
// saves it), or remove it after a confirm. Saved at once, apart from the form.

import { CircleAlert, ImageOff, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";

import {
  setAreaImageAction,
  signAreaImageUpload,
} from "@/app/admin/areas/actions";
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

import { allMessages, callAction } from "./action-result";
import { ImageDropZone } from "./image-drop-zone";
import {
  checkImageFile,
  previewUrl,
  SINGLE_IMAGE_RULES_TEXT,
  uploadImage,
} from "./image-upload";

const HEADING_ID = "area-image-heading";
const PICKER_ID = "area-image-picker";

export function AreaImageUploader({
  areaId,
  bwImage,
  cloudName,
}: {
  areaId: string;
  /** The stored public id, or null. Updates after each save (refresh). */
  bwImage: string | null;
  /** For the preview; from the server, never a NEXT_PUBLIC_ variable. */
  cloudName: string | null;
}) {
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
    bwImage === null
      ? null
      : previewUrl(cloudName ?? uploadCloud, bwImage, 640);

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
    const problem = checkImageFile(file);
    if (problem !== null) {
      setErrors([problem]);
      setSaved(false);
      setStatus("");
      return;
    }
    run(async () => {
      setProgress("Preparing upload…");
      const signal = aborter.current?.signal;
      const signed = await callAction(() => signAreaImageUpload(areaId));
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
      const result = await callAction(() =>
        setAreaImageAction({ areaId, publicId: signed.data.publicId }),
      );
      if (!result) return null;
      if (!result.ok) {
        setSaved(result.saved);
        return allMessages(result.errors);
      }
      setSaved(false);
      setStatus("Image saved.");
      return null;
    });
  };

  const remove = () =>
    run(async () => {
      const result = await callAction(() =>
        setAreaImageAction({ areaId, publicId: null }),
      );
      if (!result) return null;
      if (!result.ok) {
        setSaved(result.saved);
        return allMessages(result.errors);
      }
      setSaved(false);
      setStatus("Image removed.");
      // The Remove button is gone now: continue from the picker.
      document.getElementById(PICKER_ID)?.focus();
      return null;
    });

  return (
    <section
      aria-labelledby={HEADING_ID}
      aria-busy={pending}
      className="flex max-w-2xl flex-col gap-5 rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10 sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id={HEADING_ID} className="text-lg font-semibold">
          Black-and-white image
        </h2>
        <p className="text-muted-foreground">
          Shown for this area on the site. A new image replaces the current one
          as soon as it has uploaded.
        </p>
      </div>

      {errors.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>
            {saved === true
              ? "Saved, with a problem"
              : saved === "unknown"
                ? "The change could not be confirmed"
                : "The image was not changed"}
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
          <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg bg-muted">
            {bwImage === null ? (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <ImageOff aria-hidden="true" className="size-6" />
                <span>No image yet</span>
              </div>
            ) : src !== null ? (
              // Plain <img>: the preview loads straight from
              // res.cloudinary.com (img-src allows it).
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt="Current black-and-white image"
                decoding="async"
                className="size-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <ImageOff aria-hidden="true" className="size-6" />
                <span>Preview unavailable</span>
              </div>
            )}
          </div>
          <figcaption className="text-muted-foreground">
            {bwImage === null ? "No image saved." : "Current image."}
          </figcaption>
        </figure>

        <div className="flex flex-col gap-3">
          <ImageDropZone
            id={PICKER_ID}
            title={bwImage === null ? "Add an image" : "Replace the image"}
            buttonLabel={bwImage === null ? "Choose image" : "Choose new image"}
            help={SINGLE_IMAGE_RULES_TEXT}
            multiple={false}
            blocked={pending ? "Wait for the current change to finish." : null}
            onFiles={upload}
          />
          {bwImage !== null ? (
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
                  Remove image
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove the image?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The area shows no black-and-white image on the site until
                    you upload a new one.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={remove}>
                    Remove image
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
