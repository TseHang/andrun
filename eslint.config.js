import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["eval/fixtures/**", "eval/runs/**", "spike/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { regex: "^cloudflare:", message: "src/core must stay platform-free (ADR D1)." },
            { regex: "^@cloudflare/", message: "src/core must stay platform-free (ADR D1)." },
            { regex: "^node:", message: "src/core must stay platform-free (ADR D1)." },
          ],
        },
      ],
    },
  },
);
