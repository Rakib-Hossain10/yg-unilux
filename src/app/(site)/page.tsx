// Home page placeholder until the animated home page arrives in Phase 6.
// Rendered inside the (site) layout, so it gets the header and footer.

export default function HomePage() {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-24 text-center">
      <h1 className="font-display text-5xl font-light tracking-wide md:text-6xl">
        YG UniLUX
      </h1>
      <p className="text-sm tracking-[0.16em] text-grey-600 uppercase">
        Website under construction
      </p>
    </section>
  );
}
