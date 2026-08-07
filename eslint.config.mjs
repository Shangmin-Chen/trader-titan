import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextVitals,
  ...nextTypescript,
  {
    // Globbed with a leading `**/` rather than anchored at the repo root:
    // build output also appears inside nested checkouts (for example the git
    // worktrees under `.claude/`), and a root-anchored `.next/**` does not
    // match those, so generated code was being linted as if it were source.
    ignores: [
      "**/.next/**",
      "**/.open-next/**",
      "**/.wrangler/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/dist/**",
      "**/playwright-report/**",
      "**/test-results/**",
      ".claude/**",
      "persephone/**"
    ]
  }
];

export default eslintConfig;
