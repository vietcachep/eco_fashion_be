// @ts-check
import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/*
 * ESLint flat config — TypeScript strict + prettier.
 * Luật ranh giới module KHÔNG nằm ở đây mà ở `.dependency-cruiser.cjs` (npm run check:boundaries):
 * eslint chỉ nhìn từng file, không nhìn được đồ thị import giữa module.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'eslint.config.mjs', '.dependency-cruiser.cjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      // Logging Rule: không console.*, dùng pino qua nestjs-pino.
      'no-console': 'error',
    },
  },
  {
    files: ['scripts/**/*.ts', 'test/**/*.ts', '**/*.spec.ts'],
    rules: { 'no-console': 'off' },
  },
);
