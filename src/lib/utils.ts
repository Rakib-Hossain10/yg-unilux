// Class-name helper used by every shadcn component in src/components/ui:
// clsx joins conditional classes, tailwind-merge drops conflicting Tailwind
// utilities so the last one wins (e.g. a caller's `px-2` beats `px-4`).

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
