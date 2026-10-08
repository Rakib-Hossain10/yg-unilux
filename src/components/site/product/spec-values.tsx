// One spec value, or several options (CCT 3000K / 4000K, beam 20° / 40°) as
// a real list so screen readers announce "list, 2 items". Options sit on a
// flat grey-100 fill with no border, so they read as information rather than
// buttons (gate C, M-2); never colour-coded. Server Component.

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
      ? "bg-grey-100 px-1.5 py-0.5"
      : "bg-grey-100 px-2 py-0.5";
  return (
    <ul className="flex flex-wrap gap-1">
      {values.map((value) => (
        <li key={value} className={`${chip} leading-tight tabular-nums`}>
          {value}
        </li>
      ))}
    </ul>
  );
}
