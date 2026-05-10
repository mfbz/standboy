import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "vendor/", "node_modules/", "**/*.test.ts"] },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  }
);
