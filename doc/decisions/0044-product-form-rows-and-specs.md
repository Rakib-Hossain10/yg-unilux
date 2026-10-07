# 0044 — Product form section (b): specs as lines, one row-list editor, no input names
- Status: Accepted
- Date: 2026-10-06

## Context
T10b completes `/admin/products/[id]` with:
- product specs (28 keys);
- variants with their own spec differences;
- extra specs;
- public file links.

The form must handle up to 200 variants, keep focus right while rows are added, removed and moved, and put every error on the right row.

## Decision
1. **Specs are held as one text per key, one option per line** (LF or CRLF). Lines, not commas, separate options, because real values contain commas and slashes ("100-240V, 50/60Hz").
2. **Spec groups are named in the UI** (`product-form/spec-groups.ts`), because `SPEC_COLUMNS` has no group field. There are six groups in sheet order, and a test checks they cover all 28 keys exactly once.
3. **Default-restricted columns show a plain badge.** They are Batch No., Chip Type, Holder, Chip Efficiency and Driver. Column visibility stays a settings task. Once it exists, the edit page passes the effective restricted keys.
4. **Variant specs hold only the keys the admin added.** Each key is chosen from a native `<select>`. `toProductInput` copies row fields one by one and drops empty keys, so field-array ids never reach the strict schema and "No changes to save" still compares equal.
5. **One generic row-list editor** (`row-list-section.tsx`) runs variants, extra specs and public files with `useFieldArray`:
   - Add, remove and up/down `move()`; edge buttons are `aria-disabled`.
   - A polite live region announces each change.
   - Removing a variant asks for confirmation; extra spec and file rows are removed at once.
   - Focus after add goes to the new row's first input. After remove it goes to the next row, else the one above, else the Add button. After a move it returns to the pressed button.
6. **Error placement.**
   - List-level errors go to `<list>.root`, so they never overwrite row errors.
   - Server errors are placed on rows only if the rows are unchanged since the save was sent. Otherwise they go to the labelled alert.
7. **Performance.** `reValidateMode` stays `onChange`. Rows are memoised, receive only primitives and stable callbacks, and each row watches only its own specs. Measured with 200 variants after a failed submit:
   - 20 keystrokes take about 0.5 s;
   - one move takes about 0.35 s.

   An e2e test holds loose budgets.
8. **Text inputs carry no `name` attribute.** A Save clicked before hydration submits the form natively as a GET. With named inputs, every value, restricted spec text included, would land in the URL.

## Consequences
- No `src/lib` change.
- Backend follow-ups:
  - `invalidInput` should key nested issues by the full dotted path (today a crafted request's row error lands on the list message).
  - Add a `group` field to `SPEC_COLUMNS`.
- The other admin forms (areas, categories) still spread `{...field}`, which includes `name`. The values there aren't restricted, so this is low risk; QA gate B checks it.
- Focus after a move is verified only in Chromium.
