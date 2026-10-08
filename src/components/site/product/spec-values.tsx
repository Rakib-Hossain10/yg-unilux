// One spec value, or several options (CCT 3000K / 4000K, beam 20° / 40°) as
// a real list so screen readers announce "list, 2 items". Chips are outlined
// text, never colour-coded. Server Component.

export function SpecValues({
  values,
  size = "default",
}: {
  values: readonly string[];
  /** "compact" for dense tables. */
  size?: "default" | "compact";
}) {
  if (values.length === 1) return <span>{values[0]}</span>;
  const chip =
    size === "compact"
      ? "border border-grey-300 px-2 py-0.5"
      : "border border-grey-300 px-2.5 py-1";
  return (
    <ul className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <li key={value} className={`${chip} leading-tight tabular-nums`}>
          {value}
        </li>
      ))}
    </ul>
  );
}
