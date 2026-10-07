"use client";

// The column visibility form: one switch per spec column (28), grouped like
// the product editor. On = restricted (only approved customers see the value).
// Same Zod schema as the server, which re-validates (ADR 0049, 0050).

import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { saveColumnVisibilityAction } from "@/app/admin/settings/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  columnVisibilitySchema,
  type ColumnVisibility,
} from "@/lib/schemas/settings";

import { allMessages, callAction } from "../action-result";
import { SPEC_GROUPS } from "../product-form/spec-groups";
import {
  canSave,
  countRestricted,
  newlyRestrictedFilterHeaders,
  visibilityChanged,
} from "./settings-ui";

type Outcome =
  | { kind: "none" }
  | { kind: "saved" }
  | { kind: "error"; saved: boolean | "unknown"; messages: string[] };

export function ColumnVisibilityForm({
  initial,
}: {
  initial: ColumnVisibility;
}) {
  const form = useForm<ColumnVisibility>({
    resolver: zodResolver(columnVisibilitySchema),
    defaultValues: initial,
  });
  // The values as last saved: the page refreshes after a save, but the warning
  // must compare against what is stored right now.
  const [baseline, setBaseline] = useState(initial);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });
  const [pending, startTransition] = useTransition();
  // Set synchronously: `pending` turns true on a later render.
  const inFlight = useRef(false);

  const current = useWatch({ control: form.control }) as ColumnVisibility;
  const changed = visibilityChanged(baseline, current);
  const needsRetry = outcome.kind === "error" && outcome.saved === true;
  const warnFor = newlyRestrictedFilterHeaders(baseline, current);

  const submitValid = (values: ColumnVisibility) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOutcome({ kind: "none" });
    startTransition(async () => {
      const result = await callAction(() => saveColumnVisibilityAction(values));
      inFlight.current = false;
      if (!result) return;
      if (result.ok) {
        setBaseline(values);
        setOutcome({ kind: "saved" });
        return;
      }
      // A cleanup failure means the setting itself is saved.
      if (result.saved === true) setBaseline(values);
      setOutcome({
        kind: "error",
        saved: result.saved,
        messages: allMessages(result.errors),
      });
    });
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid)(event);

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Restricted product details</CardTitle>
        <CardDescription>
          Switch on a detail to show its value only to approved customers
          (signed in, access not expired) and to you. Everyone else does not
          receive it at all. {countRestricted(current)} of{" "}
          {SPEC_GROUPS.reduce((n, g) => n + g.columns.length, 0)} are
          restricted.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={onSubmit}
          noValidate
          aria-busy={pending}
          className="flex flex-col gap-6"
        >
          <Alert>
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Restricting a detail clears its filters</AlertTitle>
            <AlertDescription>
              Making CCT, CRI, Beam Angle, UGR, Wattage or IP Rating restricted
              also removes that filter&apos;s numbers from all products, so the
              filters cannot be used to find the hidden values. Making the
              detail public again does not bring the filters back; they return
              the next time you import or save a product.
            </AlertDescription>
          </Alert>

          {warnFor.length > 0 ? (
            <Alert variant="destructive" role="status">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>
                Saving will clear the {warnFor.join(", ")} filter on all
                products
              </AlertTitle>
            </Alert>
          ) : null}

          {outcome.kind === "error" ? (
            <Alert variant="destructive" role="alert">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>
                {outcome.saved === true
                  ? "Saved, with a problem"
                  : outcome.saved === "unknown"
                    ? "The change could not be confirmed"
                    : "The settings were not saved"}
              </AlertTitle>
              <AlertDescription>
                <ul className="flex list-disc flex-col gap-1 pl-4">
                  {outcome.messages.map((message, index) => (
                    <li key={`${index}-${message}`}>{message}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {outcome.kind === "saved" ? (
            <Alert role="status">
              <CircleCheck aria-hidden="true" />
              <AlertTitle>Settings saved.</AlertTitle>
            </Alert>
          ) : null}

          <FieldGroup>
            {SPEC_GROUPS.map((group) => (
              <FieldSet key={group.title}>
                <FieldLegend variant="label">{group.title}</FieldLegend>
                <FieldGroup className="gap-3">
                  {group.columns.map((column) => {
                    const id = `column-${column.key}`;
                    return (
                      <Controller
                        key={column.key}
                        name={column.key}
                        control={form.control}
                        render={({ field }) => (
                          <Field orientation="horizontal">
                            <FieldContent>
                              <FieldLabel htmlFor={id}>
                                {column.header}
                                {column.restrictedByDefault ? (
                                  <Badge variant="secondary">
                                    restricted by default
                                  </Badge>
                                ) : null}
                              </FieldLabel>
                              <FieldDescription>
                                {field.value === "restricted"
                                  ? "Restricted: approved customers only"
                                  : "Public: everyone sees it"}
                              </FieldDescription>
                            </FieldContent>
                            <Switch
                              id={id}
                              checked={field.value === "restricted"}
                              onCheckedChange={(on) =>
                                field.onChange(on ? "restricted" : "public")
                              }
                              onBlur={field.onBlur}
                              aria-label={`Restrict ${column.header}`}
                            />
                          </Field>
                        )}
                      />
                    );
                  })}
                </FieldGroup>
              </FieldSet>
            ))}
          </FieldGroup>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              disabled={!canSave({ pending, changed, needsRetry })}
            >
              {pending ? "Saving…" : "Save column settings"}
            </Button>
            {changed && !pending ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  form.reset(baseline);
                  setOutcome({ kind: "none" });
                }}
              >
                Discard changes
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
