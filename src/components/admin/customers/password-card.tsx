"use client";

// Password card on the customer page (plan Q1):
// - "Send reset link": the normal 1-hour link by email;
// - "Set temporary password": the WhatsApp fallback. A generated password is
//   shown ONCE in this card's state (never a URL, log or storage); the
//   customer must change it at the next sign-in. Earlier invite and reset
//   links stop working and their sessions end. The card stays mounted when
//   the page refreshes, so the password stays on screen until the admin hides
//   it or leaves the page.

import { Check, Copy, KeyRound, Mail, TriangleAlert } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import {
  sendCustomerResetLinkAction,
  setTemporaryPasswordAction,
} from "@/app/admin/customers/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

import { AuditFailedAlert } from "../access-requests/invite-result";
import { ActionFeedback } from "./action-feedback";
import type { TemporaryPasswordOutcome } from "./types";
import { useCustomerAction } from "./use-customer-action";

export function PasswordCard({
  userId,
  email,
  blocked,
}: {
  userId: string;
  email: string;
  blocked: boolean;
}) {
  const reset = useCustomerAction();
  const temp = useCustomerAction();
  const [shown, setShown] = useState<TemporaryPasswordOutcome | null>(null);

  const sendLink = () =>
    reset.run(
      () => sendCustomerResetLinkAction({ userId }),
      `A reset link was emailed to ${email}. It works for 1 hour.`,
    );

  const makeTemporary = () => {
    setShown(null);
    temp.run(
      () => setTemporaryPasswordAction({ userId }),
      (result) => {
        setShown(result.data);
        return "Temporary password set. Copy it below.";
      },
    );
  };

  const busy = reset.pending || temp.pending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Password</h2>
        </CardTitle>
        <CardDescription>
          The customer chooses their own password. Send a reset link, or set a
          temporary password to pass on yourself (for example on WhatsApp).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {blocked ? (
          <p className="text-sm text-muted-foreground">
            This customer is blocked: they can&apos;t sign in until you unblock
            them, whatever the password.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <ConfirmButton
            label="Send reset link…"
            icon={<Mail data-icon="inline-start" aria-hidden="true" />}
            title="Email a reset link?"
            description={`${email} gets a link to choose a new password. It works for 1 hour. Their current password keeps working until they use it.`}
            confirm="Send link"
            disabled={busy}
            onConfirm={sendLink}
          />
          <ConfirmButton
            label="Set temporary password…"
            icon={<KeyRound data-icon="inline-start" aria-hidden="true" />}
            title="Set a temporary password?"
            description="A new password is generated and shown to you once. The customer is signed out everywhere, any invite or reset link stops working, and they must choose their own password at the next sign-in."
            confirm="Set temporary password"
            disabled={busy}
            onConfirm={makeTemporary}
          />
        </div>
        <ActionFeedback
          status={reset.status}
          errors={reset.errors}
          saved={reset.saved}
          failedTitle="No reset link was sent"
        />
        <ActionFeedback
          status={temp.status}
          errors={temp.errors}
          saved={temp.saved}
          failedTitle="No temporary password was set"
        />
        {shown !== null ? (
          <ShownOnce outcome={shown} onHide={() => setShown(null)} />
        ) : null}
      </CardContent>
    </Card>
  );
}

/* A button that asks before running a write. */
function ConfirmButton({
  label,
  icon,
  title,
  description,
  confirm,
  disabled,
  onConfirm,
}: {
  label: string;
  icon: ReactNode;
  title: string;
  description: string;
  confirm: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled}>
          {icon}
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* The temporary password in a read-only field with a Copy button. */
function ShownOnce({
  outcome,
  onHide,
}: {
  outcome: TemporaryPasswordOutcome;
  onHide: () => void;
}) {
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const inputRef = useRef<HTMLInputElement>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(outcome.password);
      setCopied("yes");
    } catch {
      inputRef.current?.select();
      setCopied("failed");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {outcome.auditMessage ? (
        <AuditFailedAlert message={outcome.auditMessage} />
      ) : null}
      <Alert role="note">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Copy the password now: it is shown only once</AlertTitle>
        <AlertDescription>
          It is not stored anywhere readable and can&apos;t be shown again. If
          you lose it, set a new one.
        </AlertDescription>
      </Alert>
      <Field>
        <FieldLabel htmlFor="temporary-password-once">
          Temporary password
        </FieldLabel>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            ref={inputRef}
            id="temporary-password-once"
            readOnly
            value={outcome.password}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            onFocus={(event) => event.currentTarget.select()}
            aria-describedby="temporary-password-once-help"
          />
          <Button type="button" variant="outline" onClick={copy}>
            {copied === "yes" ? (
              <Check data-icon="inline-start" aria-hidden="true" />
            ) : (
              <Copy data-icon="inline-start" aria-hidden="true" />
            )}
            {copied === "yes" ? "Copied" : "Copy password"}
          </Button>
        </div>
        <FieldDescription id="temporary-password-once-help">
          The customer signs in with it and must then choose their own.
        </FieldDescription>
        <p role="status" aria-live="polite" className="text-sm">
          {copied === "yes"
            ? "Password copied."
            : copied === "failed"
              ? "Copying is blocked by the browser. The password is selected: press Ctrl+C (or Cmd+C)."
              : ""}
        </p>
      </Field>
      <Button type="button" variant="ghost" className="w-fit" onClick={onHide}>
        Hide password
      </Button>
    </div>
  );
}
