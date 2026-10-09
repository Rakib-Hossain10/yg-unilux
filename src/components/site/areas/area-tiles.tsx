// The /areas index tiles (Viabizzuno): each application area as a large
// black-and-white photo that takes its colour back on hover or keyboard
// focus, the name set under a hairline. Without a photo the tile shows the
// name large in a quiet grey field, so a missing image reads as a choice,
// not a gap. One column on phones; two from sm, where an odd count opens
// with one wide tile; from lg the tiles fill rows of 3 and 4 (tileRows), so
// seven areas read 3 + 4 and no row ends in a hole (ui-reviewer gate C,
// M-6). Server
// Component; the only motion is a CSS filter transition (off under reduced
// motion). Scroll and reveal motion belong to motion-engineer (L7): hook on
// data-slot="area-tiles" / "area-tile".

import Image from "next/image";
import Link from "next/link";

export interface AreaTileData {
  id: string;
  name: string;
  href: string;
  /** Delivery URL of the area's black-and-white photo, or null. */
  image: string | null;
}

/* Tiles above the fold on a phone (1 column) or a desktop row. */
const EAGER_TILES = 2;

/**
 * The tile count of each desktop row: as few rows of at most 4 as fit, the
 * tiles spread evenly with the shorter rows first (7 → [3, 4], 5 → [2, 3],
 * 6 → [3, 3], 9 → [3, 3, 3]). Every row is full, so the grid has no hole.
 */
export function tileRows(count: number): number[] {
  if (count <= 0) return [];
  const rows = Math.ceil(count / 4);
  const base = Math.floor(count / rows);
  const longer = count - base * rows;
  return Array.from({ length: rows }, (_, index) =>
    index < rows - longer ? base : base + 1,
  );
}

/* Desktop (lg, 12-column grid) span, frame ratio and image width per row
   length. Static strings so Tailwind sees every class. */
interface RowLayout {
  cell: string;
  frame: string;
  sizes: string;
}

const FOUR_UP: RowLayout = {
  cell: "lg:col-span-3",
  frame: "lg:aspect-[3/4]",
  sizes:
    "(min-width: 1440px) 21rem, (min-width: 1024px) 24vw, (min-width: 640px) 48vw, 100vw",
};

const ROW_LAYOUT: Record<number, RowLayout> = {
  1: {
    cell: "lg:col-span-12",
    frame: "lg:aspect-[12/5]",
    sizes: "(min-width: 1440px) 88rem, 100vw",
  },
  2: {
    cell: "lg:col-span-6",
    frame: "lg:aspect-[3/2]",
    sizes:
      "(min-width: 1440px) 44rem, (min-width: 1024px) 48vw, (min-width: 640px) 96vw, 100vw",
  },
  3: {
    cell: "lg:col-span-4",
    frame: "lg:aspect-[4/5]",
    sizes:
      "(min-width: 1440px) 29rem, (min-width: 1024px) 32vw, (min-width: 640px) 48vw, 100vw",
  },
  4: FOUR_UP,
};

export function AreaTiles({ areas }: { areas: readonly AreaTileData[] }) {
  // Row length of each tile, in order.
  const rowOf = tileRows(areas.length).flatMap((length) =>
    Array.from({ length }, () => length),
  );
  // At sm (2 columns) an odd count opens with one wide tile.
  const wideFirst = areas.length % 2 === 1 && areas.length > 1;
  return (
    <ul
      data-slot="area-tiles"
      className="grid gap-x-4 gap-y-10 sm:grid-cols-2 md:gap-x-6 md:gap-y-14 lg:grid-cols-12"
    >
      {areas.map((area, index) => {
        const layout = ROW_LAYOUT[rowOf[index] ?? 4] ?? FOUR_UP;
        const wide = wideFirst && index === 0;
        return (
          <li
            key={area.id}
            data-slot="area-tile"
            className={`${wide ? "sm:col-span-2" : ""} ${layout.cell}`}
          >
            <Link
              href={area.href}
              className="group block outline-offset-4"
              data-area-tile={area.id}
            >
              <div
                className={`relative aspect-[4/3] overflow-hidden bg-grey-100 ${wide ? "sm:aspect-[2/1]" : "sm:aspect-[3/4]"} ${layout.frame}`}
              >
                {area.image ? (
                  <Image
                    src={area.image}
                    // Decorative: the area name is the link's text.
                    alt=""
                    fill
                    sizes={
                      wide
                        ? layout.sizes.replace(
                            "(min-width: 640px) 48vw",
                            "(min-width: 640px) 96vw",
                          )
                        : layout.sizes
                    }
                    loading={index < EAGER_TILES ? "eager" : "lazy"}
                    className="object-cover grayscale transition-[filter] duration-(--duration-calm) ease-(--ease-calm) group-hover:grayscale-0 group-focus-visible:grayscale-0 motion-reduce:transition-none"
                  />
                ) : (
                  // Large text: grey-500 on grey-100 keeps 3:1 (axe checks it
                  // even though it is aria-hidden).
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-5 bottom-4 font-display text-5xl leading-none font-light text-grey-500 md:text-6xl"
                  >
                    {area.name}
                  </span>
                )}
              </div>
              <h2 className="mt-4 border-t border-ink pt-3 font-display text-2xl font-light md:text-3xl">
                <span className="decoration-1 underline-offset-[6px] group-hover:underline group-focus-visible:underline">
                  {area.name}
                </span>
              </h2>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
