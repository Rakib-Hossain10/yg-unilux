// The class list for a native <select> styled like the shadcn Input (border,
// focus ring, height). Used where a plain element beats the Radix Select:
// long lists of rows (variants) and the image cards.

export const NATIVE_SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm";
