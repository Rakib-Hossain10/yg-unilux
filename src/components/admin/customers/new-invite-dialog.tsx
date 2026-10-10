"use client";

// "New invite link…" on a customers list row: a dialog around the shared
// NewInviteLink panel (email it, or show once to copy). The copy-once link
// lives only in this dialog's state and is dropped when it closes; the list
// refreshes only then, so a filtered row can't vanish with the link on it.

import { Link2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { newCustomerInviteAction } from "@/app/admin/customers/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import {
  CopyLinkWarning,
  NewInviteLink,
} from "../access-requests/invite-result";

export function NewInviteDialog({
  userId,
  name,
  email,
}: {
  userId: string;
  name: string;
  email: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // A new panel (no old outcome or link) each time the dialog opens.
  const [round, setRound] = useState(0);
  const made = useRef(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setRound((value) => value + 1);
          made.current = false;
        } else if (made.current) {
          // The status column changes; the link is gone with the dialog.
          router.refresh();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Link2 data-icon="inline-start" aria-hidden="true" />
          New link…
          <span className="sr-only"> for {name}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New invite link</DialogTitle>
          <DialogDescription>
            For {name} ({email}). Each link works for 72 hours.
          </DialogDescription>
        </DialogHeader>
        <NewInviteLink
          key={round}
          userId={userId}
          unverified
          warning={<CopyLinkWarning />}
          action={newCustomerInviteAction}
          onMade={() => {
            made.current = true;
          }}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setOpen(false);
              if (made.current) router.refresh();
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
