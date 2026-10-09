"use client";

// True once React runs in the browser (false in the server HTML and during
// hydration), without a setState in an effect. Used to hide the no-JS
// fallbacks (Apply / Sort buttons) once JavaScript applies forms itself.

import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
