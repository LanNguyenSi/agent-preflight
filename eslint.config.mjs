import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  // Only TypeScript sources are linted; the JS fixtures under tests/ are not.
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
      // ESLint 10 defaults checkLoops to allExceptWhileTrue; "all" keeps
      // constant loops such as while (true) reported
      "no-constant-condition": ["error", { checkLoops: "all" }],
    },
  },
]);
