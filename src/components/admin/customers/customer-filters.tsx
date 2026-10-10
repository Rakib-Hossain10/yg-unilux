// Search, status filter and sort above the customers table: a plain GET
// form, so every filtered view is a shareable URL, Back works, and no client
// state is kept. "all" means "not filtered"; the service re-checks values.

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
import {
  CUSTOMER_SORTS,
  CUSTOMER_STATUS_FILTERS,
  MAX_CUSTOMER_SEARCH_LENGTH,
  type CustomerSort,
  type CustomerStatusFilter,
} from "@/lib/schemas/customer";

import { SORT_LABELS, STATUS_FILTER_LABELS } from "./labels";
import { CUSTOMERS_PATH } from "./paths";

/* Radix Select can't use "" as an item value, so "all" stands for it. */
const ALL = "all";

export function CustomerFilters({
  q,
  status,
  sort,
  filtered,
}: {
  q: string;
  status: CustomerStatusFilter | null;
  sort: CustomerSort;
  /** True when a search or status is set, to offer "Clear". */
  filtered: boolean;
}) {
  return (
    <form
      method="get"
      action={CUSTOMERS_PATH}
      role="search"
      aria-label="Filter customers"
    >
      <FieldGroup className="gap-3 md:flex-row md:flex-wrap md:items-end">
        <Field className="md:w-auto md:min-w-64 md:flex-1">
          <FieldLabel htmlFor="customers-q">Search</FieldLabel>
          <Input
            id="customers-q"
            name="q"
            type="search"
            defaultValue={q}
            maxLength={MAX_CUSTOMER_SEARCH_LENGTH}
            placeholder="Name, email or company"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field className="md:w-52">
          <FieldLabel htmlFor="customers-status">Status</FieldLabel>
          <Select name="status" defaultValue={status ?? ALL}>
            <SelectTrigger id="customers-status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All customers</SelectItem>
                {CUSTOMER_STATUS_FILTERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {STATUS_FILTER_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field className="md:w-52">
          <FieldLabel htmlFor="customers-sort">Sort</FieldLabel>
          <Select name="sort" defaultValue={sort}>
            <SelectTrigger id="customers-sort" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {CUSTOMER_SORTS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {SORT_LABELS[value]}
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
              <Link href={CUSTOMERS_PATH}>
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
