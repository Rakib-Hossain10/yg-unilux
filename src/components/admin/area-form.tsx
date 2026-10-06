"use client";

// The create/edit form for one area: name and slug. The black-and-white image
// has its own uploader on the edit page (area-image-uploader.tsx); this form
// sends the stored image id back unchanged. Same Zod schema as the server.

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

/* Fields with an input; a `bwImage` error goes to the list above the form. */
const FIELDS = ["name", "slug"] as const;
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
    /*
     * The image is not edited here: send the stored id as the page has it
     * now (the uploader refreshes the page after a change), so the save
     * keeps it. The service refuses any other id (BW_IMAGE_USE_UPLOADER).
     */
    const values = { ...form.getValues(), bwImage: area?.bwImage ?? "" };
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
                // No name: a submit before hydration would put it in the URL.
                name={undefined}
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
                name={undefined}
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
