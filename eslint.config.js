import js from '@eslint/js';
import globals from 'globals';
import unicorn from 'eslint-plugin-unicorn';
import tseslint from 'typescript-eslint';
import {defineConfig} from 'eslint/config';

export default defineConfig([
  {
    ignores: [
      '**/.env',
      '**/.env.*',
      '**/.git/**',
      '**/coverage/**',
      '**/dist/**',
      '**/dist-test/**',
      '**/node_modules/**',
      '**/worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['src/**/*.ts'],
  })),
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    languageOptions: {
      globals: globals.node,
    },
    extends: [unicorn.configs['flat/recommended']],
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'unicorn/import-style': [
        'error',
        {
          extendDefaultStyles: false,
          styles: {
            'node:path': {named: true},
          },
        },
      ],
      'unicorn/no-null': 'off',
      'unicorn/prevent-abbreviations': [
        'error',
        {
          allowList: {
            args: true,
            Db: true,
            Dir: true,
            dir: true,
            lib: true,
          },
        },
      ],
      'unicorn/prefer-module': 'warn',
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['src/*.test.ts', 'src/test-support/*.ts'],
          defaultProject: 'tsconfig.test.json',
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 32,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['src/**/*.test.ts'],
    // Test doubles intentionally implement Promise-returning interfaces with
    // immediate results and rethrow SDK-shaped values to exercise adapters.
    rules: {
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/matrix-client.ts'],
    rules: {
      'unicorn/no-await-expression-member': 'off',
    },
  },
]);
