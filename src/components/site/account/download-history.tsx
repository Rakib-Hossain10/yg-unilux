// The download history on /my-downloads: one row per download, newest first,
// with the product (a link while it is published), the file, the time and
// "Download again". A list, not a table: each row is one event and reads the
// same stacked on a phone and in columns on a desktop. Server Component.

import Link from "next/link";

import type {
  DownloadHistoryPage,
  DownloadHistoryRow,
} from "@/lib/download-history";

import { formatMoment } from "./access-status";
import { textLink } from "./account-ui";

const columns =
  "md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_9rem] md:items-baseline md:gap-6";

function datasheetHref(productId: string): string {
  return `/api/datasheet/${encodeURIComponent(productId)}`;
}

function ProductCell({ row }: { row: DownloadHistoryRow }) {
  const product = row.product;
  if (!product) {
    return <p className="text-grey-600">A product that has been removed</p>;
  }
  // The family only when it adds something to the name (as listing cards do).
  const family =
    product.family?.toLowerCase() === product.name.toLowerCase()
      ? null
      : product.family;
  const detail = [family, product.modelCode].filter(Boolean).join(", ");
  return (
    <div>
      {product.listed ? (
        <Link
          href={`/product/${encodeURIComponent(product.slug)}`}
          prefetch={false}
          className="font-display text-xl text-ink underline decoration-grey-300 underline-offset-4 transition-colors duration-(--duration-quick) hover:decoration-ink"
        >
          {product.name}
        </Link>
      ) : (
        <p className="font-display text-xl">
          {product.name}
          <span className="ml-2 font-sans text-sm text-grey-600">
            (no longer listed)
          </span>
        </p>
      )}
      {detail ? (
        <p className="mt-0.5 text-sm text-grey-600 tabular-nums">{detail}</p>
      ) : null}
    </div>
  );
}

function HistoryRow({
  row,
  canDownload,
}: {
  row: DownloadHistoryRow;
  canDownload: boolean;
}) {
  const again = canDownload && row.product?.downloadable ? row.product : null;
  return (
    <li className={`border-b border-grey-200 py-5 ${columns}`}>
      <ProductCell row={row} />
      <p className="mt-2 text-sm break-words md:mt-0">
        <span className="sr-only">File: </span>
        {row.fileName ?? (
          <span className="text-grey-600">File no longer available</span>
        )}
      </p>
      <p className="mt-1 text-sm text-grey-600 tabular-nums md:mt-0">
        <span className="sr-only">Downloaded </span>
        <time dateTime={row.downloadedAt.toISOString()}>
          {formatMoment(row.downloadedAt)}
        </time>
      </p>
      <div className="mt-1 md:mt-0 md:text-right">
        {again ? (
          // A plain <a>: the route answers with a redirect to a short-lived
          // file URL (rule 2), never something to prefetch.
          <a href={datasheetHref(again.id)} className={`${textLink} text-sm`}>
            Download again<span className="sr-only">: {again.name}</span>
          </a>
        ) : null}
      </div>
    </li>
  );
}

function Pager({ page, pageCount }: { page: number; pageCount: number }) {
  if (pageCount <= 1) return null;
  const href = (n: number) =>
    n === 1 ? "/my-downloads" : `/my-downloads?page=${n}`;
  return (
    <nav
      aria-label="Download history pages"
      className="mt-8 flex items-center justify-between gap-4 text-sm"
    >
      {page > 1 ? (
        <Link href={href(page - 1)} prefetch={false} className={textLink}>
          Newer
        </Link>
      ) : (
        <span />
      )}
      <p className="text-grey-600 tabular-nums">
        Page {page} of {pageCount}
      </p>
      {page < pageCount ? (
        <Link href={href(page + 1)} prefetch={false} className={textLink}>
          Older
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

export function DownloadHistory({
  history,
  canDownload,
}: {
  history: DownloadHistoryPage;
  /** The viewer may download now (active customer or admin). */
  canDownload: boolean;
}) {
  const { rows, total, page, pageCount } = history;
  return (
    <section aria-labelledby="history-heading" className="mt-12 md:mt-16">
      <div className="flex items-baseline justify-between gap-4">
        <h2
          id="history-heading"
          className="font-display text-2xl font-light md:text-3xl"
        >
          Download history
        </h2>
        {total > 0 ? (
          <p className="text-sm text-grey-600 tabular-nums">
            {total === 1 ? "1 download" : `${total} downloads`}
          </p>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="mt-6 border-t border-grey-200 pt-8">
          <p className="max-w-prose text-grey-600">
            No downloads yet. Datasheets you download from product pages will be
            listed here.
          </p>
          <p className="mt-2">
            <Link href="/products" prefetch={false} className={textLink}>
              Browse products
            </Link>
          </p>
        </div>
      ) : (
        <>
          <div
            aria-hidden="true"
            className={`mt-6 hidden border-b border-ink pb-3 text-xs tracking-[0.14em] text-grey-600 uppercase md:grid ${columns}`}
          >
            <span>Product</span>
            <span>File</span>
            <span>Downloaded</span>
            <span />
          </div>
          <ol className="max-md:mt-4 max-md:border-t max-md:border-grey-200">
            {rows.map((row) => (
              <HistoryRow key={row.id} row={row} canDownload={canDownload} />
            ))}
          </ol>
          <Pager page={page} pageCount={pageCount} />
        </>
      )}
    </section>
  );
}
