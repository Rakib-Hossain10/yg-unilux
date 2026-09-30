/** @type {import("prettier").Config} */
const config = {
  plugins: ["prettier-plugin-tailwindcss"],
  // Tailwind v4: point the plugin at the CSS entry that imports Tailwind.
  tailwindStylesheet: "./src/app/globals.css",
};

export default config;
