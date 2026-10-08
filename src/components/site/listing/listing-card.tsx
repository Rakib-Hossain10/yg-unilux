// A listing card (plan Q6, ADR 0064 §23): the strip card's 4:5 frame
// (STRIP_CARD_FRAME) wrapped in the product's shared-element transition
// (`product-image-{id}`, the same name as the product page's stage), then
// family, name, base model code and "n models". It never holds a spec value:
// it is built from ListingCardView only. Server Component.

import Image from "next/image";
import Link from "next/link";

import { ProductImageTransition } from "@/components/motion/product/product-image-transition";
import type { ProductImageKind } from "@/models/product-constants";

import { frameFitClass } from "../product/gallery-images";
import { ImagePlaceholder } from "../product/image-placeholder";
import { STRIP_CARD_FRAME } from "../product/product-strip";

/** What a card shows. Built by toListingCard (listing-view.ts). */
export interface ListingCardData {
  id: string;
  href: string;
  name: string;
  family: string | null;
  modelCode: string | null;
  /** Model nos. of the product ("n models" from 2 on). */
  variantCount: number;
  image: { src: string; alt: string; kind: ProductImageKind } | null;
}

/** Grid columns: 2 from 360 px, 3 from md, 4 from xl (plan a11y rules). */
const CARD_SIZES =
  "(min-width: 1280px) 18vw, (min-width: 1024px) 24vw, (min-width: 768px) 30vw, 46vw";

export function ListingCard({
  card,
  eager = false,
}: {
  card: ListingCardData;
  /** One of the first cards: loaded at once (likely the LCP on mobile). */
  eager?: boolean;
}) {
  // The family eyebrow only when it adds something to the name.
  const family =
    card.family && card.family.toLowerCase() !== card.name.toLowerCase()
      ? card.family
      : null;
  return (
    <Link
      href={card.href}
      className="group block focus-visible:outline-offset-4"
      data-product-card={card.id}
    >
      <ProductImageTransition productId={card.id}>
        <div
          className={`relative ${STRIP_CARD_FRAME} overflow-hidden bg-grey-100`}
        >
          {card.image ? (
            <Image
              src={card.image.src}
              alt={card.image.alt}
              fill
              sizes={CARD_SIZES}
              loading={eager ? "eager" : "lazy"}
              className={`${frameFitClass(card.image.kind)} transition-transform duration-(--duration-calm) ease-(--ease-calm) group-hover:scale-[1.03]`}
            />
          ) : (
            <ImagePlaceholder name={card.name} size="small" />
          )}
        </div>
      </ProductImageTransition>
      <div className="mt-3">
        {family ? (
          <p className="text-[0.8125rem] text-grey-600">
            <span className="sr-only">Family: </span>
            {family}
          </p>
        ) : null}
        <h3 className="font-display text-xl leading-tight text-ink group-hover:underline group-hover:decoration-1 group-hover:underline-offset-4 md:text-[1.375rem]">
          {card.name}
        </h3>
        {card.modelCode || card.variantCount >= 2 ? (
          <p className="mt-1 flex flex-wrap gap-x-3 text-sm text-grey-600">
            {card.modelCode ? (
              <span className="tracking-[0.02em] tabular-nums">
                {card.modelCode}
              </span>
            ) : null}
            {card.variantCount >= 2 ? (
              <span>{card.variantCount} models</span>
            ) : null}
          </p>
        ) : null}
      </div>
    </Link>
  );
}

/** The card grid. `eagerCount` first cards load at once. */
export function ListingGrid({
  cards,
  eagerCount = 2,
}: {
  cards: readonly ListingCardData[];
  eagerCount?: number;
}) {
  return (
    <ul
      data-slot="listing-grid"
      className="grid grid-cols-2 gap-x-4 gap-y-10 md:grid-cols-3 md:gap-x-6 md:gap-y-14 xl:grid-cols-4"
    >
      {cards.map((card, index) => (
        <li key={card.id}>
          <ListingCard card={card} eager={index < eagerCount} />
        </li>
      ))}
    </ul>
  );
}
