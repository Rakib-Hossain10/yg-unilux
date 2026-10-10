"use client";

// What happened to an invite link, as the admin sees it after an approval
// or a "New invite link": emailed, shown once to copy, or not delivered
// (then a new link can be made). The copy-once link lives only in this
// component's props, which come from the dialog's memory: it is never put in
// a URL, logged or stored, and it is gone once the dialog closes.

import { Check, CircleAlert, Copy, Mail, TriangleAlert } from "lucide-react";
import { useRef, useState, useTransition, type ReactNode } from "react";

import { newInviteLinkAction } from "@/app/admin/access-requests/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/time-zone";

import { allMessages, callAction, type ActionData } from "../action-result";
import { formatWait } from "./format";
import {
  inviteNeedsRetry,
  type InviteDeliveryChoice,
  type InviteView,
  type NewInviteOutcome,
} from "./types";

/**
 * The warning shown before "Show once to copy" on a request from the public
 * form (gate A L-3): its name and email were typed by anyone and are not
 * verified, and a later request from the same email overwrites them.
 */
export function UnverifiedContactWarning() {
  return (
    <Alert role="note">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Check who you send this link to</AlertTitle>
      <AlertDescription>
        This request came from the website form, so its name and email are not
        verified. Whoever holds the link can set the password for this account.
        Copy it only to someone you know is the owner of this email address, for
        example a contact you already talk to on WhatsApp. Otherwise choose
        &quot;Email it&quot;.
      </AlertDescription>
    </Alert>
  );
}

/**
 * The same check on the customers module, where the email's origin is not
 * known: copying hands a password-setting link to whoever receives it.
 */
export function CopyLinkWarning() {
  return (
    <Alert role="note">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Check who you send this link to</AlertTitle>
      <AlertDescription>
        Whoever holds the link can set the password for this account. Copy it
        only to someone you know is the owner of this email address, for example
        a contact you already talk to on WhatsApp. Otherwise choose &quot;Email
        it&quot;.
      </AlertDescription>
    </Alert>
  );
}

/* The link in a read-only field with a Copy button. */
function CopyOnceLink({ url, expiresAt }: { url: string; expiresAt: string }) {
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const inputRef = useRef<HTMLInputElement>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("yes");
    } catch {
      // No clipboard permission: select the text so Ctrl+C works.
      inputRef.current?.select();
      setCopied("failed");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Alert role="note">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Copy the link now: it is shown only once</AlertTitle>
        <AlertDescription>
          The link is not stored anywhere readable and can&apos;t be shown
          again. If you lose it, make a new one. It works until{" "}
          {formatDateTime(expiresAt)}.
        </AlertDescription>
      </Alert>
      <Field>
        <FieldLabel htmlFor="invite-link-once">Invite link</FieldLabel>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            ref={inputRef}
            id="invite-link-once"
            readOnly
            value={url}
            spellCheck={false}
            autoComplete="off"
            onFocus={(event) => event.currentTarget.select()}
            aria-describedby="invite-link-once-help"
          />
          <Button type="button" variant="outline" onClick={copy}>
            {copied === "yes" ? (
              <Check data-icon="inline-start" aria-hidden="true" />
            ) : (
              <Copy data-icon="inline-start" aria-hidden="true" />
            )}
            {copied === "yes" ? "Copied" : "Copy link"}
          </Button>
        </div>
        <FieldDescription id="invite-link-once-help">
          Paste it into your WhatsApp chat with the customer.
        </FieldDescription>
        <p role="status" aria-live="polite" className="text-sm">
          {copied === "yes"
            ? "Link copied."
            : copied === "failed"
              ? "Copying is blocked by the browser. The link is selected: press Ctrl+C (or Cmd+C)."
              : ""}
        </p>
      </Field>
    </div>
  );
}

/** The invite part of a result. */
export function InviteOutcomeView({ invite }: { invite: InviteView }) {
  switch (invite.state) {
    case "sent":
      return (
        <Alert role="status">
          <Mail aria-hidden="true" />
          <AlertTitle>Invite emailed</AlertTitle>
          <AlertDescription>
            The customer sets a password from the link in the email. It works
            until {formatDateTime(invite.expiresAt)}.
          </AlertDescription>
        </Alert>
      );
    case "copy":
      return <CopyOnceLink url={invite.url} expiresAt={invite.expiresAt} />;
    case "send_failed":
      return (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>The invite email could not be sent</AlertTitle>
          <AlertDescription>
            A link was made but did not reach the customer. Make a new link
            below.
          </AlertDescription>
        </Alert>
      );
    case "limited":
      return (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>No invite link was made</AlertTitle>
          <AlertDescription>
            Too many links were made for this customer in the last hour. Try
            again in {formatWait(invite.retryAfterSeconds)}.
          </AlertDescription>
        </Alert>
      );
    case "busy":
    case "failed":
      return (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>No invite link was made</AlertTitle>
          <AlertDescription>
            Something went wrong while making the link. Make a new link below.
          </AlertDescription>
        </Alert>
      );
  }
}

/** A Server Action that makes a new invite link for `{ userId, delivery }`. */
export type NewInviteAction = (input: {
  userId: string;
  delivery: InviteDeliveryChoice;
}) => Promise<ActionData<NewInviteOutcome>>;

/**
 * "New invite link": emailed, or shown once to copy. Shown after an invite
 * that did not go out, and on the customer page's invite card (which passes
 * its own action and is told when a link was made).
 */
export function NewInviteLink({
  userId,
  unverified,
  action = newInviteLinkAction,
  onMade,
  warning = <UnverifiedContactWarning />,
}: {
  userId: string;
  /** Ask before "Show once to copy" (gate A L-3 warning). */
  unverified: boolean;
  /** The warning shown before copying; the request wording by default. */
  warning?: ReactNode;
  action?: NewInviteAction;
  /** Told once a link was made (emailed or shown), e.g. to refresh. */
  onMade?: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<InviteView | null>(null);
  const [auditMessage, setAuditMessage] = useState<string | null>(null);
  const [confirmCopy, setConfirmCopy] = useState(false);
  const inFlight = useRef(false);

  const make = (delivery: InviteDeliveryChoice) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setErrors([]);
    setOutcome(null);
    setAuditMessage(null);
    startTransition(async () => {
      try {
        const result = await callAction(() => action({ userId, delivery }));
        if (!result) return;
        if (!result.ok) {
          setErrors(allMessages(result.errors));
          return;
        }
        setConfirmCopy(false);
        setOutcome(result.data.invite);
        setAuditMessage(result.data.auditMessage);
        // A link exists now (earlier ones are dead), even if its email failed.
        if ("expiresAt" in result.data.invite) onMade?.();
      } finally {
        inFlight.current = false;
      }
    });
  };

  if (outcome !== null && !inviteNeedsRetry(outcome)) {
    return (
      <div className="flex flex-col gap-3">
        <InviteOutcomeView invite={outcome} />
        {auditMessage ? <AuditFailedAlert message={auditMessage} /> : null}
      </div>
    );
  }

  return (
    <section
      aria-labelledby="new-invite-heading"
      aria-busy={pending}
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <h3 id="new-invite-heading" className="text-sm font-medium">
        New invite link
      </h3>
      <p className="text-sm text-muted-foreground">
        Earlier links stop working. The access end date does not change.
      </p>
      {outcome !== null ? <InviteOutcomeView invite={outcome} /> : null}
      {errors.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>No new link was made</AlertTitle>
          <AlertDescription>{errors.join(" ")}</AlertDescription>
        </Alert>
      ) : null}
      {confirmCopy && unverified ? warning : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={pending} onClick={() => make("email")}>
          <Mail data-icon="inline-start" aria-hidden="true" />
          Email it
        </Button>
        {unverified && !confirmCopy ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => setConfirmCopy(true)}
          >
            Show once to copy…
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => make("copy")}
          >
            <Copy data-icon="inline-start" aria-hidden="true" />
            {unverified ? "I understand, show the link" : "Show once to copy"}
          </Button>
        )}
      </div>
    </section>
  );
}

/** The change is saved but its audit entry is not (ADR 0070). */
export function AuditFailedAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive" role="alert">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>Saved, with a problem</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
