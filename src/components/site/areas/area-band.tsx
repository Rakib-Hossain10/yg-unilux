// The head of an area page (Viabizzuno, plan "References"): the area's
// black-and-white photo as a full-bleed band with the name set large over
// its lower edge, the page's one <h1>. The photo is the original (not the
// 3:2 category crop) so `object-cover` can frame it at any band ratio:
// 4:3 on phones, 2:1 from sm, 12:5 from xl, never taller than 44rem. A
// gradient from ink keeps the white name at AA over any photo.
//
// Without a photo the band is solid ink with the name in paper: the same
// weight and place on the page, so a missing image reads as a choice.
// Server Component. Hooks for motion: data-slot="area-band",
// "area-band-media", "area-band-title".

import Image from "next/image";

const container = "mx-auto w-full max-w-(--container-site) px-4 md:px-8";

const titleClass =
  "font-display text-5xl leading-[1.02] font-light text-balance text-paper md:text-7xl xl:text-8xl";

export function AreaBand({
  title,
  image,
}: {
  title: string;
  /** Delivery URL of the area's black-and-white photo, or null. */
  image: string | null;
}) {
  if (!image) {
    return (
      <header data-slot="area-band" data-media="none" className="bg-ink">
        <div className={`${container} pt-16 pb-10 md:pt-28 md:pb-14`}>
          <h1 data-slot="area-band-title" className={titleClass}>
            {title}
          </h1>
        </div>
      </header>
    );
  }
  return (
    <header
      data-slot="area-band"
      data-media="photo"
      className="relative isolate overflow-hidden bg-ink"
    >
      <div
        data-slot="area-band-media"
        className="relative aspect-[4/3] max-h-[44rem] w-full sm:aspect-[2/1] xl:aspect-[12/5]"
      >
        <Image
          src={image}
          // Decorative: the area name is the heading set over it.
          alt=""
          fill
          sizes="100vw"
          preload
          className="object-cover grayscale"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-linear-to-t from-ink/75 via-ink/15 via-55% to-transparent"
        />
      </div>
      <div className="absolute inset-x-0 bottom-0">
        <div className={`${container} pb-6 md:pb-12`}>
          <h1 data-slot="area-band-title" className={titleClass}>
            {title}
          </h1>
        </div>
      </div>
    </header>
  );
}
