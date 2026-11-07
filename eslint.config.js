// Flat ESLint config: catches real bugs (undefined refs, unused imports,
// accidental globals) without style noise.
import js from '@eslint/js';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', performance: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        localStorage: 'readonly', AudioContext: 'readonly', webkitAudioContext: 'readonly',
        HTMLElement: 'readonly', HTMLCanvasElement: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        devicePixelRatio: 'readonly', navigator: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', ignoreRestSiblings: true }],
      'no-undef': 'error',
      'no-shadow': 'warn',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'warn',
    },
  },
  {
    files: ['tests/**/*.js', 'tools/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', window: 'readonly', document: 'readonly',
        globalThis: 'readonly', URL: 'readonly', global: 'writable',
      },
    },
    rules: { 'no-unused-vars': ['warn', { args: 'none' }], 'no-undef': 'error' },
  },
];
