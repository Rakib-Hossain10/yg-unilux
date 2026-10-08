// The neutral stand-in when a product or area has no photo yet: a warm grey
// field with the name set in the display face. Never generated art (CLAUDE.md
// "Design": real client photos only). Fills its sized parent. Server Component.

export function ImagePlaceholder({
  name,
  size = "large",
}: {
  name: string;
  size?: "large" | "small";
}) {
  return (
    <div
      role="img"
      aria-label={`${name}: photo not yet available`}
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-grey-100 p-6 text-center"
    >
      <span
        aria-hidden="true"
        className={
          size === "large"
            ? "font-display text-3xl font-light text-grey-600 md:text-4xl"
            : "font-display text-xl font-light text-grey-600"
        }
      >
        {name}
      </span>
      {size === "large" ? (
        <span aria-hidden="true" className="text-xs text-grey-600">
          Photo to follow
        </span>
      ) : null}
    </div>
  );
}
