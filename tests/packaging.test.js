// Deployment packaging checks.
//
// We cannot build a Windows installer in CI-less sandboxes (the Electron binary
// and NSIS tooling are downloaded at build time), so the packaging itself is
// verified structurally: the config must parse, must reference files that
// actually exist, must ship only what the game needs, and must keep the
// renderer locked down. A typo here would otherwise only surface when a user
// runs the installer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => existsSync(path.join(ROOT, p));

test('electron-builder config parses and ships only what the game needs', () => {
  const cfg = yaml.load(read('electron-builder.yml'));

  assert.equal(cfg.appId, 'com.hbk.sifirnokta');
  assert.equal(cfg.extraMetadata.main, 'app/main.cjs');
  assert.ok(exists(cfg.extraMetadata.main), 'main entry must exist');

  // Shipping node_modules would put hundreds of MB of dev tooling into a
  // 640 KB game; the allow-list must stay tight.
  assert.ok(Array.isArray(cfg.files));
  assert.ok(
    !cfg.files.some((f) => f === '**/*' || f === 'node_modules/**/*'),
    'files must not blanket-include the whole project',
  );
  assert.ok(cfg.files.includes('dist/SifirNokta.html'), 'the offline build must be bundled');

  // Windows is the primary target and both artifacts are expected.
  const winTargets = cfg.win.target.map((t) => t.target);
  assert.deepEqual(winTargets, ['nsis', 'portable']);
  assert.ok(exists(cfg.win.icon), `win icon missing: ${cfg.win.icon}`);

  assert.equal(cfg.nsis.oneClick, false, 'installer must let the user choose a folder');
  assert.equal(cfg.nsis.createDesktopShortcut, 'always');
  assert.equal(cfg.asar, true);
});

test('the packaged app points at a build that exists and is not stale', () => {
  assert.ok(exists('dist/SifirNokta.html'), 'run `npm run build` before packaging');
  const size = statSync(path.join(ROOT, 'dist/SifirNokta.html')).size;
  assert.ok(size > 300 * 1024, `build looks truncated (${size} bytes)`);

  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.main, 'app/main.cjs');
  assert.equal(pkg.scripts['app:dist'].includes('electron-builder --win'), true);
  // The build must run before packaging, or the installer ships an old game.
  assert.ok(pkg.scripts['app:dist'].startsWith('npm run build'));
});

test('the desktop shell keeps the renderer locked down', () => {
  const main = read('app/main.cjs');
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /backgroundThrottling:\s*false/, 'a backgrounded window must not slow the loop');
  // External links must never replace the game window.
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /will-navigate/);

  // The bridge is deliberately tiny: one capability, no generic IPC passthrough.
  const preload = read('app/preload.cjs');
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.ok(
    !/exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/.test(preload),
    'never expose ipcRenderer itself to the page',
  );
  assert.ok(!preload.includes('exposeInMainWorld(\'nodeFs'), 'no filesystem access for the renderer');
});

test('the in-game quit button closes the desktop window', () => {
  const main = read('src/main.js');
  assert.match(main, /SIFIR_NOKTA_DESKTOP/, 'quit must use the desktop bridge when present');
  const preload = read('app/preload.cjs');
  assert.match(preload, /quit:\s*\(\)\s*=>\s*ipcRenderer\.send\('app:quit'\)/);
  assert.match(read('app/main.cjs'), /ipcMain\.on\('app:quit'/);
});

test('site build produces an installable, self-contained folder', () => {
  const script = read('tools/build-site.mjs');
  for (const part of ['index.html', 'manifest.webmanifest', 'sw.js', 'icons', '_headers']) {
    assert.ok(script.includes(part), `site build must emit ${part}`);
  }
  // A separate JS file caches better than inlining everything into the HTML.
  assert.ok(script.includes('game.min.js'));

  const manifest = JSON.parse(read('src/pwa/manifest.webmanifest'));
  assert.equal(manifest.display, 'fullscreen');
  assert.equal(manifest.start_url, './', 'relative, so it works from any sub-path');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.icons.length >= 3, true, '192, 512 and a maskable variant are required');
  assert.ok(
    manifest.icons.some((i) => i.purpose === 'maskable'),
    'Android crops icons; a maskable one is required for a clean launcher icon',
  );
  for (const icon of manifest.icons) {
    assert.ok(exists(icon.src.replace('./', '')), `manifest points at a missing icon: ${icon.src}`);
  }

  const headers = read('tools/build-site.mjs');
  assert.ok(headers.includes("script-src 'self'"), 'CSP must not allow inline/remote scripts');
  assert.ok(!headers.includes("script-src 'self' 'unsafe-inline'"));
});

test('the service worker caches the game for offline start and cleans old versions', () => {
  const sw = read('src/pwa/sw.js');
  assert.match(sw, /const VERSION = '/, 'cache names must be versioned');
  assert.match(sw, /skipWaiting/, 'a new build should activate without a manual reload');
  assert.match(sw, /caches\.delete/, 'stale caches must be deleted, not accumulated');
  // addAll would fail the whole install if one URL 404s.
  assert.ok(!/cache\.addAll/.test(sw), 'precache must tolerate a single missing asset');
  assert.ok(sw.includes('SifirNokta.html'), 'the offline artifact should survive offline starts');
});

test('install support degrades quietly where it cannot work', () => {
  const pwa = read('src/ui/pwa.js');
  // file:// has no origin to install from; the offline single-file build must
  // keep working, so registration is skipped there.
  assert.match(pwa, /location\.protocol/, 'registration must be gated on http(s)');
  assert.match(pwa, /catch\(\(\) => null\)/, 'a service worker failure must never block boot');

  const main = read('src/main.js');
  assert.match(main, /registerServiceWorker/);
  assert.match(main, /createInstallControls/, 'main.js must wire the install button');
  // The button appears only when the browser actually offers an install prompt.
  assert.match(pwa, /button\.hidden = !available/);
  // The prompt listener must be captured at module load, not after the service
  // worker registers — otherwise the very first beforeinstallprompt is lost.
  assert.match(pwa, /^if \(hasWindow\) \{/m);
  assert.match(pwa, /window\.addEventListener\('beforeinstallprompt'/);
});
