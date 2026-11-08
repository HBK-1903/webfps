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
        location: 'readonly', URL: 'readonly', fetch: 'readonly',
        Response: 'readonly', Request: 'readonly', caches: 'readonly',
        matchMedia: 'readonly',
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
    // Tools that run code inside a browser page. `page.evaluate()` bodies are
    // serialised and executed in Chromium, so they may use DOM globals even
    // though the file itself is Node.
    files: ['tools/visual.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', console: 'readonly',
        requestAnimationFrame: 'readonly', MouseEvent: 'readonly',
        createImageBitmap: 'readonly', OffscreenCanvas: 'readonly',
        performance: 'readonly', globalThis: 'readonly',
      },
    },
  },
  {
    // Service worker: runs in its own global scope — `self` instead of `window`,
    // and no DOM at all. Declared separately so the errors that matter (a typo
    // in cache names, an undefined helper) are still caught.
    files: ['src/pwa/sw.js', 'src/pwa/**/*.sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        self: 'readonly', caches: 'readonly', fetch: 'readonly',
        Response: 'readonly', Request: 'readonly', URL: 'readonly',
        console: 'readonly', Promise: 'readonly',
      },
    },
    rules: { 'no-unused-vars': ['error', { args: 'after-used' }], 'no-undef': 'error' },
  },
  {
    // Electron main + preload run in Node, not the browser.
    files: ['app/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        __dirname: 'readonly', process: 'readonly', console: 'readonly',
        Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        window: 'readonly',
      },
    },
    rules: { 'no-unused-vars': ['error', { args: 'after-used' }], 'no-undef': 'error' },
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
