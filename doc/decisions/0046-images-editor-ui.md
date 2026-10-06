# 0046 — Images editor and image uploader UI
- Status: Accepted
- Date: 2026-10-06

## Context
T11b puts the T11a upload services ([0045](0045-direct-uploads.md)) behind the admin UI: a product images editor, a variant image picker and an area black-and-white image uploader.

## Decision
1. **Separate section, own Save.** Product images are a `<section>` after the details form (before Delete), not inside any `<form>`.
   - A click before hydration does nothing, and the details form's "Save changes" stays the first Save on the page.
   - "Save images" sends the full ordered list plus `expectedUpdatedAt`.
   - The action calls `refresh()` after a write. The editor adopts the stored list during render unless it holds unsaved edits.
2. **Upload flow.** Client checks run before signing:
   - jpg, png, webp or avif, non-empty, at most `MAX_IMAGE_BYTES`;
   - slots left within `MAX_PRODUCT_IMAGES`, counting running uploads.

   Files upload one at a time:
   - Sign once, then POST every signed field plus the file with `XMLHttpRequest`, showing "Uploading N%" and a static bar.
   - An upload counts as done only when the response `public_id` equals the signed id.
   - Uploads abort on unmount, and a `beforeunload` warning covers unsaved changes.
3. **Data-returning actions.** `ActionData<T>` and `ActionFailure` sit next to `ActionResult`, and `callAction` is generic. The sign actions take the bare id; the save action takes `(input, expectedUpdatedAt)`, like `updateProductAction`.
4. **Previews.** A plain `<img>` from `res.cloudinary.com` with `c_limit,w_480,h_480,f_auto,q_auto` (fitted, never cropped).
   - The cloud name comes from the server (`adminCloudName()` or the sign result), never `NEXT_PUBLIC_`.
   - Without a cloud name, cards show "Preview unavailable".
5. **Cards.**
   - Content: 4:3 preview, order and kind badges, "Not saved yet" for ids not stored yet, required alt text with a counter, and a native kind select.
   - Controls: Move earlier/later (`aria-disabled` at the edges, focus returned after a move) and Remove.
   - Remove has no confirm: it is reversible until saved, and Discard exists.
   - The grid is one column on phones and two from `sm`.
6. **Error placement.**
   - `images.N.*` errors go on the card that was sent at position N, only if the list is unchanged since sending (ADR 0044 point 6).
   - Otherwise, and for `images`, `PRODUCT_CHANGED`, not-found and unknown keys, they go to a focused alert whose title follows `saved`.
7. **Variant image.** A native select over the product's SAVED images ("Image N: alt"), supplied through context. A value that is no longer saved stays selectable and is labelled as such, so it never changes silently.
8. **Area black-and-white image.** An uploader on the edit page only, saved at once through `setAreaImageAction`; Remove asks for confirmation. The area form has no image input and sends the stored id from its current props.
9. **Shared pieces.** `ImageDropZone` (dashed zone, one real button, drop support) and `NATIVE_SELECT_CLASS`.

## Consequences
- There is no upload e2e until the T18 storage fake. The pure logic is unit-tested, and axe covers the product edit page.
- Orphans from signed-but-unsaved uploads, removed images and replaced area images remain for the T17 report (ADR 0045).
- Gate A I-1 is closed: the area, category and new-draft text inputs carry no `name`.
