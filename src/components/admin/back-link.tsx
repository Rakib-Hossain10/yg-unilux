// "← Categories" style link at the top of an admin form page, back to the
// module's list. A plain link (no client code), so server pages can use it.

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

export function BackLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Button asChild variant="link" className="w-fit px-0">
      <Link href={href}>
        <ArrowLeft data-icon="inline-start" aria-hidden="true" />
        {children}
      </Link>
    </Button>
  );
}
