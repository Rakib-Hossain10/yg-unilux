"use client";

// Step 1 of the import (T9): download the template, choose the filled file and
// the default category, then upload (presigned PUT with progress, exactly the
// signed Content-Type) and preview. React Hook Form checks the form with the
// server's own Zod schemas; the actions re-parse everything.

import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert, Download, FileUp } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { Controller, useForm, type UseFormReturn } from "react-hook-form";

import {
  presignImportUploadAction,
  previewImportAction,
} from "@/app/admin/import/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { callAction, type ServiceErrors } from "../action-result";
import type { CategoryOption } from "../product-new-form";
import {
  IMPORT_ACCEPT,
  IMPORT_RULES_TEXT,
  importFormSchema,
  presignInputFor,
  putImportFile,
  type ImportFormValues,
} from "./import-form";
import { IMPORT_TEMPLATE_URL } from "./import-labels";
import type { ImportPreviewView } from "./import-view";

/** The staged file the later steps work on. */
export interface ImportSource {
  key: string;
  defaultCategoryId: string;
  fileName: string;
}

/* Which server error field belongs to which input. */
const FIELD_OF: Readonly<Record<string, keyof ImportFormValues>> = {
  fileName: "file",
  size: "file",
  contentType: "file",
  defaultCategoryId: "defaultCategoryId",
};

/**
 * Puts server errors on the form: a field's message under its input (focus
 * on the first), anything else (e.g. "the uploaded file expired") into the
 * list above it. Returns that list. Exported for tests.
 */
export function applyImportErrors(
  form: Pick<UseFormReturn<ImportFormValues>, "setError">,
  errors: ServiceErrors,
): string[] {
  const formMessages = [...errors.formErrors];
  let focused = false;
  for (const [key, messages] of Object.entries(errors.fieldErrors)) {
    const message = messages[0];
    if (message === undefined) continue;
    const field = FIELD_OF[key];
    if (field === undefined) {
      formMessages.push(message);
      continue;
    }
    form.setError(
      field,
      { type: "server", message },
      { shouldFocus: !focused },
    );
    focused = true;
  }
  return formMessages;
}

export function ImportUploadStep({
  categories,
  initialErrors = [],
  onPreviewed,
}: {
  categories: CategoryOption[];
  /** Messages carried over from a later step (e.g. the category was deleted). */
  initialErrors?: string[];
  onPreviewed: (source: ImportSource, view: ImportPreviewView) => void;
}) {
  const form = useForm<ImportFormValues>({
    resolver: zodResolver(importFormSchema),
    defaultValues: { file: null, defaultCategoryId: "" },
  });
  const [formErrors, setFormErrors] = useState<string[]>(initialErrors);
  const [phase, setPhase] = useState("");
  const [percent, setPercent] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  // Set synchronously: a double submit starts one upload.
  const inFlight = useRef(false);
  const aborter = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    aborter.current = controller;
    return () => controller.abort();
  }, []);

  const submitValid = (values: ImportFormValues) => {
    const file = values.file;
    if (inFlight.current || file === null) return;
    inFlight.current = true;
    setFormErrors([]);
    startTransition(async () => {
      try {
        const signal = aborter.current?.signal;
        setPhase("Preparing the upload…");
        const presigned = await callAction(() =>
          presignImportUploadAction(presignInputFor(file)),
        );
        if (!presigned) return;
        if (!presigned.ok) {
          setFormErrors(applyImportErrors(form, presigned.errors));
          return;
        }
        setPercent(0);
        setPhase("Uploading 0%");
        const outcome = await putImportFile(
          presigned.data,
          file,
          (value) => {
            setPercent(value);
            setPhase(value < 100 ? `Uploading ${value}%` : "Reading the file…");
          },
          signal,
        );
        if (signal?.aborted) return;
        if (!outcome.ok) {
          setFormErrors([outcome.message]);
          return;
        }
        setPercent(null);
        setPhase("Reading the file and comparing it with the saved products…");
        const source: ImportSource = {
          key: presigned.data.key,
          defaultCategoryId: values.defaultCategoryId,
          fileName: file.name,
        };
        const preview = await callAction(() =>
          previewImportAction({
            key: source.key,
            defaultCategoryId: source.defaultCategoryId,
          }),
        );
        if (!preview || signal?.aborted) return;
        if (!preview.ok) {
          setFormErrors(applyImportErrors(form, preview.errors));
          return;
        }
        onPreviewed(source, preview.data);
      } finally {
        setPhase("");
        setPercent(null);
        inFlight.current = false;
      }
    });
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid)(event);

  const fileId = "import-file";
  const categoryId = "import-default-category";

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Use the template</h3>
          </CardTitle>
          <CardDescription>
            The template lists the current categories and areas as choices and
            explains each column in its header notes. Download a fresh copy
            whenever categories or areas change.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <a href={IMPORT_TEMPLATE_URL} download>
              <Download data-icon="inline-start" aria-hidden="true" />
              Download template
            </a>
          </Button>
        </CardContent>
      </Card>

      <form
        onSubmit={onSubmit}
        noValidate
        aria-busy={pending}
        className="flex flex-col gap-6"
      >
        {formErrors.length > 0 ? (
          <Alert variant="destructive" role="alert">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>The file could not be previewed</AlertTitle>
            <AlertDescription>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {formErrors.map((message, index) => (
                  <li key={`${index}-${message}`}>{message}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <FieldGroup>
          <Controller
            name="file"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor={fileId}>Excel file</FieldLabel>
                <Input
                  id={fileId}
                  ref={field.ref}
                  type="file"
                  accept={IMPORT_ACCEPT}
                  disabled={pending}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(event.currentTarget.files?.[0] ?? null)
                  }
                  aria-invalid={fieldState.invalid}
                  aria-describedby={`${fileId}-help${fieldState.invalid ? ` ${fileId}-error` : ""}`}
                />
                <FieldDescription id={`${fileId}-help`}>
                  {IMPORT_RULES_TEXT} Nothing is saved until you have checked
                  the preview.
                </FieldDescription>
                <FieldError
                  id={`${fileId}-error`}
                  errors={[fieldState.error]}
                />
              </Field>
            )}
          />

          <Controller
            name="defaultCategoryId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor={categoryId}>Default category</FieldLabel>
                <Select
                  name={field.name}
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={pending}
                >
                  <SelectTrigger
                    id={categoryId}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    className="w-full sm:w-96"
                    aria-invalid={fieldState.invalid}
                    aria-describedby={`${categoryId}-help${fieldState.invalid ? ` ${categoryId}-error` : ""}`}
                  >
                    <SelectValue placeholder="Choose a category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {categories.map((category) => (
                        <SelectItem key={category.id} value={category.id}>
                          {category.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription id={`${categoryId}-help`}>
                  Used for products whose Category cell is empty or names a
                  category that doesn&apos;t exist.
                </FieldDescription>
                <FieldError
                  id={`${categoryId}-error`}
                  errors={[fieldState.error]}
                />
              </Field>
            )}
          />
        </FieldGroup>

        <div className="flex flex-col gap-3">
          {percent !== null ? (
            <Progress value={percent} aria-label="Upload progress" />
          ) : null}
          <p
            role="status"
            aria-live="polite"
            className="min-h-5 text-sm tabular-nums"
          >
            {phase}
          </p>
          <div>
            <Button type="submit" disabled={pending}>
              <FileUp data-icon="inline-start" aria-hidden="true" />
              {pending ? "Working…" : "Upload and preview"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
