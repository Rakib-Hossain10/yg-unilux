// Search and filters above the products table: a plain GET form, so every
// filtered view is a shareable URL, Back works, and no client state is kept.
// "all" means "not filtered"; the list service ignores values it doesn't know.

import { Search, X } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
// Server component only (no "use client"), so the server-only service's
// constant can be read here.
import { MAX_PRODUCT_SEARCH_LENGTH } from "@/lib/admin/products";
import {
  PRODUCT_STATUSES,
  type ProductStatus,
} from "@/models/product-constants";

import type { CategoryOption } from "./product-new-form";
import { PRODUCTS_PATH } from "./product-paths";

/* Radix Select can't use "" as an item value, so "all" stands for it. */
export const ALL = "all";

/* Typed as a full record, so a new status fails tsc until it has a label. */
const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: "Draft",
  published: "Published",
};

export interface ProductFilterValues {
  q: string;
  /** A known status, or ALL. */
  status: string;
  /** An offered category id, or ALL. */
  category: string;
}

export function ProductFilters({
  values,
  categories,
  filtered,
}: {
  values: ProductFilterValues;
  categories: CategoryOption[];
  /** True when any filter is set, to offer "Clear". */
  filtered: boolean;
}) {
  return (
    <form
      method="get"
      action={PRODUCTS_PATH}
      role="search"
      aria-label="Filter products"
    >
      <FieldGroup className="gap-3 md:flex-row md:flex-wrap md:items-end">
        <Field className="md:w-auto md:min-w-64 md:flex-1">
          <FieldLabel htmlFor="products-q">Search</FieldLabel>
          <Input
            id="products-q"
            name="q"
            type="search"
            defaultValue={values.q}
            maxLength={MAX_PRODUCT_SEARCH_LENGTH}
            placeholder="Name, family or model no."
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field className="md:w-40">
          <FieldLabel htmlFor="products-status">Status</FieldLabel>
          <Select name="status" defaultValue={values.status}>
            <SelectTrigger id="products-status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {PRODUCT_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field className="md:w-64">
          <FieldLabel htmlFor="products-category">Category</FieldLabel>
          <Select name="category" defaultValue={values.category}>
            <SelectTrigger id="products-category" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All categories</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <div className="flex gap-2">
          <Button type="submit">
            <Search data-icon="inline-start" aria-hidden="true" />
            Apply
          </Button>
          {filtered ? (
            <Button asChild variant="outline">
              <Link href={PRODUCTS_PATH}>
                <X data-icon="inline-start" aria-hidden="true" />
                Clear
              </Link>
            </Button>
          ) : null}
        </div>
      </FieldGroup>
    </form>
  );
}
