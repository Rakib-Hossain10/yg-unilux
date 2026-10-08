// "Applications": the areas this product is made for, as small linked tiles
// with the area's black-and-white image (Viabizzuno reference) or a neutral
// field. Swipe row on mobile, a grid from md. Server Component.

import Image from "next/image";
import Link from "next/link";

export interface AreaTile {
  id: string;
  name: string;
  href: string;
  image: string | null;
}

export function ApplicationsRow({ areas }: { areas: readonly AreaTile[] }) {
  if (areas.length === 0) return null;
  return (
    <section aria-labelledby="applications-heading" data-section="applications">
      <h2
        id="applications-heading"
        className="mb-6 font-display text-3xl font-light md:text-4xl"
      >
        Applications
      </h2>
      <ul className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-4 md:mx-0 md:grid md:grid-cols-4 md:overflow-visible md:px-0 lg:grid-cols-7">
        {areas.map((area) => (
          <li key={area.id} className="w-[42%] shrink-0 snap-start md:w-auto">
            <Link href={area.href} className="group block">
              <div className="relative aspect-square overflow-hidden bg-grey-200">
                {area.image ? (
                  <Image
                    src={area.image}
                    alt=""
                    fill
                    sizes="(min-width: 1024px) 12rem, (min-width: 768px) 22vw, 42vw"
                    className="object-cover grayscale"
                  />
                ) : null}
              </div>
              <p className="mt-2 text-sm group-hover:underline group-hover:underline-offset-4">
                {area.name}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
