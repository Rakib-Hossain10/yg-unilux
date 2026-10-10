// Runs one customer-page action at a time: the errors and "saved" state of
// the last failure, and a status line for the last success. `inFlight` is set
// synchronously, because `pending` only turns true on a later render, so two
// fast clicks can't send two writes.

import { useRef, useState, useTransition } from "react";

import {
  allMessages,
  callAction,
  type ActionData,
  type ActionResult,
} from "../action-result";

export interface CustomerAction {
  pending: boolean;
  errors: string[];
  saved: boolean | "unknown";
  status: string;
  /**
   * Runs `action` unless one is running. On success `done` (a message, or a
   * function of the result) is announced; field errors are handed to
   * `onFieldErrors` when given, else shown with the rest.
   */
  run: <R extends ActionResult | ActionData<unknown>>(
    action: () => Promise<R>,
    done: string | ((result: R & { ok: true }) => string),
    onFieldErrors?: (fieldErrors: Record<string, string[]>) => boolean,
  ) => void;
  /** Clears the messages (e.g. when a dialog opens again). */
  clear: () => void;
}

export function useCustomerAction(): CustomerAction {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<boolean | "unknown">(false);
  const [status, setStatus] = useState("");
  const inFlight = useRef(false);

  const clear = () => {
    setErrors([]);
    setSaved(false);
    setStatus("");
  };

  const run: CustomerAction["run"] = (action, done, onFieldErrors) => {
    if (inFlight.current) return;
    inFlight.current = true;
    clear();
    startTransition(async () => {
      try {
        const result = await callAction(action);
        if (!result) return;
        if (result.ok) {
          setStatus(
            typeof done === "string"
              ? done
              : done(result as Parameters<typeof done>[0]),
          );
          return;
        }
        setSaved(result.saved);
        const handled = onFieldErrors?.(result.errors.fieldErrors) ?? false;
        setErrors(
          handled ? result.errors.formErrors : allMessages(result.errors),
        );
      } finally {
        inFlight.current = false;
      }
    });
  };

  return { pending, errors, saved, status, run, clear };
}
