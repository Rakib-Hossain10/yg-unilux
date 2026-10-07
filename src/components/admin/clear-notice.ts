// Drops a leftover `?notice=` (e.g. "Category created.") after an on-page
// write such as a move, so the old message doesn't stay on screen or come
// back on a reload (gate A, L-4). Used by client components only.

import { useRouter } from "next/navigation";

import { NOTICE_PARAM } from "./save-notice";

/**
 * The same URL without the notice param (path, other params and hash kept),
 * or null when there was no notice to remove. Pure, for the tests.
 */
export function urlWithoutNotice(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has(NOTICE_PARAM)) return null;
  url.searchParams.delete(NOTICE_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Returns a function to call once an on-page write has SETTLED. It replaces
 * the URL with the notice-free one, which re-renders the list without the
 * notice (one request, and only when a notice was there).
 *
 * Not before the write: Next's router discards a pending Server Action's
 * result when a navigation or history.replaceState restore is dispatched
 * while it runs (dispatchAction in next/dist/client/components/
 * app-router-instance.js), which lost a delete's redirect in e2e.
 */
export function useClearNotice(): () => void {
  const router = useRouter();
  return () => {
    const next = urlWithoutNotice(window.location.href);
    if (next !== null) router.replace(next, { scroll: false });
  };
}
