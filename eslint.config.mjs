// @ts-check

import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'dist-selfhosted/', '*.js'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-namespace': 'warn',
    },
  },
  // The ad-hoc scripts. Nothing here declared Node globals, so every `process`
  // and `require` in scripts/ was a no-undef error — 47 of them, which is why
  // CI lints src/ rather than the whole repo (GRYT-268). None were real
  // defects; the config simply never described these files.
  {
    files: ['scripts/**'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // scripts/upload-route-test.cjs is CommonJS by extension and by intent.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
