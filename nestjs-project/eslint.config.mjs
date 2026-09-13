// @ts-check
import eslint from '@eslint/js';
import eslintPluginJest from 'eslint-plugin-jest';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // Test files reference Jest-mocked class methods unbound (e.g.
    // `expect(mockedService.method).toHaveBeenCalledWith(...)`), which
    // @typescript-eslint/unbound-method cannot distinguish from a genuinely
    // unsafe `this`-losing reference. eslint-plugin-jest's version of the same
    // rule understands this pattern — swap it in for test files only, per
    // typescript-eslint's own documented recommendation.
    files: ['**/*.spec.ts', '**/*.integration-spec.ts', 'test/**/*.ts'],
    plugins: { jest: eslintPluginJest },
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      'jest/unbound-method': 'error',
    },
  },
);
