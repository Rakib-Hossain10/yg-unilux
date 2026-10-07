"use client";

// The three-step datasheet upload as one hook (ADR 0047): presign through a
// server action, PUT the raw file to R2 with progress, finalize through a
// server action. Used by the new-datasheet card and the per-row replace
// button. One upload at a time per hook; state for the messages beside it.

import { useEffect, useRef, useState, useTransition } from "react";

import {
  finalizeDatasheetAction,
  presignDatasheetUploadAction,
} from "@/app/admin/datasheets/actions";

import { allMessages, callAction } from "./action-result";
import { checkDatasheetFile, putDatasheet } from "./datasheet-upload";

export interface DatasheetUploadState {
  pending: boolean;
  /** "Uploading 45%": what is happening now; "" when idle. */
  progress: string;
  /** Why the last upload did not complete. */
  errors: string[];
  /** The write may have happened although a later step failed. */
  saved: boolean | "unknown";
  /** What the last upload did, for a polite status region. */
  status: string;
  /** Starts an upload of `file`; ignored while one is running. */
  start: (file: File) => void;
}

export function useDatasheetUpload(
  /** An existing datasheet's id to replace its file, or null for a new one. */
  replaceId: string | null,
): DatasheetUploadState {
  const [pending, startTransition] = useTransition();
  const [progress, setProgress] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<boolean | "unknown">(false);
  const [status, setStatus] = useState("");
  // Set synchronously: two fast picks start one upload.
  const inFlight = useRef(false);
  const aborter = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    aborter.current = controller;
    return () => controller.abort();
  }, []);

  const start = (file: File) => {
    if (inFlight.current) return;
    setErrors([]);
    setStatus("");
    setSaved(false);
    // A courtesy only: the server checks the size, name and file signature.
    const problem = checkDatasheetFile(file);
    if (problem !== null) {
      setErrors([problem]);
      return;
    }
    inFlight.current = true;
    startTransition(async () => {
      try {
        const signal = aborter.current?.signal;
        setProgress("Preparing upload…");
        const presigned = await callAction(() =>
          presignDatasheetUploadAction({
            fileName: file.name,
            size: file.size,
          }),
        );
        if (!presigned) return;
        if (!presigned.ok) {
          setErrors(allMessages(presigned.errors));
          return;
        }
        setProgress("Uploading 0%");
        const outcome = await putDatasheet(
          presigned.data,
          file,
          (percent) =>
            setProgress(
              percent < 100 ? `Uploading ${percent}%` : "Checking the file…",
            ),
          signal,
        );
        if (signal?.aborted) return;
        if (!outcome.ok) {
          setErrors([outcome.message]);
          return;
        }
        setProgress("Checking the file…");
        const input = {
          incomingKey: presigned.data.incomingKey,
          fileName: file.name,
          ...(replaceId === null
            ? { mode: "new" as const }
            : { mode: "replace" as const, datasheetId: replaceId }),
        };
        const result = await callAction(() => finalizeDatasheetAction(input));
        if (!result) return;
        if (!result.ok) {
          setSaved(result.saved);
          setErrors(allMessages(result.errors));
          return;
        }
        setStatus(
          replaceId === null
            ? `${file.name} uploaded.`
            : `The file was replaced with ${file.name}.`,
        );
      } finally {
        setProgress("");
        inFlight.current = false;
      }
    });
  };

  return { pending, progress, errors, saved, status, start };
}
