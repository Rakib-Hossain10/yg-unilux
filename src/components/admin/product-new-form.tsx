"use client";

// The "new product" form: a name and a main category create a draft, and the
// action then opens its edit page for everything else. React Hook Form checks
// it with a Zod schema matching the service's, which re-parses on the server.

import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { Controller, useForm, type UseFormReturn } from "react-hook-form";
import { z } from "zod";

import { createDraftAction } from "@/app/admin/products/actions";
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
import { MAX_PRODUCT_NAME_LENGTH } from "@/lib/constants";
import { OBJECT_ID_PATTERN } from "@/lib/schemas/common";

import { callAction, type ServiceErrors } from "./action-result";
import { PRODUCTS_PATH } from "./product-paths";

/*
 * The same rules as createDraft's schema in src/lib/admin/products.ts (a
 * server-only file, so it can't be imported here): a trimmed name of 1 to
 * MAX_PRODUCT_NAME_LENGTH characters and an ObjectId. Only the messages are
 * friendlier. The server re-parses the raw values with its own copy.
 */
export const newProductSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name")
    .max(
      MAX_PRODUCT_NAME_LENGTH,
      `At most ${MAX_PRODUCT_NAME_LENGTH} characters`,
    ),
  mainCategory: z
    .string()
    .trim()
    .regex(OBJECT_ID_PATTERN, "Choose a main category"),
});
type NewProductValues = z.input<typeof newProductSchema>;

/** A category the picker offers; subcategories carry their parent's name. */
export interface CategoryOption {
  id: string;
  label: string;
}

const FIELDS = ["name", "mainCategory"] as const;
type FieldName = (typeof FIELDS)[number];

const isFieldName = (key: string): key is FieldName =>
  (FIELDS as readonly string[]).includes(key);

/**
 * Puts server errors on the form: a field's message under its input (and
 * focus on the first), anything else (e.g. a slug clash, which has no input
 * here) into the list above the form. Returns that list. Exported for tests.
 */
export function applyNewProductErrors(
  form: Pick<UseFormReturn<NewProductValues>, "setError">,
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

export function ProductNewForm({
  categories,
}: {
  /** Every category, main ones each followed by their subcategories. */
  categories: CategoryOption[];
}) {
  const form = useForm<NewProductValues>({
    resolver: zodResolver(newProductSchema),
    defaultValues: { name: "", mainCategory: "" },
  });
  const [formErrors, setFormErrors] = useState<string[]>([]);
  // Not false after a failure that may have written: don't create it twice.
  const [saved, setSaved] = useState<boolean | "unknown">(false);
  const [pending, startTransition] = useTransition();
  /*
   * Set synchronously on submit: `pending` only turns true on a later render
   * (handleSubmit awaits the resolver first), so a fast double Enter would
   * otherwise create two drafts. Cleared only when errors come back AND
   * nothing was written. After a failure that may have saved, it stays set:
   * hiding the button is not enough, because with a single text input Enter
   * still submits the form (HTML implicit submission). On success the action
   * redirects to the new product's edit page.
   */
  const inFlight = useRef(false);

  /*
   * The raw form strings go to the server, which re-parses them. On success
   * the action redirects; only failures come back here.
   */
  const submitValid = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFormErrors([]);
    const values = form.getValues();
    startTransition(async () => {
      const result = await callAction(() => createDraftAction(values));
      // Nothing came back to show (the action ended without a value).
      if (result === undefined) {
        inFlight.current = false;
        return;
      }
      if (result.ok) return;
      if (result.saved === false) inFlight.current = false;
      setSaved(result.saved);
      setFormErrors(applyNewProductErrors(form, result.errors));
    });
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid)(event);

  const nameId = "product-name";
  const categoryId = "product-main-category";

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
              ? "Created, with a problem"
              : saved === "unknown"
                ? "The draft could not be confirmed"
                : "The draft was not created"}
          </AlertTitle>
          <AlertDescription>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {formErrors.map((message, index) => (
                <li key={`${index}-${message}`}>{message}</li>
              ))}
            </ul>
            {saved !== false ? (
              <p className="mt-2">
                Check the products list before trying again.
              </p>
            ) : null}
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
                maxLength={MAX_PRODUCT_NAME_LENGTH}
                aria-invalid={fieldState.invalid}
                aria-describedby={`${nameId}-help${fieldState.invalid ? ` ${nameId}-error` : ""}`}
              />
              <FieldDescription id={`${nameId}-help`}>
                The product name shown on the site, e.g. Arc AR-013A. The web
                address is made from it.
              </FieldDescription>
              <FieldError id={`${nameId}-error`} errors={[fieldState.error]} />
            </Field>
          )}
        />

        <Controller
          name="mainCategory"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={categoryId}>Main category</FieldLabel>
              <Select
                name={field.name}
                // "" shows the placeholder (Radix Select's "no value").
                value={field.value}
                onValueChange={field.onChange}
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
                Where the product is listed first. Extra categories, areas,
                specs and images are added on the next page.
              </FieldDescription>
              <FieldError
                id={`${categoryId}-error`}
                errors={[fieldState.error]}
              />
            </Field>
          )}
        />
      </FieldGroup>

      <div className="flex flex-wrap gap-3">
        {saved !== false ? (
          <Button asChild>
            <Link href={PRODUCTS_PATH}>Back to products</Link>
          </Button>
        ) : (
          <>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create draft"}
            </Button>
            <Button asChild variant="outline">
              <Link href={PRODUCTS_PATH}>Cancel</Link>
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
