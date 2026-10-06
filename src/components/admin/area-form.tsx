"use client";

// The create/edit form for one area: name, slug and the black-and-white
// image's Cloudinary public id (a plain text field until the uploader lands).
// React Hook Form checks it with the same Zod schema the server re-parses.

import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { Controller, useForm, type UseFormReturn } from "react-hook-form";

import { createAreaAction, updateAreaAction } from "@/app/admin/areas/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  areaInputSchema,
  MAX_AREA_BW_IMAGE_LENGTH,
  MAX_AREA_NAME_LENGTH,
  type AreaFormValues,
  type AreaInput,
} from "@/lib/schemas/area";
import { MAX_SLUG_LENGTH } from "@/lib/slug";

import { callAction, type ServiceErrors } from "./action-result";
import { AREAS_PATH } from "./area-paths";

/** The area being edited; absent on the create page. */
export interface EditedArea {
  id: string;
  name: string;
  slug: string;
  bwImage: string | null;
}

const FIELDS = ["name", "slug", "bwImage"] as const;
type FieldName = (typeof FIELDS)[number];

const isFieldName = (key: string): key is FieldName =>
  (FIELDS as readonly string[]).includes(key);

/*
 * Puts server errors on the form: a field's message under its input (and
 * focus on the first), anything else into the list above the form. Returns
 * that list.
 */
function applyServerErrors(
  form: Pick<UseFormReturn<AreaFormValues>, "setError">,
  errors: ServiceErrors,
): string[] {
  const formMessages = [...errors.formErrors];
  let focused = false;
  for (const [key, messages] of Object.entries(errors.fieldErrors)) {
    const message = messages[0];
    if (message === undefined) continue;
    if (isFieldName(key)) {
      form.setError(
        key,
        { type: "server", message },
        { shouldFocus: !focused },
      );
      focused = true;
    } else {
      formMessages.push(message);
    }
  }
  return formMessages;
}

export function AreaForm({ area }: { area?: EditedArea }) {
  const editing = area !== undefined;

  const form = useForm<AreaFormValues, unknown, AreaInput>({
    resolver: zodResolver(areaInputSchema),
    defaultValues: {
      name: area?.name ?? "",
      slug: area?.slug ?? "",
      bwImage: area?.bwImage ?? "",
    },
  });
  const [formErrors, setFormErrors] = useState<string[]>([]);
  // Not false after a failure that may have written: don't submit it twice.
  const [saved, setSaved] = useState<boolean | "unknown">(false);
  const [pending, startTransition] = useTransition();
  /*
   * Set synchronously on submit: `pending` only turns true on a later render
   * (handleSubmit awaits the resolver first), so a fast double Enter would
   * otherwise send two creates. Cleared only when errors come back.
   */
  const inFlight = useRef(false);

  /*
   * The raw form strings go to the server, which re-parses them with the
   * same schema. On success the action redirects; only failures return here.
   */
  const submitValid = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFormErrors([]);
    const values = form.getValues();
    startTransition(async () => {
      const result = await callAction(() =>
        editing ? updateAreaAction(area.id, values) : createAreaAction(values),
      );
      if (!result || result.ok) return;
      inFlight.current = false;
      setSaved(result.saved);
      setFormErrors(applyServerErrors(form, result.errors));
    });
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid)(event);

  const nameId = "area-name";
  const slugId = "area-slug";
  const imageId = "area-bw-image";

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-busy={pending}
      className="flex max-w-2xl flex-col gap-6"
    >
      {formErrors.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>
            {saved === true
              ? "Saved, with a problem"
              : saved === "unknown"
                ? "The change could not be confirmed"
                : editing
                  ? "The area was not saved"
                  : "The area was not created"}
          </AlertTitle>
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
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={nameId}>Name</FieldLabel>
              <Input
                {...field}
                id={nameId}
                autoComplete="off"
                required
                maxLength={MAX_AREA_NAME_LENGTH}
                aria-invalid={fieldState.invalid}
                aria-describedby={
                  fieldState.invalid ? `${nameId}-error` : undefined
                }
              />
              <FieldError id={`${nameId}-error`} errors={[fieldState.error]} />
            </Field>
          )}
        />

        <Controller
          name="slug"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={slugId}>Slug</FieldLabel>
              <Input
                {...field}
                id={slugId}
                autoComplete="off"
                spellCheck={false}
                maxLength={MAX_SLUG_LENGTH}
                aria-invalid={fieldState.invalid}
                aria-describedby={`${slugId}-help${fieldState.invalid ? ` ${slugId}-error` : ""}`}
              />
              <FieldDescription id={`${slugId}-help`}>
                {editing
                  ? "Part of the web address. Changing it changes the area's URL. Leave blank to keep the current slug."
                  : "Part of the web address, e.g. residential. Leave blank to make one from the name."}
              </FieldDescription>
              <FieldError id={`${slugId}-error`} errors={[fieldState.error]} />
            </Field>
          )}
        />

        <Controller
          name="bwImage"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={imageId}>
                Black-and-white image (optional)
              </FieldLabel>
              <Input
                {...field}
                value={field.value ?? ""}
                id={imageId}
                autoComplete="off"
                spellCheck={false}
                maxLength={MAX_AREA_BW_IMAGE_LENGTH}
                aria-invalid={fieldState.invalid}
                aria-describedby={`${imageId}-help${fieldState.invalid ? ` ${imageId}-error` : ""}`}
              />
              <FieldDescription id={`${imageId}-help`}>
                The image&apos;s Cloudinary public id. An upload button comes
                later.
              </FieldDescription>
              <FieldError id={`${imageId}-error`} errors={[fieldState.error]} />
            </Field>
          )}
        />
      </FieldGroup>

      <div className="flex flex-wrap gap-3">
        {saved !== false ? (
          <Button asChild>
            <Link href={AREAS_PATH}>Back to areas</Link>
          </Button>
        ) : (
          <>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : editing ? "Save changes" : "Create area"}
            </Button>
            <Button asChild variant="outline">
              <Link href={AREAS_PATH}>Cancel</Link>
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
