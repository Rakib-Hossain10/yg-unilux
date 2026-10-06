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
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
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
