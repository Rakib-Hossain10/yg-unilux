/** @type {import("lint-staged").Configuration} */
const config = {
  // Prettier respects .prettierignore; --ignore-unknown skips file types it cannot parse.
  "*": "prettier --write --ignore-unknown",
  // --no-warn-ignored: files excluded in eslint.config.mjs must not fail --max-warnings.
  "*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}":
    "eslint --max-warnings=0 --no-warn-ignored",
};

export default config;
