"use client";

// A paragraph clamped to three lines with a "Read more" toggle (gate C, M-1:
// keeps the quick-spec panel's specs, switcher and datasheet in the first
// screen). The full text is always in the DOM; only its visible height
// changes. The server decides whether the text is long enough to clamp, so
// nothing is measured and nothing shifts on hydration.

import { useId, useState } from "react";

export function ExpandableText({
  text,
  clamp,
  className = "",
}: {
  text: string;
  /** Long enough to clamp (decided on the server). */
  clamp: boolean;
  className?: string;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  if (!clamp) return <p className={className}>{text}</p>;
  return (
    <div>
      <p
        id={id}
        data-expanded={expanded ? "" : undefined}
        className={`${className} ${expanded ? "" : "line-clamp-3"}`}
      >
        {text}
      </p>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((open) => !open)}
        className="-my-2 inline-flex min-h-11 items-center text-sm text-ink underline decoration-grey-400 underline-offset-4 hover:decoration-ink"
      >
        {expanded ? "Show less" : "Read more"}
      </button>
    </div>
  );
}
