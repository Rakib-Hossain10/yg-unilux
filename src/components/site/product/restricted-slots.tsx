// Reserved places for the dynamic restricted block (task P7, ADR 0062): the
// datasheet button in the panel and the restricted spec rows under the table.
// They hold only the visitor fallback and never a restricted value.

/*
 * P7 mounts its client block inside these wrappers (stable data-slot hooks)
 * and keeps the same minimum height, so the swap causes no layout shift.
 * Sign-in is a plain <a>: /login must be a full page load (ADR 0027 note).
 */

const signInLink =
  "inline-flex min-h-11 items-center underline underline-offset-4 decoration-grey-400 transition-colors duration-(--duration-quick) hover:decoration-ink";

export function DatasheetSlot({ hasDatasheet }: { hasDatasheet: boolean }) {
  return (
    <div
      data-slot="datasheet"
      className="flex min-h-24 flex-col justify-center gap-1 border border-grey-300 px-5 py-4"
    >
      <p className="text-sm font-medium">Datasheet</p>
      {hasDatasheet ? (
        <p className="text-sm text-grey-600">
          Available to approved customers.{" "}
          <a href="/login" className={`${signInLink} text-ink`}>
            Sign in to download
          </a>
        </p>
      ) : (
        <p className="text-sm text-grey-600">Datasheet coming soon</p>
      )}
    </div>
  );
}

export function RestrictedSpecsSlot() {
  return (
    <div
      data-slot="restricted-specs"
      className="flex min-h-24 flex-col justify-center border-t border-grey-200 py-6 text-sm text-grey-600"
    >
      <p>
        Some specifications are shared with approved customers only.{" "}
        <a href="/login" className={`${signInLink} text-ink`}>
          Sign in to see them
        </a>
      </p>
    </div>
  );
}
