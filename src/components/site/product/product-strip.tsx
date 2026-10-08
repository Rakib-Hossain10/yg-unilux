// A horizontal strip of product cards ("More from Arc", "Related"): a native
// scroll-snap row that swipes on touch and scrolls with the keyboard through
// its links. Cards hold name, base model code and picture only (no specs).

import Image from "next/image";
import Link from "next/link";

import { ImagePlaceholder } from "./image-placeholder";

export interface StripCard {
  id: string;
  href: string;
  name: string;
  modelCode: string | null;
  image: { src: string; alt: string } | null;
}

export function ProductStrip({
  id,
  title,
  cards,
}: {
  /** Section id, also the heading id prefix. */
  id: string;
  title: string;
  cards: readonly StripCard[];
}) {
  if (cards.length === 0) return null;
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} data-section={id}>
      <h2
        id={headingId}
        className="mb-6 font-display text-3xl font-light md:text-4xl"
      >
        {title}
      </h2>
      <ul className="product-strip -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-4 md:mx-0 md:scroll-px-0 md:px-0">
        {cards.map((card) => (
          <li
            key={card.id}
            className="w-[68%] shrink-0 snap-start sm:w-[40%] md:w-64"
          >
            <Link href={card.href} className="group block">
              <div className="relative aspect-[4/5] overflow-hidden bg-grey-100">
                {card.image ? (
                  <Image
                    src={card.image.src}
                    alt={card.image.alt}
                    fill
                    sizes="(min-width: 768px) 16rem, (min-width: 640px) 40vw, 68vw"
                    className="object-contain transition-transform duration-(--duration-calm) ease-(--ease-calm) group-hover:scale-[1.03]"
                  />
                ) : (
                  <ImagePlaceholder name={card.name} size="small" />
                )}
              </div>
              <p className="mt-3 font-display text-xl leading-tight group-hover:underline group-hover:underline-offset-4">
                {card.name}
              </p>
              {card.modelCode ? (
                <p className="mt-1 text-sm text-grey-600 tabular-nums">
                  {card.modelCode}
                </p>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
