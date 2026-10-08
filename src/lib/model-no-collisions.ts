// Finds model nos. that the case-insensitive unique index (ADR 0055) would
// refuse: the same model no. ignoring case, twice in one product or on several
// products. Pure, so the check:model-nos script and the importer can share it.

import { modelNoKey } from "@/models/product-constants";

/** One product's identity and its variants' model nos., as stored. */
export interface ModelNoOwner {
  id: string;
  slug: string;
  modelNos: readonly string[];
}

/** One model no. owned more than once, with every owner in input order. */
export interface ModelNoCollision {
  /**
   * How many different products are involved. 1 = inside one product (fails
   * validation on save); more = the case-insensitive index can't be built.
   */
  productCount: number;
  owners: { id: string; slug: string; modelNo: string }[];
}

/**
 * Groups every model no. by modelNoKey and returns the groups with more than
 * one entry, sorted by key. Exact repeats count too. A group across several
 * products blocks the index build; a group inside one product does not (a
 * unique index never compares entries of one document) but fails the model's
 * validator on that product's next save. Only ids, slugs and model nos. are
 * returned, never specs.
 */
export function findModelNoCollisions(
  products: readonly ModelNoOwner[],
): ModelNoCollision[] {
  const groups = new Map<string, ModelNoCollision["owners"]>();
  for (const product of products) {
    for (const modelNo of product.modelNos) {
      const key = modelNoKey(modelNo);
      const owners = groups.get(key) ?? [];
      owners.push({ id: product.id, slug: product.slug, modelNo });
      groups.set(key, owners);
    }
  }
  return [...groups.entries()]
    .filter(([, owners]) => owners.length > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, owners]) => ({
      productCount: new Set(owners.map((owner) => owner.id)).size,
      owners,
    }));
}
