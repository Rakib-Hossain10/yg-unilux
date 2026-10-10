"use client";

// The access expiry picker (plan Q5): 3 / 6 / 12 months, a custom day or no
// expiry, with a preview of the end date the server will store. Access ends
// at the end of the chosen day in China time (src/lib/time-zone.ts). Months
// count from the later of today and the current end, so an extension never
// shortens access. Shared with the customer pages (P8).

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
  parseAccessDay,
  type AccessChoice,
} from "@/lib/access-expiry";
import { APP_TIME_ZONE_LABEL, zonedDayKey } from "@/lib/time-zone";

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
  // Read once; the preview is a guide, the server decides.
  const [now] = useState(() => new Date());
  // Kept while another option is picked, so switching back restores it.
  // Starts on the current last day while that is still ahead (saving it
  // unchanged then changes nothing); otherwise EMPTY, so no day is chosen
  // by accident (a prefilled "today" would end access tonight).
  const [day, setDay] = useState(() =>
    value.kind === "date"
      ? value.date
      : current !== null && new Date(current).getTime() > now.getTime()
        ? zonedDayKey(current)
        : "",
  );
  // The earliest day the date input offers: today in China time.
  const today = zonedDayKey(now);
  const currentEnd = current === null ? null : new Date(current);
  // An empty day gets a plain message instead of the schema's range text.
  const dayError =
    error !== undefined && value.kind === "date" && value.date.trim() === ""
      ? "Pick the last day of access."
      : error;
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
            min={today}
            max={MAX_ACCESS_DATE}
            value={day}
            onChange={(event) => {
              setDay(event.target.value);
              onChange({ kind: "date", date: event.target.value });
            }}
            aria-invalid={error !== undefined}
            aria-describedby={`${dayId}-help${error !== undefined ? ` ${dayId}-error` : ""}`}
            className="w-fit"
          />
          <FieldDescription id={`${dayId}-help`}>
            Access ends at the end of this day, {APP_TIME_ZONE_LABEL}.
          </FieldDescription>
          <FieldError
            id={`${dayId}-error`}
            errors={dayError !== undefined ? [{ message: dayError }] : []}
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
