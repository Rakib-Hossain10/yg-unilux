// Zod schemas for the datasheet admin services (T12). Pure Zod, no
// server-only import, so the uploader can run the same checks the server
// re-runs. Object keys are never typed by the browser except the `incoming/`
// key the server itself handed out; the shape is checked here.

import { z } from "zod";

import {
  MAX_DATASHEET_BYTES,
  R2_DATASHEETS_PREFIX,
  R2_INCOMING_PREFIX,
} from "@/lib/constants";

import { objectIdSchema } from "./common";

const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** `incoming/<uuid v4>.xlsx`: where the browser's presigned PUT lands. */
export const INCOMING_KEY_PATTERN = new RegExp(
  `^${R2_INCOMING_PREFIX}${UUID_V4}\.xlsx$`,
);

/** `datasheets/<uuid v4>.xlsx`: where a verified datasheet is stored. */
export const DATASHEET_KEY_PATTERN = new RegExp(
  `^${R2_DATASHEETS_PREFIX}${UUID_V4}\.xlsx$`,
);

export const MAX_DATASHEET_FILE_NAME_LENGTH = 255;

/*
 * A display and download name: no path parts, no control characters, must
 * end in .xlsx. Trimmed. It is only a label; the object key never uses it.
 */
export const datasheetFileNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a file name")
  .max(
    MAX_DATASHEET_FILE_NAME_LENGTH,
    `At most ${MAX_DATASHEET_FILE_NAME_LENGTH} characters`,
  )
  .refine((name) => !/[\/\u0000-\u001f\u007f]/.test(name), {
    message: "The name cannot contain slashes or control characters",
  })
  .refine((name) => /\.xlsx$/i.test(name) && name.length > 5, {
    message: "The file must be an Excel .xlsx file",
  });

export const incomingKeySchema = z
  .string()
  .regex(INCOMING_KEY_PATTERN, "Not an upload made through this site");

/** Step 1: ask for a presigned upload. */
export const presignDatasheetInputSchema = z.strictObject({
  fileName: datasheetFileNameSchema,
  size: z
    .number()
    .int("The size must be whole bytes")
    .min(1, "The file is empty")
    .max(
      MAX_DATASHEET_BYTES,
      `The file is larger than ${MAX_DATASHEET_BYTES / (1024 * 1024)} MB`,
    ),
});
export type PresignDatasheetInput = z.infer<typeof presignDatasheetInputSchema>;

/** Step 3: finalize an upload as a new datasheet or as a replacement. */
export const finalizeDatasheetInputSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("new"),
    incomingKey: incomingKeySchema,
    fileName: datasheetFileNameSchema,
  }),
  z.strictObject({
    mode: z.literal("replace"),
    datasheetId: objectIdSchema,
    incomingKey: incomingKeySchema,
    fileName: datasheetFileNameSchema,
  }),
]);
export type FinalizeDatasheetInput = z.infer<
  typeof finalizeDatasheetInputSchema
>;

export const renameDatasheetInputSchema = z.strictObject({
  id: objectIdSchema,
  fileName: datasheetFileNameSchema,
});

export const datasheetIdSchema = objectIdSchema;
