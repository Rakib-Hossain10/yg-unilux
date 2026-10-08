// Keeps the last value for a short exit animation (P8 lightbox close): when
// `value` turns null, the previous value is returned for `ms` more, so the
// closing dialog fades out with its picture instead of an empty sheet.

import { useEffect, useState } from "react";

import { prefersReducedMotion } from "./reduced-motion";

/*
 * Pure state, derived during render (no effect sets state on the change
 * itself); one timer clears the held value. Under reduced motion nothing is
 * held, so the closed view is empty at once, exactly as without this hook.
 */
export function useExitHold<T>(value: T | null, ms: number): T | null {
  const [previous, setPrevious] = useState(value);
  const [held, setHeld] = useState<{ value: T } | null>(null);

  if (value !== previous) {
    setPrevious(value);
    setHeld(
      value === null && previous !== null && !prefersReducedMotion()
        ? { value: previous }
        : null,
    );
  }

  useEffect(() => {
    if (!held) return;
    const timer = window.setTimeout(() => setHeld(null), ms);
    return () => window.clearTimeout(timer);
  }, [held, ms]);

  return value ?? held?.value ?? null;
}
