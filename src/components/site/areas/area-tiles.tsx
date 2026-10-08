// The /areas index tiles (Viabizzuno): each application area as a large
// black-and-white photo that takes its colour back on hover or keyboard
// focus, the name set under a hairline. Without a photo the tile shows the
// name large in a quiet grey field, so a missing image reads as a choice,
// not a gap. One column on phones, two from sm, four from lg. Server
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

/* Tiles above the fold on a phone (1 column) or a desktop row (4). */
const EAGER_TILES = 2;

export function AreaTiles({ areas }: { areas: readonly AreaTileData[] }) {
  return (
    <ul
      data-slot="area-tiles"
      className="grid gap-x-4 gap-y-10 sm:grid-cols-2 md:gap-x-6 md:gap-y-14 lg:grid-cols-4"
    >
      {areas.map((area, index) => (
        <li key={area.id} data-slot="area-tile">
          <Link
            href={area.href}
            className="group block outline-offset-4"
            data-area-tile={area.id}
          >
            <div className="relative aspect-[4/3] overflow-hidden bg-grey-100 sm:aspect-[3/4]">
              {area.image ? (
                <Image
                  src={area.image}
                  // Decorative: the area name is the link's text.
                  alt=""
                  fill
                  sizes="(min-width: 1440px) 21rem, (min-width: 1024px) 24vw, (min-width: 640px) 48vw, 100vw"
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
      ))}
    </ul>
  );
}
