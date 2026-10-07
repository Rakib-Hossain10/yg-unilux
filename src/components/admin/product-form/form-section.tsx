// A titled card for one part of the product edit form (Basics, Categories and
// areas, Filters ...). A <section> labelled by its heading, so screen-reader
// users can jump between the parts of a long form.

import { useId, type ReactNode } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function FormSection({
  id,
  title,
  description,
  children,
}: {
  /** Anchor for in-page links (tabIndex -1 so a jump moves focus here). */
  id?: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      tabIndex={id === undefined ? undefined : -1}
      aria-labelledby={headingId}
      className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id={headingId} className="text-lg font-semibold">
              {title}
            </h2>
          </CardTitle>
          {description !== undefined ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </section>
  );
}
