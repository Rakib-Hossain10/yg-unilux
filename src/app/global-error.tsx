"use client";

// Last-resort error page, used when the root layout itself fails. It renders
// its own document without the global styles or fonts (Next docs: error.md),
// so it uses plain inline styles in the site's palette.

const page = {
  minHeight: "100vh",
  margin: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "16px",
  background: "#ffffff",
  color: "#111110",
  fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  textAlign: "center",
} as const;

const button = {
  marginTop: "24px",
  padding: "12px 24px",
  border: "1px solid #111110",
  background: "transparent",
  color: "#111110",
  font: "inherit",
  fontSize: "12px",
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  cursor: "pointer",
} as const;

export default function GlobalError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body style={page}>
        <title>Something went wrong | YG UniLUX</title>
        <main>
          <h1 style={{ fontWeight: 400, fontSize: "28px", margin: 0 }}>
            Something went wrong
          </h1>
          <p style={{ color: "#5e5850" }}>Please try again in a moment.</p>
          <button type="button" style={button} onClick={() => retry()}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
