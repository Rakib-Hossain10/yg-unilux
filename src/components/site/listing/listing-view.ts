// Listing data → what the listing components render: card data with image
// URLs, the filter form's groups and selected tokens, the sort form's hidden
// fields. Server-side (the Cloudinary cloud name is read on the server).
// Nothing here can carry a spec value: cards come from ListingCardView and
// facets from ListingFacets (filter numbers of public columns only).

import "server-only";

import type { ListingFacets } from "@/lib/catalog/facets";
import {
  LISTING_SORTS,
  type ListingParams,
  type ListingSort,
} from "@/lib/catalog/listing-params";
import type { ListingCardView } from "@/lib/catalog/view";

import { cloudinaryImageUrl } from "../cloudinary-image";
import { LISTING_QUERY_ORDER } from "./form-query";
import type { FilterFormGroup } from "./filter-form";
import type { ListingCardData } from "./listing-card";
import type { SortOption } from "./sort-control";

/** Listing cards with delivery URLs (none without a cloud name). */
export function toListingCards(
  cards: readonly ListingCardView[],
  cloudName: string | null,
): ListingCardData[] {
  return cards.map((card) => {
    const src = card.image
      ? cloudinaryImageUrl(cloudName, card.image.publicId)
      : null;
    return {
      id: card.id,
      href: `/product/${card.slug}`,
      name: card.name,
      family: card.family,
      modelCode: card.modelCode,
      variantCount: card.variantCount,
      // The card's name follows as text: the alt stays empty unless the
      // admin wrote one (no repeated announcement), as on the strip cards.
      image:
        src && card.image
          ? { src, alt: card.image.alt?.trim() ?? "", kind: card.image.kind }
          : null,
    };
  });
}

/** The facet groups as the filter form needs them (plain data). */
export function toFilterGroups(facets: ListingFacets): FilterFormGroup[] {
  return facets.groups.map((group) => ({
    param: group.param,
    label: group.label,
    options: group.options.map((option) => ({
      value: option.value,
      label: option.label,
      count: option.count,
    })),
  }));
}

/** Every applied filter value as [param, value] pairs, canonical order. */
export function appliedFilterPairs(params: ListingParams): [string, string][] {
  return LISTING_QUERY_ORDER.flatMap((param) =>
    (params[param] as readonly (string | number)[]).map(
      (value): [string, string] => [param, String(value)],
    ),
  );
}

/** The selected tokens ("param=value") of the filter form. */
export function selectedTokens(params: ListingParams): string[] {
  return appliedFilterPairs(params).map(
    ([param, value]) => `${param}=${value}`,
  );
}

const SORT_LABELS: Readonly<Record<ListingSort, string>> = {
  catalog: "Catalog order",
  name: "Name A–Z",
  newest: "Newest",
};

/** The sort choices, in LISTING_SORTS order. */
export const SORT_OPTIONS: readonly SortOption[] = LISTING_SORTS.map(
  (value) => ({ value, label: SORT_LABELS[value] }),
);
