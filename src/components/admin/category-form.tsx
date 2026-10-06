"use client";

// The create/edit form for one category: name, slug, parent (main categories
// only) and description. React Hook Form checks it with the same Zod schema
// the server re-parses; server errors land on the fields or above the form.

import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { Controller, useForm, type UseFormReturn } from "react-hook-form";

import {
  createCategoryAction,
  updateCategoryAction,
} from "@/app/admin/categories/actions";
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  categoryInputSchema,
  MAX_CATEGORY_DESCRIPTION_LENGTH,
  MAX_CATEGORY_NAME_LENGTH,
  type CategoryFormValues,
  type CategoryInput,
} from "@/lib/schemas/category";
import { MAX_SLUG_LENGTH } from "@/lib/slug";

import { callAction, type ServiceErrors } from "./action-result";
import { CATEGORIES_PATH } from "./category-paths";

/** A main category the parent picker offers. */
export interface ParentOption {
  id: string;
  name: string;
}

/** The category being edited; absent on the create page. */
export interface EditedCategory {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  description: string | null;
}

interface CategoryFormProps {
  category?: EditedCategory;
  /** Main categories only (never the edited category itself). */
  parents: ParentOption[];
  /** Create page: the parent picked in advance ("Add subcategory"). */
  defaultParentId?: string | null;
  /**
   * Why the parent can't change, e.g. the category has subcategories and so
   * must stay a main category. The picker is shown read-only with this text.
   */
  parentLockedReason?: string | null;
}

/* Radix Select can't use "" as an item value, so "none" stands for it. */
const NO_PARENT = "none";

const FIELDS = ["name", "slug", "parent", "description"] as const;
type FieldName = (typeof FIELDS)[number];

const isFieldName = (key: string): key is FieldName =>
  (FIELDS as readonly string[]).includes(key);

/**
 * Puts server errors on the form: a field's message under its input (and
 * focus on the first), anything else into the list above the form. Returns
 * that list. Exported for the tests.
 */
export function applyServerErrors(
  form: Pick<UseFormReturn<CategoryFormValues>, "setError">,
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

export function CategoryForm({
  category,
  parents,
  defaultParentId = null,
  parentLockedReason = null,
}: CategoryFormProps) {
  const editing = category !== undefined;
  const wantedParent = category ? category.parentId : defaultParentId;
  const isOffered = (id: string | null): id is string =>
    id !== null && parents.some((parent) => parent.id === id);
  /*
   * An edited category whose parent is not offered (a row left behind by a
   * missing parent) shows "none", and the form says so: saving it then
   * makes it a main category unless the admin picks a parent.
   */
  const missingParent =
    editing && wantedParent !== null && !isOffered(wantedParent);

  const form = useForm<CategoryFormValues, unknown, CategoryInput>({
    resolver: zodResolver(categoryInputSchema),
    defaultValues: {
      name: category?.name ?? "",
      slug: category?.slug ?? "",
      parent: isOffered(wantedParent) ? wantedParent : "",
      description: category?.description ?? "",
    },
  });
  const [formErrors, setFormErrors] = useState<string[]>([]);
  // Not false after a failure that may have written: don't submit it twice.
  const [saved, setSaved] = useState<boolean | "unknown">(false);
  // Pending from the first click until the redirect lands or errors return.
  const [pending, startTransition] = useTransition();
  /*
   * Set synchronously on submit: `pending` only turns true on a later render
   * (handleSubmit awaits the resolver first), so a fast double Enter would
   * otherwise send two creates. Cleared only when errors come back; on
   * success the page navigates away.
   */
  const inFlight = useRef(false);

  /*
   * The raw form strings go to the server, not the parsed values: the server
   * re-parses them with the same schema (a parsed `null` would not re-parse).
   * On success the action redirects; inside the transition Next's redirect
   * error reaches its boundary and navigates. Only failures come back here.
   * handleSubmit is called inside the event (not during render), because
   * this callback touches a ref.
   */
  const submitValid = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFormErrors([]);
    const values = form.getValues();
    startTransition(async () => {
      const result = await callAction(() =>
        editing
          ? updateCategoryAction(category.id, values)
          : createCategoryAction(values),
      );
      if (!result || result.ok) return;
      inFlight.current = false;
      setSaved(result.saved);
      setFormErrors(applyServerErrors(form, result.errors));
    });
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid)(event);

  const nameId = "category-name";
  const slugId = "category-slug";
  const parentId = "category-parent";
  const descriptionId = "category-description";

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
                  ? "The category was not saved"
                  : "The category was not created"}
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
                maxLength={MAX_CATEGORY_NAME_LENGTH}
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
                  ? "Part of the web address. Changing it changes the category's URL. Leave blank to keep the current slug."
                  : "Part of the web address, e.g. spot-lights. Leave blank to make one from the name."}
              </FieldDescription>
              <FieldError id={`${slugId}-error`} errors={[fieldState.error]} />
            </Field>
          )}
        />

        <Controller
          name="parent"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={parentId}>Parent category</FieldLabel>
              <Select
                name={field.name}
                value={field.value ? field.value : NO_PARENT}
                onValueChange={(value) =>
                  field.onChange(value === NO_PARENT ? "" : value)
                }
                disabled={parentLockedReason !== null}
              >
                <SelectTrigger
                  id={parentId}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  className="w-full sm:w-80"
                  aria-invalid={fieldState.invalid}
                  aria-describedby={`${parentId}-help${fieldState.invalid ? ` ${parentId}-error` : ""}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={NO_PARENT}>
                      None (main category)
                    </SelectItem>
                    {parents.map((parent) => (
                      <SelectItem key={parent.id} value={parent.id}>
                        {parent.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription id={`${parentId}-help`}>
                {parentLockedReason ??
                  (missingParent
                    ? "Its parent category no longer exists. Choose one, or save to make this a main category."
                    : "Choose a main category to make this a subcategory of it.")}
              </FieldDescription>
              <FieldError
                id={`${parentId}-error`}
                errors={[fieldState.error]}
              />
            </Field>
          )}
        />

        <Controller
          name="description"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={descriptionId}>
                Description (optional)
              </FieldLabel>
              <Textarea
                {...field}
                name={undefined}
                id={descriptionId}
                rows={4}
                maxLength={MAX_CATEGORY_DESCRIPTION_LENGTH}
                aria-invalid={fieldState.invalid}
                aria-describedby={
                  fieldState.invalid ? `${descriptionId}-error` : undefined
                }
              />
              <FieldError
                id={`${descriptionId}-error`}
                errors={[fieldState.error]}
              />
            </Field>
          )}
        />
      </FieldGroup>

      <div className="flex flex-wrap gap-3">
        {saved !== false ? (
          <Button asChild>
            <Link href={CATEGORIES_PATH}>Back to categories</Link>
          </Button>
        ) : (
          <>
            <Button type="submit" disabled={pending}>
              {pending
                ? "Saving…"
                : editing
                  ? "Save changes"
                  : "Create category"}
            </Button>
            <Button asChild variant="outline">
              <Link href={CATEGORIES_PATH}>Cancel</Link>
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
