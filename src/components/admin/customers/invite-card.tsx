"use client";

// Invite card on the customer page (plan Q1 addition): the invite status
// (pending until …, expired, accepted) and "New invite link" (email it, or
// show once to copy) whenever the invite is not settled. Earlier links die;
// the access end date never changes. A copy-once link lives only in the
// panel's state: the page refreshes underneath (the status line updates)
// while the panel stays mounted, and "Make another link" drops it.

import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { newCustomerInviteAction } from "@/app/admin/customers/actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import {
  CopyLinkWarning,
  NewInviteLink,
} from "../access-requests/invite-result";
import { inviteOpen, inviteSentence, type InviteStatusView } from "./labels";

export function InviteCard({
  userId,
  invite,
  mustChangePassword,
  blocked,
}: {
  userId: string;
  invite: InviteStatusView;
  mustChangePassword: boolean;
  blocked: boolean;
}) {
  const router = useRouter();
  const [round, setRound] = useState(0);
  const [made, setMade] = useState(false);
  // Kept open after a link was made, even though the status is now pending.
  const offer = made || inviteOpen(invite, mustChangePassword);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Invite</h2>
        </CardTitle>
        <CardDescription>{inviteSentence(invite)}</CardDescription>
      </CardHeader>
      {offer ? (
        <CardContent className="flex flex-col gap-3">
          {blocked ? (
            <p className="text-sm text-muted-foreground">
              Unblock this customer before sending a new link.
            </p>
          ) : (
            <>
              <NewInviteLink
                key={round}
                userId={userId}
                unverified
                warning={<CopyLinkWarning />}
                action={newCustomerInviteAction}
                onMade={() => {
                  setMade(true);
                  router.refresh();
                }}
              />
              {made ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-fit"
                  onClick={() => {
                    // Drops the shown link; the panel starts fresh.
                    setMade(false);
                    setRound((value) => value + 1);
                  }}
                >
                  <RotateCw data-icon="inline-start" aria-hidden="true" />
                  Make another link
                </Button>
              ) : null}
            </>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}
