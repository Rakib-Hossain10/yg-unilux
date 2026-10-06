"use client";

// The product edit form (T10a): status card, Basics, Categories and areas,
// Filters, a read-only variants list, Save and Delete. The client sends JSON;
// the Server Action re-parses it with productInputSchema (rule 8).

import { CircleAlert } from "lucide-react";
import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import {
  FormProvider,
  useForm,
  useWatch,
  type FieldErrors,
} from "react-hook-form";

import { updateProductAction } from "@/app/admin/products/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  productInputSchema,
  type ProductFormValues,
} from "@/lib/schemas/product";
import type { ProductStatus } from "@/models/product-constants";

import { callAction } from "../action-result";
import { useClearNotice } from "../clear-notice";
import { PRODUCTS_PATH } from "../product-paths";
import { BasicsSection } from "./basics-section";
import { CategoriesSection, type PickerOption } from "./categories-section";
import { DeleteProduct } from "./delete-product";
import {
  applyServerErrors,
  flattenFormErrors,
  productEditResolver,
  splitMessages,
} from "./field-errors";
import { FiltersSection } from "./filters-section";
import {
  allowsTrackSize,
  sameParsedInput,
  toFormState,
  toProductInput,
  type ProductEditValues,
} from "./form-values";
import { isRenderedField } from "./sections";
import { StatusPanel } from "./status-panel";
import { VariantsSummary } from "./variants-summary";

/** The product as the edit page loaded it (plain JSON from the server). */
export interface EditedProduct {
  id: string;
  status: ProductStatus;
  values: ProductFormValues;
  updatedAt: string;
}

export function ProductEditForm({
  product,
  categories,
  areas,
  magneticTrackIds,
  publishProblems,
}: {
  product: EditedProduct;
  /** Every category, main ones each followed by "Main › Sub" entries. */
  categories: PickerOption[];
  areas: PickerOption[];
  /** Magnetic Track and its subcategories (the track-size rule). */
  magneticTrackIds: string[];
  /** publishCheck() on the saved product, for the status card. */
  publishProblems: string[];
}) {
  const initial = useMemo(() => toFormState(product.values), [product.values]);
  const magnetic = useMemo(() => new Set(magneticTrackIds), [magneticTrackIds]);
  const resolver = useMemo(() => productEditResolver(magnetic), [magnetic]);
  /*
   * `values` (not defaultValues): when a save or publish re-renders the page
   * with new server data, the form resets to it, so isDirty and the
   * round-tripped fields always match what is stored.
   */
  const form = useForm<ProductEditValues>({ resolver, values: initial });

  const [mainCategory, extraCategories] = useWatch({
    control: form.control,
    name: ["mainCategory", "extraCategories"],
  });
  const showTrackSize = allowsTrackSize(
    { mainCategory, extraCategories },
    magnetic,
  );
  const rendered = (field: string) =>
    isRenderedField(field, { trackSize: showTrackSize });

  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<boolean | "unknown">(false);
  const [info, setInfo] = useState("");
  const [pending, startTransition] = useTransition();
  // Set synchronously on submit, so a fast double Enter sends one save.
  const inFlight = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);
  // Bumped when the alert alone carries the errors: focus moves to it.
  const [alertFocus, setAlertFocus] = useState(0);
  const clearNotice = useClearNotice();

  useEffect(() => {
    if (alertFocus > 0) alertRef.current?.focus();
  }, [alertFocus]);

  /*
   * The payload the action gets. No `status`: the server ignores it on save,
   * so only the Publish / Move to draft buttons change it.
   */
  const payload = (values: ProductEditValues) =>
    toProductInput(values, magnetic);

  const submitValid = (values: ProductEditValues) => {
    if (inFlight.current) return;
    setFormErrors([]);
    setInfo("");
    const input = payload(values);
    const now = productInputSchema.safeParse(input);
    const before = productInputSchema.safeParse(payload(initial));
    if (
      now.success &&
      before.success &&
      sameParsedInput(now.data, before.data)
    ) {
      // Only trimmed spaces differ: nothing to send.
      form.reset(initial);
      clearNotice();
      setInfo("No changes to save.");
      return;
    }
    inFlight.current = true;
    startTransition(async () => {
      /*
       * Cleared in `finally`: on success the action redirects to this same
       * page with a new ?notice=, which callAction rethrows, and the form
       * stays mounted. Clearing only after the await would leave the guard
       * set, so every later save would silently do nothing. A save is
       * idempotent, so the button stays after any failure too.
       */
      try {
        const result = await callAction(() =>
          updateProductAction(product.id, input, product.updatedAt),
        );
        if (!result || result.ok) return;
        setSaved(result.saved);
        const { formMessages, focusedField } = applyServerErrors(
          form,
          result.errors,
          rendered,
        );
        setFormErrors(formMessages);
        if (!focusedField && formMessages.length > 0) {
          setAlertFocus((count) => count + 1);
        }
      } finally {
        inFlight.current = false;
      }
    });
  };

  /* Client-side errors on fields with no input yet go to the alert. */
  const submitInvalid = (errors: FieldErrors<ProductEditValues>) => {
    setInfo("");
    setSaved(false);
    const { fields, form: messages } = splitMessages(
      flattenFormErrors(errors),
      rendered,
    );
    setFormErrors(messages);
    if (fields.length === 0 && messages.length > 0) {
      setAlertFocus((count) => count + 1);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid, submitInvalid)(event);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <StatusPanel
        productId={product.id}
        version={product.updatedAt}
        status={product.status}
        problems={publishProblems}
        dirty={form.formState.isDirty}
      />

      <FormProvider {...form}>
        <form
          onSubmit={onSubmit}
          noValidate
          aria-busy={pending}
          aria-label="Product details"
          className="flex flex-col gap-6"
        >
          {formErrors.length > 0 ? (
            <Alert
              ref={alertRef}
              tabIndex={-1}
              variant="destructive"
              role="alert"
            >
              <CircleAlert aria-hidden="true" />
              <AlertTitle>
                {saved === true
                  ? "Saved, with a problem"
                  : saved === "unknown"
                    ? "The change could not be confirmed"
                    : "The product was not saved"}
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

          <BasicsSection status={product.status} />
          <CategoriesSection
            categories={categories}
            areas={areas}
            showTrackSize={showTrackSize}
          />
          <FiltersSection />
          <VariantsSummary />

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
            <Button asChild variant="outline">
              <Link href={PRODUCTS_PATH}>Back to products</Link>
            </Button>
            <p role="status" className="text-sm text-muted-foreground">
              {/* Stale once the admin edits again. */}
              {form.formState.isDirty ? "" : info}
            </p>
          </div>
        </form>
      </FormProvider>

      <DeleteProduct productId={product.id} name={product.values.name} />
    </div>
  );
}
