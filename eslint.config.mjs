import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Flat config has no `--ext`: the old `eslint ... --ext .ts` linted only
  // TypeScript sources, so JS fixtures under tests/ stay out of the file set.
  { ignores: ["dist/", "node_modules/", "**/*.js", "**/*.cjs", "**/*.mjs"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
