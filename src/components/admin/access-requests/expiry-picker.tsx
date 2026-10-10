"use client";

// The access expiry picker (plan Q5): 3 / 6 / 12 months, a custom day or no
// expiry, with a preview of the end date the server will store (end of the
// UTC day). Months count from the later of today and the current end, so an
// extension never shortens access. Shared with the customer page (P8).

import { useId, useState } from "react";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  ACCESS_MONTH_CHOICES,
  computeAccessExpiry,
  MAX_ACCESS_DATE,
  MIN_ACCESS_DATE,
  parseAccessDay,
  type AccessChoice,
} from "@/lib/access-expiry";

import { formatAccessEnd } from "./format";

type Option = `${(typeof ACCESS_MONTH_CHOICES)[number]}` | "date" | "none";

function optionOf(choice: AccessChoice): Option {
  if (choice.kind === "months") return `${choice.months}`;
  return choice.kind;
}

/** The end date a choice gives, or undefined when the day is not valid. */
export function previewAccessEnd(
  choice: AccessChoice,
  now: Date,
  current: Date | null,
): Date | null | undefined {
  if (choice.kind === "date" && parseAccessDay(choice.date.trim()) === null) {
    return undefined;
  }
  return computeAccessExpiry(
    choice.kind === "date" ? { ...choice, date: choice.date.trim() } : choice,
    { now, current },
  );
}

export function ExpiryPicker({
  value,
  onChange,
  current,
  error,
  legend = "Access to datasheets",
}: {
  value: AccessChoice;
  onChange: (choice: AccessChoice) => void;
  /** The customer's current end (ISO), for extensions; null = none/new. */
  current: string | null;
  /** The message for an invalid custom day. */
  error?: string;
  legend?: string;
}) {
  const id = useId();
  // Kept while another option is picked, so switching back restores it.
  const [day, setDay] = useState(value.kind === "date" ? value.date : "");
  // Read once per render; the preview is a guide, the server decides.
  const [now] = useState(() => new Date());
  const currentEnd = current === null ? null : new Date(current);
  const preview = previewAccessEnd(value, now, currentEnd);

  const pick = (option: string) => {
    if (option === "date") onChange({ kind: "date", date: day });
    else if (option === "none") onChange({ kind: "none" });
    else {
      const months = ACCESS_MONTH_CHOICES.find((m) => `${m}` === option);
      if (months !== undefined) onChange({ kind: "months", months });
    }
  };

  const dayId = `${id}-day`;
  return (
    <FieldSet>
      <FieldLegend variant="label">{legend}</FieldLegend>
      <RadioGroup
        value={optionOf(value)}
        onValueChange={pick}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
      >
        {ACCESS_MONTH_CHOICES.map((months) => (
          <Field key={months} orientation="horizontal">
            <RadioGroupItem value={`${months}`} id={`${id}-${months}`} />
            <FieldLabel htmlFor={`${id}-${months}`} className="font-normal">
              {months} months
            </FieldLabel>
          </Field>
        ))}
        <Field orientation="horizontal">
          <RadioGroupItem value="date" id={`${id}-date`} />
          <FieldLabel htmlFor={`${id}-date`} className="font-normal">
            Choose a date
          </FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <RadioGroupItem value="none" id={`${id}-none`} />
          <FieldLabel htmlFor={`${id}-none`} className="font-normal">
            No expiry
          </FieldLabel>
        </Field>
      </RadioGroup>

      {value.kind === "date" ? (
        <Field data-invalid={error !== undefined}>
          <FieldLabel htmlFor={dayId}>Last day of access</FieldLabel>
          <Input
            id={dayId}
            type="date"
            min={MIN_ACCESS_DATE}
            max={MAX_ACCESS_DATE}
            value={day}
            onChange={(event) => {
              setDay(event.target.value);
              onChange({ kind: "date", date: event.target.value });
            }}
            aria-invalid={error !== undefined}
            aria-describedby={
              error !== undefined ? `${dayId}-error` : undefined
            }
            className="w-fit"
          />
          <FieldError
            id={`${dayId}-error`}
            errors={error !== undefined ? [{ message: error }] : []}
          />
        </Field>
      ) : null}

      <FieldDescription aria-live="polite">
        {preview === undefined
          ? "Pick a day to see when access ends."
          : `Access ${formatAccessEnd(preview)}.`}
      </FieldDescription>
    </FieldSet>
  );
}
