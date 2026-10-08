// Public files of a product (installation guides, photometric files): plain
// links the admin entered. Only https links are rendered (the admin schema
// already requires it; this guards damaged data). Server Component.

import type { PublicFileView } from "@/lib/catalog/view";

function safeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" />
    </svg>
  );
}

export function Downloads({ files }: { files: readonly PublicFileView[] }) {
  const links = files.flatMap((file) => {
    const href = safeHttpsUrl(file.url);
    return href && file.label.trim() !== ""
      ? [{ label: file.label, href }]
      : [];
  });
  if (links.length === 0) return null;

  return (
    <section aria-labelledby="downloads-heading" data-section="downloads">
      <h2
        id="downloads-heading"
        className="mb-6 font-display text-3xl font-light md:text-4xl"
      >
        Downloads
      </h2>
      <ul className="grid gap-px border-y border-grey-200 bg-grey-200 sm:grid-cols-2">
        {links.map((link) => (
          <li key={link.href} className="bg-paper">
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-14 items-center justify-between gap-4 py-3 pr-4 text-sm transition-colors duration-(--duration-quick) hover:bg-grey-50"
            >
              <span>
                {link.label}
                <span className="sr-only"> (opens in a new tab)</span>
              </span>
              <DownloadIcon />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
