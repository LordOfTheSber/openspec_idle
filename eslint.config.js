import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'docs/mockups/**',
      'tests/fixtures/**',
      '**/*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'packages/*/scripts/**/*.mjs', 'packages/cli/bin/*.js', 'tests/agent/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
      },
    },
  },
  {
    files: ['packages/cli/**/*.ts', 'scripts/**/*.mjs', 'packages/*/scripts/**/*.mjs', 'packages/cli/bin/*.js', 'tests/agent/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { 'no-console': 'off' },
  },
);
