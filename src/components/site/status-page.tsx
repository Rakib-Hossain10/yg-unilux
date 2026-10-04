// Shared body for the 404, 403 and error pages: a status label, a heading in
// the display face, one sentence and the ways onward. Keeps the three pages
// visually identical and their copy in one shape.

import type { ReactNode } from "react";

export function StatusPage({
  code,
  title,
  message,
  children,
}: {
  /** Shown small above the heading, e.g. "404". */
  code: string;
  title: string;
  message: string;
  /** Links or buttons leading on. */
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center">
      <p className="text-xs tracking-[0.2em] text-grey-500 uppercase">{code}</p>
      <h1 className="mt-4 font-display text-4xl font-light md:text-5xl">
        {title}
      </h1>
      <p className="mt-4 max-w-md text-grey-600">{message}</p>
      {children ? (
        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** The one button/link style used on status pages. */
export const statusAction =
  "inline-flex h-11 items-center border border-ink px-6 text-xs tracking-[0.16em] uppercase transition-colors duration-(--duration-quick) hover:bg-ink hover:text-paper";
