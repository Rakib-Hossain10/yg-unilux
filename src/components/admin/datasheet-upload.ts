// Browser side of a datasheet upload (ADR 0047): the pre-checks that only save
// the admin a pointless upload, and the XHR PUT of the raw file to the
// presigned URL with progress. Client-safe: no server imports. The server
// re-checks everything: the size is signed and the content is verified when
// the upload is finalized.

import { MAX_DATASHEET_BYTES } from "@/lib/constants";

import {
  formatBytes,
  progressPercent,
  UPLOAD_FAILED,
  type UploadOutcome,
} from "./image-upload";

/**
 * What the presign action returns (the shape of `DatasheetUploadTicket` in
 * src/lib/admin/datasheets.ts, repeated so client code never imports a
 * server-only module). `uploadUrl` is a short-lived signed URL: use it once,
 * never show or log it.
 */
export interface DatasheetUploadTicket {
  uploadUrl: string;
  /** Sent with the PUT exactly as given: the signature covers them. */
  headers: { "Content-Type": string };
  /** Passed back to the finalize action. */
  incomingKey: string;
  expiresIn: number;
}

export const DATASHEET_ACCEPT =
  ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const DATASHEET_RULES_TEXT = `Excel .xlsx files only, up to ${formatBytes(MAX_DATASHEET_BYTES)}.`;

/**
 * Why this file can't be uploaded, or null when it may be. Runs BEFORE asking
 * the server for a presigned URL. Only a courtesy: the extension and the
 * browser's size prove nothing, so the server checks the file's signature.
 */
export function checkDatasheetFile(file: {
  name: string;
  size: number;
}): string | null {
  if (!/\.xlsx$/i.test(file.name) || file.name.length <= 5) {
    return `${file.name} is not an Excel .xlsx file.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_DATASHEET_BYTES) {
    return `${file.name} is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_DATASHEET_BYTES)}.`;
  }
  return null;
}

const UPLOAD_CANCELLED = "The upload was cancelled.";

/**
 * PUTs the raw file body to the presigned URL with EXACTLY the headers the
 * server returned, reporting whole percents. XMLHttpRequest, because fetch has
 * no upload progress. `signal` aborts it (the page was left). R2 answers an
 * accepted PUT with a 2xx and an empty body. Never logs: the URL is signed.
 */
export function putDatasheet(
  // Only the URL and the signed headers are used (the import reuses it).
  ticket: Pick<DatasheetUploadTicket, "uploadUrl" | "headers">,
  file: Blob,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", ticket.uploadUrl);
    for (const [name, value] of Object.entries(ticket.headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(progressPercent(event.loaded, event.total));
      }
    };
    const cancel = () => xhr.abort();
    const finish = (outcome: UploadOutcome) => {
      signal?.removeEventListener("abort", cancel);
      resolve(outcome);
    };
    xhr.onload = () =>
      finish(
        xhr.status >= 200 && xhr.status < 300
          ? { ok: true }
          : { ok: false, message: UPLOAD_FAILED },
      );
    xhr.onerror = () => finish({ ok: false, message: UPLOAD_FAILED });
    xhr.onabort = () => finish({ ok: false, message: UPLOAD_CANCELLED });
    if (signal) {
      if (signal.aborted) {
        resolve({ ok: false, message: UPLOAD_CANCELLED });
        return;
      }
      signal.addEventListener("abort", cancel, { once: true });
    }
    xhr.send(file);
  });
}
