// The version of every catalog cache entry's shape (ADR 0063). It is the last
// keyParts item of every unstable_cache wrapper in this folder, so entries
// written by an older deploy are never read back with a different shape.
// Bump it on ANY change to a view type, a projection or what a reader puts
// into its entry.

export const CATALOG_CACHE_VERSION = "v4";
