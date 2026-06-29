import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextVitals,
  ...nextTypescript,
  {
    ignores: [
      ".next/**",
      ".open-next/**",
      ".wrangler/**",
      "node_modules/**",
      "coverage/**",
      "dist/**",
      "playwright-report/**",
      "test-results/**",
      "persephone/**"
    ]
  }
];

export default eslintConfig;
